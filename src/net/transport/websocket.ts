/**
 * WebSocket transports (ARCHITECTURE 13.1: one binary WebSocket per playing client).
 *
 *  - `webSocketTransport` wraps a socket with the WHATWG interface: the browser's WebSocket, Node's own
 *    global WebSocket (a bot), or anything shaped like it.
 *  - `nodeWsTransport` wraps a socket of the `ws` package on the gateway, structurally typed: src/net never
 *    imports `ws` (only server/ and bots/ may, tools/dev/boundaries.test.ts).
 *
 * Text frames are a protocol error (code 1003): the protocol is binary. Frames are copied on send, so a
 * caller may reuse its frame buffer at once.
 */
import { WIRE_CONSTANTS } from '@/core/contracts/net';
import type { CloseInfo, Transport, TransportHandler, TransportState } from './types';
import { CLOSE } from './types';

const STATES: TransportState[] = ['connecting', 'open', 'closing', 'closed'];

/** The event fields the transport reads (method-typed so a real WebSocket fits). */
interface SocketEventLike {
  data?: unknown;
  code?: number;
  reason?: string;
  wasClean?: boolean;
}

/** The WHATWG WebSocket as far as the transport uses it. */
export interface WebSocketLike {
  binaryType: string;
  readonly bufferedAmount: number;
  readonly readyState: number;
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: 'open' | 'message' | 'close' | 'error', listener: (ev: SocketEventLike) => void): void;
}

class WhatwgTransport implements Transport {
  readonly kind = 'websocket';
  private handler: TransportHandler | null = null;
  private closed = false;

  constructor(private readonly ws: WebSocketLike) {
    ws.binaryType = 'arraybuffer';
    ws.addEventListener('open', () => this.handler?.open?.());
    ws.addEventListener('message', (ev) => {
      if (this.closed) return;
      const d = ev.data;
      if (d instanceof ArrayBuffer) this.handler?.frame(new Uint8Array(d));
      else if (ArrayBuffer.isView(d)) this.handler?.frame(new Uint8Array(d.buffer, d.byteOffset, d.byteLength).slice());
      else this.close(CLOSE.unsupported, 'binary frames only');
    });
    ws.addEventListener('close', (ev) => this.finish({ code: ev.code ?? CLOSE.abnormal, reason: ev.reason ?? '', clean: ev.wasClean ?? false }));
  }

  get state(): TransportState {
    return this.closed ? 'closed' : (STATES[this.ws.readyState] ?? 'closed');
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(frame: Uint8Array): void {
    if (this.state !== 'open') return;
    this.ws.send(frame.slice());
  }

  close(code: number = CLOSE.normal, reason = ''): void {
    if (this.closed) return;
    try {
      this.ws.close(code, reason);
    } catch {
      // An invalid code for the WebSocket API (it accepts 1000 and 3000-4999): close normally instead.
      this.ws.close();
    }
  }

  private finish(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.handler?.close(info);
  }
}

/** A transport over a WHATWG WebSocket (open or still connecting). */
export function webSocketTransport(ws: WebSocketLike): Transport {
  return new WhatwgTransport(ws);
}

/** Open a WebSocket to `url` with the runtime's own WebSocket (browsers, workers, Node 22+). */
export function connectWebSocket(url: string): Transport {
  const Ctor = (globalThis as { WebSocket?: new (url: string) => WebSocketLike }).WebSocket;
  if (!Ctor) throw new Error('connectWebSocket: this runtime has no WebSocket');
  return webSocketTransport(new Ctor(url));
}

/**
 * The options a gateway gives the `ws` server (`new WebSocketServer({ ...WS_SERVER_OPTIONS, server })`): a
 * client frame larger than `maxClientFrameBytes` is refused by `ws` itself before it is buffered (close 1009),
 * and no per-message compression (a compression bomb costs nothing to send and the frames are small and
 * dense; the CPU is better spent elsewhere).
 */
export const WS_SERVER_OPTIONS = { maxPayload: WIRE_CONSTANTS.maxClientFrameBytes, perMessageDeflate: false } as const;

/** A socket of the `ws` package as far as the transport uses it. */
export interface WsSocketLike {
  readonly readyState: number;
  readonly bufferedAmount: number;
  binaryType: string;
  send(data: Uint8Array, options: { binary: boolean }): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  on(event: 'message', listener: (data: Uint8Array | ArrayBuffer | Uint8Array[], isBinary: boolean) => void): unknown;
  on(event: 'close', listener: (code: number, reason: Uint8Array) => void): unknown;
  on(event: 'error', listener: (err: Error) => void): unknown;
}

const reasonDecoder = new TextDecoder();

class WsTransport implements Transport {
  readonly kind = 'ws';
  private handler: TransportHandler | null = null;
  private closed = false;

  constructor(private readonly ws: WsSocketLike) {
    ws.binaryType = 'nodebuffer';
    ws.on('message', (data, isBinary) => {
      if (this.closed) return;
      if (!isBinary) {
        this.close(CLOSE.unsupported, 'binary frames only');
        return;
      }
      const bytes = Array.isArray(data) ? concat(data) : data instanceof ArrayBuffer ? new Uint8Array(data) : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
      this.handler?.frame(bytes);
    });
    ws.on('close', (code, reason) => this.finish({ code, reason: reasonDecoder.decode(reason), clean: code !== CLOSE.abnormal }));
    // An error is followed by 'close'; listening keeps it from being an unhandled 'error' event.
    ws.on('error', () => undefined);
  }

  get state(): TransportState {
    return this.closed ? 'closed' : (STATES[this.ws.readyState] ?? 'closed');
  }

  get bufferedAmount(): number {
    return this.ws.bufferedAmount;
  }

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(frame: Uint8Array): void {
    if (this.state !== 'open') return;
    this.ws.send(frame.slice(), { binary: true });
  }

  close(code: number = CLOSE.normal, reason = ''): void {
    if (this.closed) return;
    // A peer declared lost, or one that does not read, will not finish a close handshake: drop the socket.
    if (code === CLOSE.lost || code === CLOSE.slowConsumer) this.ws.terminate();
    else this.ws.close(code, reason);
  }

  private finish(info: CloseInfo): void {
    if (this.closed) return;
    this.closed = true;
    this.handler?.close(info);
  }
}

function concat(parts: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const p of parts) n += p.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

/** A transport over a server-side socket of the `ws` package. */
export function nodeWsTransport(ws: WsSocketLike): Transport {
  return new WsTransport(ws);
}
