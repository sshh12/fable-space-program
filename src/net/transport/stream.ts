/**
 * The length-prefixed byte stream of role-to-role links (ARCHITECTURE 16.1: "a length-prefixed TCP stream on
 * Railway's private network, batched per control tick"): every frame is a u32 little-endian length followed
 * by the frame. Works over anything shaped like a Node `net.Socket` (structurally typed: src/net imports no
 * Node module). A declared length above the limit closes the link (1009); the stream's own write buffer is
 * the transport's buffered amount.
 */
import { WIRE_CONSTANTS } from '@/core/contracts/net';
import type { CloseInfo, Transport, TransportHandler, TransportState } from './types';
import { CLOSE } from './types';

/** A duplex byte stream as far as the transport uses it (a Node `net.Socket` fits). */
export interface ByteStreamLike {
  write(chunk: Uint8Array): boolean;
  readonly writableLength: number;
  end(): void;
  destroy(): void;
  on(event: 'data', listener: (chunk: Uint8Array) => void): unknown;
  on(event: 'close', listener: (hadError: boolean) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

/** Splits a byte stream into length-prefixed frames. */
export class FrameAssembler {
  private buf = new Uint8Array(4096);
  private len = 0;

  constructor(private readonly maxFrameBytes: number) {}

  /** Add a chunk; calls `frame` for every complete frame. Returns false when a declared length is above the limit. */
  push(chunk: Uint8Array, frame: (bytes: Uint8Array) => void): boolean {
    if (this.len + chunk.length > this.buf.length) {
      let size = this.buf.length * 2;
      while (size < this.len + chunk.length) size *= 2;
      const next = new Uint8Array(size);
      next.set(this.buf.subarray(0, this.len));
      this.buf = next;
    }
    this.buf.set(chunk, this.len);
    this.len += chunk.length;
    let at = 0;
    while (this.len - at >= 4) {
      const n = (this.buf[at]! | (this.buf[at + 1]! << 8) | (this.buf[at + 2]! << 16)) + this.buf[at + 3]! * 16777216;
      if (n > this.maxFrameBytes) return false;
      if (this.len - at - 4 < n) break;
      frame(this.buf.slice(at + 4, at + 4 + n));
      at += 4 + n;
    }
    if (at > 0) {
      this.buf.copyWithin(0, at, this.len);
      this.len -= at;
    }
    return true;
  }
}

/** The 4-byte little-endian length prefix of a frame followed by the frame. */
export function lengthPrefixed(frame: Uint8Array): Uint8Array {
  const out = new Uint8Array(frame.length + 4);
  const n = frame.length;
  out[0] = n & 0xff;
  out[1] = (n >>> 8) & 0xff;
  out[2] = (n >>> 16) & 0xff;
  out[3] = (n >>> 24) & 0xff;
  out.set(frame, 4);
  return out;
}

class StreamTransport implements Transport {
  readonly kind = 'stream';
  private handler: TransportHandler | null = null;
  private st: TransportState = 'open';
  private readonly assembler: FrameAssembler;

  constructor(
    private readonly stream: ByteStreamLike,
    maxFrameBytes: number,
  ) {
    this.assembler = new FrameAssembler(maxFrameBytes);
    stream.on('data', (chunk) => {
      if (this.st === 'closed') return;
      if (!this.assembler.push(chunk, (f) => this.handler?.frame(f))) {
        this.finish({ code: CLOSE.tooBig, reason: 'frame above the size limit', clean: false });
        stream.destroy();
      }
    });
    stream.on('close', (hadError) => this.finish(hadError ? { code: CLOSE.abnormal, reason: 'stream error', clean: false } : { code: CLOSE.normal, reason: '', clean: true }));
    stream.on('error', () => undefined);
  }

  get state(): TransportState {
    return this.st;
  }

  get bufferedAmount(): number {
    return this.stream.writableLength;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(frame: Uint8Array): void {
    if (this.st !== 'open') return;
    this.stream.write(lengthPrefixed(frame));
  }

  close(): void {
    if (this.st !== 'open') return;
    this.st = 'closing';
    this.stream.end();
  }

  private finish(info: CloseInfo): void {
    if (this.st === 'closed') return;
    this.st = 'closed';
    this.handler?.close(info);
  }
}

/** A transport of length-prefixed frames over an open byte stream. */
export function streamTransport(stream: ByteStreamLike, maxFrameBytes: number = WIRE_CONSTANTS.maxFrameBytes): Transport {
  return new StreamTransport(stream, maxFrameBytes);
}
