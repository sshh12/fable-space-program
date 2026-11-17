/**
 * Back-pressure-aware sending (ARCHITECTURE 13.1): messages are queued as encoded records and handed to the
 * transport in frames when its buffered amount is below a high-water mark. A 'latest' message (a key, a
 * delta, the near tier, an input) replaces a queued message with the same supersede key, so a slow socket
 * receives the newest state instead of a growing backlog; a 'reliable' message is never dropped and keeps its
 * order. Handles that a message needs are queued before it, as reliable records.
 */
import type { WireMessage } from '@/core/contracts/net';
import { WIRE_CONSTANTS } from '@/core/contracts/net';
import { encodeMessage } from '../codec/framing';
import type { HandleTableOut } from '../codec/handles';
import { specOf, supersedeKey } from '../codec/messages';
import { varUintSize } from '../codec/bytes';
import type { Transport } from './types';

export interface SenderOptions {
  /** Nothing new goes to the transport while more than this is buffered, bytes (default 64 KiB). */
  highWaterBytes?: number;
  /** Largest frame assembled, bytes (default `WIRE_CONSTANTS.maxFrameBytes`). */
  maxFrameBytes?: number;
}

interface Queued {
  record: Uint8Array;
  key: string | null;
}

export interface SenderStats {
  frames: number;
  bytes: number;
  messages: number;
  /** 'latest' records dropped because a newer one with the same key replaced them. */
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
  private readonly highWater: number;
  private readonly maxFrame: number;
  readonly stats: SenderStats = { frames: 0, bytes: 0, messages: 0, superseded: 0, heldBack: 0 };

  constructor(
    private readonly transport: Transport,
    opts: SenderOptions = {},
  ) {
    this.highWater = opts.highWaterBytes ?? 64 * 1024;
    this.maxFrame = opts.maxFrameBytes ?? WIRE_CONSTANTS.maxFrameBytes;
  }

  /** Queue a message (encoded now, against `table` for its handles). */
  push(m: WireMessage, table: HandleTableOut | null = null): void {
    const { records, key } = recordsOf(m, table);
    for (let i = 0; i < records.length; i++) this.pushRecord(records[i]!, i === records.length - 1 ? key : null);
  }

  /** Queue an encoded record; a non-null key supersedes a queued record with the same key. */
  pushRecord(record: Uint8Array, key: string | null): void {
    if (key !== null) {
      const i = this.queue.findIndex((q) => q.key === key);
      if (i >= 0) {
        this.queue.splice(i, 1);
        this.stats.superseded++;
      }
    }
    this.queue.push({ record, key });
  }

  get queuedCount(): number {
    return this.queue.length;
  }

  get queuedBytes(): number {
    let n = 0;
    for (const q of this.queue) n += q.record.length;
    return n;
  }

  /** Hand the queue to the transport in frames, unless its buffer is above the high-water mark. Returns bytes sent. */
  flush(): number {
    if (this.transport.state !== 'open' || this.queue.length === 0) return 0;
    if (this.transport.bufferedAmount > this.highWater) {
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
    return sent;
  }

  /** Forget everything queued (the transport closed). */
  clear(): void {
    this.queue = [];
  }
}
