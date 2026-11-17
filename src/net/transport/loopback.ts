/**
 * The in-process loopback: two connected transports whose frames are delivered through the scheduler (never
 * synchronously inside `send`, so a sender is never re-entered by its own frame), in order, copied. Used by
 * the session tests, by the transcripts, and by anything that runs a client and a server in one process.
 */
import type { Scheduler } from '../time/scheduler';
import type { CloseInfo, Transport, TransportHandler, TransportState } from './types';

class LoopbackEnd implements Transport {
  readonly kind = 'loopback';
  state: TransportState = 'open';
  peer: LoopbackEnd | null = null;
  private handler: TransportHandler | null = null;
  /** Bytes sent by this end and not yet delivered to the peer. */
  bufferedAmount = 0;

  constructor(private readonly scheduler: Scheduler) {}

  setHandler(handler: TransportHandler): void {
    this.handler = handler;
  }

  send(frame: Uint8Array): void {
    if (this.state !== 'open' || !this.peer) return;
    const copy = frame.slice();
    const peer = this.peer;
    this.bufferedAmount += copy.length;
    this.scheduler.setTimer(0, () => {
      this.bufferedAmount -= copy.length;
      if (peer.state === 'open') peer.handler?.frame(copy);
    });
  }

  close(code = 1000, reason = ''): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const info: CloseInfo = { code, reason, clean: true };
    const peer = this.peer;
    // Frames already sent are delivered first (they were queued before the close).
    this.scheduler.setTimer(0, () => {
      this.handler?.close(info);
      if (peer && peer.state !== 'closed') {
        peer.state = 'closed';
        peer.handler?.close(info);
      }
    });
  }

  /** Drop the connection as a network failure would: no close handshake, code 1006 on both ends. */
  fail(): void {
    if (this.state === 'closed') return;
    this.state = 'closed';
    const info: CloseInfo = { code: 1006, reason: 'connection lost', clean: false };
    const peer = this.peer;
    if (peer) peer.state = 'closed';
    this.scheduler.setTimer(0, () => {
      this.handler?.close(info);
      peer?.handler?.close(info);
    });
  }
}

export type LoopbackTransport = LoopbackEnd;

/** Two connected loopback transports: what one sends, the other receives. */
export function createLoopbackPair(scheduler: Scheduler): [LoopbackTransport, LoopbackTransport] {
  const a = new LoopbackEnd(scheduler);
  const b = new LoopbackEnd(scheduler);
  a.peer = b;
  b.peer = a;
  return [a, b];
}
