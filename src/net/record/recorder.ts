/**
 * Recorder and replayer of message streams (the brief: fixtures for the UI packages and for bots).
 *
 * A recording is a list of frames with the time they passed, their direction and the connection they
 * belonged to (a session that reconnected has several). `recordingTransport` wraps any transport and logs
 * both directions; `encodeRecording` / `decodeRecording` store a recording as one binary file (`.fspw`);
 * `replayFrames` feeds a recording back on a scheduler at its own pace (or faster), so a HUD lab, a bot or a
 * test sees the same stream again.
 *
 * File layout: magic "FSPW", u16 version, varint frame count, then per frame: time f64 (ms from the start),
 * direction u8 (0 client to server, 1 server to client), connection varint, length varint, the frame. The
 * decoder never throws (typed errors, lengths checked before allocation).
 */
import { ByteReader, ByteWriter, type DecodeError } from '../codec/bytes';
import type { Scheduler } from '../time/scheduler';
import type { Transport, TransportHandler } from '../transport/types';

export type FrameDirection = 'c2s' | 's2c';

export interface RecordedFrame {
  atMs: number;
  dir: FrameDirection;
  /** Index of the connection (0 = the first). */
  conn: number;
  bytes: Uint8Array;
}

export const RECORDING_VERSION = 1;
const MAGIC = [0x46, 0x53, 0x50, 0x57];
const MAX_RECORDING_FRAME = 64 * 1024 * 1024;

/** Wrap a transport so every frame through it is reported: `out` for what this side sends, `in` for what it receives. */
export function recordingTransport(inner: Transport, log: (direction: 'out' | 'in', bytes: Uint8Array) => void): Transport {
  let handler: TransportHandler | null = null;
  inner.setHandler({
    open: () => handler?.open?.(),
    frame: (bytes) => {
      log('in', bytes.slice());
      handler?.frame(bytes);
    },
    close: (info) => handler?.close(info),
  });
  return {
    kind: `recorded(${inner.kind})`,
    get state() {
      return inner.state;
    },
    get bufferedAmount() {
      return inner.bufferedAmount;
    },
    setHandler: (h) => {
      handler = h;
    },
    send: (frame) => {
      log('out', frame.slice());
      inner.send(frame);
    },
    close: (code, reason) => inner.close(code, reason),
  };
}

/** A recorder of one session: give it each connection's transport, from the client's side or the server's. */
export class StreamRecorder {
  readonly frames: RecordedFrame[] = [];
  private conn = -1;

  constructor(
    private readonly scheduler: Scheduler,
    /** Whose side the wrapped transports are on. */
    private readonly side: 'client' | 'server',
  ) {}

  /** Wrap the transport of a new connection. */
  wrap(t: Transport): Transport {
    const conn = ++this.conn;
    const t0 = this.scheduler;
    return recordingTransport(t, (d, bytes) => {
      const dir: FrameDirection = (d === 'out') === (this.side === 'client') ? 'c2s' : 's2c';
      this.frames.push({ atMs: t0.now(), dir, conn, bytes });
    });
  }
}

export function encodeRecording(frames: readonly RecordedFrame[]): Uint8Array {
  const w = new ByteWriter(1024);
  for (const b of MAGIC) w.u8(b);
  w.u16(RECORDING_VERSION);
  w.varUint(frames.length);
  for (const f of frames) {
    w.f64(f.atMs);
    w.u8(f.dir === 'c2s' ? 0 : 1);
    w.varUint(f.conn);
    w.blob(f.bytes);
  }
  return w.bytes().slice();
}

export function decodeRecording(bytes: Uint8Array): { ok: true; frames: RecordedFrame[] } | { ok: false; error: DecodeError } {
  const r = new ByteReader(bytes);
  r.where = 'recording';
  for (const b of MAGIC) if (r.u8() !== b && !r.failed) r.fail('badValue');
  const version = r.u16();
  if (!r.failed && version !== RECORDING_VERSION) r.fail('badValue');
  const n = r.count(11, 10_000_000);
  const frames: RecordedFrame[] = [];
  for (let i = 0; i < n && !r.failed; i++) {
    const atMs = r.finiteF64();
    const d = r.u8();
    if (d > 1) r.fail('badEnum');
    const conn = r.varUint();
    const b = r.blob(MAX_RECORDING_FRAME);
    frames.push({ atMs, dir: d === 0 ? 'c2s' : 's2c', conn, bytes: b });
  }
  if (!r.failed && r.remaining() !== 0) r.fail('trailing');
  const err = r.takeError();
  return err ? { ok: false, error: err } : { ok: true, frames };
}

/** Hex of bytes (for the JSON transcripts). */
export function toHex(b: Uint8Array): string {
  let s = '';
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, '0');
  return s;
}

export function fromHex(s: string): Uint8Array {
  if (s.length % 2 !== 0 || !/^[0-9a-f]*$/.test(s)) throw new Error('fromHex: not lower-case hex of whole bytes');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(2 * i, 2 * i + 2), 16);
  return out;
}

/**
 * Feed `frames` (of one direction, or filtered by the caller) to `deliver` on `scheduler`, keeping their
 * spacing divided by `speed` (2 = twice as fast), starting now. Returns a function that cancels what has not
 * been delivered.
 */
export function replayFrames(frames: readonly RecordedFrame[], scheduler: Scheduler, deliver: (f: RecordedFrame) => void, speed = 1): () => void {
  if (frames.length === 0) return () => undefined;
  const start = scheduler.now();
  const first = frames[0]!.atMs;
  const handles = frames.map((f) => scheduler.setTimer((f.atMs - first) / speed + (start - scheduler.now()), () => deliver(f)));
  return () => {
    for (const h of handles) scheduler.clearTimer(h);
  };
}
