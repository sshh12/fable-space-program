/**
 * One interface for every transport of the wire (ARCHITECTURE 13.1, 16.1): the browser WebSocket, the Node
 * `ws` socket of a gateway, the in-process loopback, and the length-prefixed byte stream of role-to-role
 * links. A transport moves FRAMES (whole byte strings, src/net/codec/framing.ts) in order and loses none
 * while it is open; it does not decode them.
 */

export type TransportState = 'connecting' | 'open' | 'closing' | 'closed';

export interface CloseInfo {
  /** WebSocket close code (1000 normal, 1001 going away, 1006 abnormal, 1009 too big, 4000+ the protocol's own). */
  code: number;
  reason: string;
  /** True when both sides closed in order. */
  clean: boolean;
}

export interface TransportHandler {
  /** The transport became open (not called when it was created open). */
  open?(): void;
  /** One whole frame arrived. The bytes belong to the handler. */
  frame(bytes: Uint8Array): void;
  /** The transport closed; nothing arrives or leaves afterwards. */
  close(info: CloseInfo): void;
}

export interface Transport {
  /** What carries it, for logs: 'websocket', 'ws', 'loopback', 'stream', 'injected(...)'. */
  readonly kind: string;
  readonly state: TransportState;
  /** Bytes handed to `send` that have not left yet (the socket's buffered amount), for back-pressure. */
  readonly bufferedAmount: number;
  /** Set the one handler (replaces any previous one). */
  setHandler(handler: TransportHandler): void;
  /** Send one frame. The transport copies it or takes a copy before returning, so the caller may reuse its buffer. */
  send(frame: Uint8Array): void;
  close(code?: number, reason?: string): void;
}

/** Close codes of the protocol (4000-4999 is the application range of RFC 6455). */
export const CLOSE = {
  normal: 1000,
  goingAway: 1001,
  protocolError: 1002,
  unsupported: 1003,
  abnormal: 1006,
  tooBig: 1009,
  /** The session was refused or ended by the protocol (the `refused` / `bye` message says why). */
  refused: 4000,
  /** No frame arrived for `disconnect.lossTimeout` (declared loss, ARCHITECTURE U16). */
  lost: 4001,
  takenOver: 4002,
  /** The gateway's outgoing queue passed its caps (a peer that does not read). */
  slowConsumer: 4003,
  /** An error inside the server's own code for this socket (the process goes on). */
  internalError: 1011,
} as const;
