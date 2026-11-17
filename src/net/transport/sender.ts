/**
 * Back-pressure-aware sending (ARCHITECTURE 13.1): messages are queued as encoded records and handed to the
 * transport in frames when its buffered amount is below a high-water mark. A 'latest' message (a key, a
 * delta, the near tier, a list-like view model) replaces a queued message with the same supersede key IN
 * PLACE (never moving behind what followed it), and a key removes the queued deltas it obsoletes; a
 * 'reliable' message is never dropped and keeps its order. Handles that a message needs are queued before it.
 * The queue is capped in bytes and in age (`overflowed`): over a cap the owner closes the socket.
 */
import type { WireMessage } from '@/core/contracts/net';
import { WIRE_CONSTANTS } from '@/core/contracts/net';
import { varUintSize } from '../codec/bytes';
import { encodeMessage } from '../codec/framing';
import type { HandleTableOut } from '../codec/handles';
import { specOf, supersedeKey } from '../codec/messages';
import type { Transport } from './types';

export interface SenderOptions {
  /** Nothing new goes to the transport while more than this is buffered, bytes (default 64 KiB). */
  highWaterBytes?: number;
  /** Largest frame assembled, bytes (default `WIRE_CONSTANTS.maxFrameBytes`). */
  maxFrameBytes?: number;
  /** Caps of the queue: bytes and the age of the oldest record, ms (default: none). */
  maxQueuedBytes?: number;
  maxQueueAgeMs?: number;
}

interface Queued {
  record: Uint8Array;
  key: string | null;
  at: number;
}

export interface SenderStats {
  frames: number;
  bytes: number;
  messages: number;
  /** 'latest' records dropped because a newer one with the same key replaced them (or a key obsoleted them). */
  superseded: number;
  /** Flushes skipped because the transport's buffer was above the high-water mark. */
  heldBack: number;
}

/** The records of a message, ready to queue: the handles it introduced (if any), then the message. */
export function recordsOf(m: WireMessage, table: HandleTableOut | null = null): { records: Uint8Array[]; key: string | null } {
  const record = encodeMessage(m, table);
  const handles = table?.takePending() ?? null;
  const key = specOf(m.type).delivery === 'latest' ? supersedeKey(m) : null;
  return { records: handles ? [encodeMessage(handles), record] : [record], key };
}

export class Sender {
  private queue: Queued[] = [];
  private bytesQueued = 0;
  private readonly highWater: number;
  private readonly maxFrame: number;
  private readonly maxBytes: number;
  private readonly maxAge: number;
  readonly stats: SenderStats = { frames: 0, bytes: 0, messages: 0, superseded: 0, heldBack: 0 };

  constructor(
    private readonly transport: Transport,
    opts: SenderOptions = {},
  ) {
    this.highWater = opts.highWaterBytes ?? 64 * 1024;
    this.maxFrame = opts.maxFrameBytes ?? WIRE_CONSTANTS.maxFrameBytes;
    this.maxBytes = opts.maxQueuedBytes ?? Infinity;
    this.maxAge = opts.maxQueueAgeMs ?? Infinity;
  }

  /** Queue a message (encoded now, against `table` for its handles). */
  push(m: WireMessage, table: HandleTableOut | null = null, nowMs = 0): void {
    const { records, key } = recordsOf(m, table);
    if (m.type === 'islandKey') this.drop(`islandDelta:${m.island}`);
    for (let i = 0; i < records.length; i++) this.pushRecord(records[i]!, i === records.length - 1 ? key : null, nowMs);
  }

  /** Queue an encoded record; a non-null key supersedes a queued record with the same key, in place. */
  pushRecord(record: Uint8Array, key: string | null, nowMs = 0): void {
    if (key !== null) {
      if (key.startsWith('islandKey:')) this.drop(`islandDelta:${key.slice('islandKey:'.length)}`);
      const i = this.queue.findIndex((q) => q.key === key);
      if (i >= 0) {
        this.bytesQueued += record.length - this.queue[i]!.record.length;
        this.queue[i] = { record, key, at: this.queue[i]!.at };
        this.stats.superseded++;
        return;
      }
    }
    this.queue.push({ record, key, at: nowMs });
    this.bytesQueued += record.length;
  }

  /** Drop queued records with `key`. */
  private drop(key: string): void {
    for (let i = this.queue.length - 1; i >= 0; i--) {
      if (this.queue[i]!.key === key) {
        this.bytesQueued -= this.queue[i]!.record.length;
        this.queue.splice(i, 1);
        this.stats.superseded++;
      }
    }
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get queuedBytes(): number {
    return this.bytesQueued;
  }

  /** True when the queue passed its byte or age cap (the owner closes the socket). */
  overflowed(nowMs: number): boolean {
    if (this.bytesQueued > this.maxBytes) return true;
    return this.queue.length > 0 && nowMs - this.queue[0]!.at > this.maxAge;
  }

  /**
   * Hand the queue to the transport in frames, unless its buffer is above the high-water mark (`force`: in
   * any case, for the last words before a close). Returns bytes sent.
   */
  flush(force = false): number {
    if (this.transport.state !== 'open' || this.queue.length === 0) return 0;
    if (!force && this.transport.bufferedAmount > this.highWater) {
      this.stats.heldBack++;
      return 0;
    }
    let sent = 0;
    let start = 0;
    while (start < this.queue.length) {
      let end = start;
      let size = 0;
      while (end < this.queue.length && (end === start || size + this.queue[end]!.record.length + 5 <= this.maxFrame)) {
        size += this.queue[end]!.record.length;
        end++;
      }
      const count = end - start;
      const frame = new Uint8Array(varUintSize(count) + size);
      let o = 0;
      let c = count;
      while (c >= 0x80) {
        frame[o++] = (c & 0x7f) | 0x80;
        c >>>= 7;
      }
      frame[o++] = c;
      for (let i = start; i < end; i++) {
        frame.set(this.queue[i]!.record, o);
        o += this.queue[i]!.record.length;
      }
      this.transport.send(frame);
      this.stats.frames++;
      this.stats.bytes += frame.length;
      this.stats.messages += count;
      sent += frame.length;
      start = end;
    }
    this.queue = [];
    this.bytesQueued = 0;
    return sent;
  }

  /** Forget everything queued (the transport closed). */
  clear(): void {
    this.queue = [];
    this.bytesQueued = 0;
  }
}
