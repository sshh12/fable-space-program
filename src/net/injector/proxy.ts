/**
 * The injector as a stand-alone proxy (ARCHITECTURE 28.4: "a proxy that injects delay, jitter and TCP-style
 * stalls per client"): a TCP-level pipe between an accepted client connection and its upstream connection,
 * each direction through a delay line. Working on bytes, it carries a WebSocket, a role link or anything else
 * unchanged. This module is the proxy's logic over structurally typed streams; the process that listens and
 * dials (Node `net`) is `tests/unit/net/proxy/latencyProxy.ts`, because src/net imports no Node module.
 *
 * A pipe is scriptable while it runs (profile changes, stalls, a drop), and one per client may get its own
 * profile (`profileFor`), as the bot fleet's latency mix needs (ARCHITECTURE 28.7).
 */
import type { Scheduler, TimerHandle } from '../time/scheduler';
import type { ByteStreamLike } from '../transport/stream';
import { DelayLine, type DirectionProfile, type InjectorProfile } from './model';

export interface PipeStats {
  /** Chunks and bytes carried client -> upstream (`up`) and back (`down`). */
  upChunks: number;
  upBytes: number;
  downChunks: number;
  downBytes: number;
  /** Chunks a stall held. */
  stalledChunks: number;
}

/** A running pipe: what a script can do to it. */
export interface InjectedPipe {
  readonly stats: PipeStats;
  setProfile(dir: 'up' | 'down' | 'both', p: Partial<DirectionProfile>): void;
  stall(dir: 'up' | 'down' | 'both', ms: number): void;
  /** Destroy both connections at once (a network failure: whatever is in flight is lost). */
  drop(): void;
  readonly closed: boolean;
}

/**
 * Pipe `client` <-> `upstream` through the profile's delay lines: bytes from the client travel `up`, bytes
 * from upstream travel `down`. When either side closes, the other is ended after the bytes in flight toward
 * it have arrived.
 */
export function pipeWithInjection(client: ByteStreamLike, upstream: ByteStreamLike, profile: InjectorProfile, scheduler: Scheduler): InjectedPipe {
  const up = new DelayLine({ ...profile.up }, profile.seed * 2 + 1);
  const down = new DelayLine({ ...profile.down }, profile.seed * 2 + 2);
  const stats: PipeStats = { upChunks: 0, upBytes: 0, downChunks: 0, downBytes: 0, stalledChunks: 0 };
  const timers = new Set<TimerHandle>();
  let closed = false;
  let lastUp = -Infinity;
  let lastDown = -Infinity;

  const after = (ms: number, fn: () => void): void => {
    const h = scheduler.setTimer(Math.max(0, ms), () => {
      timers.delete(h);
      fn();
    });
    timers.add(h);
  };

  const carry = (line: DelayLine, to: ByteStreamLike, chunk: Uint8Array, isUp: boolean): void => {
    if (closed) return;
    const now = scheduler.now();
    const copy = chunk.slice();
    const u = line.schedule(copy.length, now);
    if (u.stalled) stats.stalledChunks++;
    if (isUp) {
      stats.upChunks++;
      stats.upBytes += copy.length;
      lastUp = u.arriveMs;
    } else {
      stats.downChunks++;
      stats.downBytes += copy.length;
      lastDown = u.arriveMs;
    }
    after(u.arriveMs - now, () => {
      if (!closed) to.write(copy);
    });
  };

  const endBoth = (): void => {
    if (closed) return;
    const now = scheduler.now();
    after(Math.max(lastUp, lastDown) - now, () => {
      if (closed) return;
      closed = true;
      client.end();
      upstream.end();
    });
  };

  client.on('data', (c) => carry(up, upstream, c, true));
  upstream.on('data', (c) => carry(down, client, c, false));
  client.on('close', endBoth);
  upstream.on('close', endBoth);
  client.on('error', () => undefined);
  upstream.on('error', () => undefined);

  return {
    stats,
    get closed() {
      return closed;
    },
    setProfile(dir, p) {
      if (dir !== 'down') Object.assign(up.profile, p);
      if (dir !== 'up') Object.assign(down.profile, p);
    },
    stall(dir, ms) {
      const now = scheduler.now();
      if (dir !== 'down') up.stall(now, ms);
      if (dir !== 'up') down.stall(now, ms);
    },
    drop() {
      if (closed) return;
      closed = true;
      for (const t of timers) scheduler.clearTimer(t);
      timers.clear();
      client.destroy();
      upstream.destroy();
    },
  };
}

/** Command-line form of a profile: `rtt=150,jitter=20,stall=0.05,stallMs=200,bw=0,seed=1` (bw 0 = no cap). */
export function parseProfile(spec: string): InjectorProfile {
  const kv = new Map<string, number>();
  for (const part of spec.split(',').map((s) => s.trim()).filter(Boolean)) {
    const [k, v] = part.split('=');
    const n = Number(v);
    if (!k || !Number.isFinite(n)) throw new Error(`profile: cannot read "${part}"`);
    kv.set(k, n);
  }
  const known = new Set(['rtt', 'jitter', 'stall', 'stallMs', 'bw', 'seed', 'up', 'down']);
  for (const k of kv.keys()) if (!known.has(k)) throw new Error(`profile: unknown key "${k}"`);
  const rtt = kv.get('rtt') ?? 0;
  const dir = (delay: number): DirectionProfile => ({
    delayMs: delay,
    jitterMs: kv.get('jitter') ?? 0,
    stallChance: kv.get('stall') ?? 0,
    stallMs: kv.get('stallMs') ?? 0,
    bytesPerSecond: kv.get('bw') ? kv.get('bw')! : null,
  });
  return { up: dir(kv.get('up') ?? rtt / 2), down: dir(kv.get('down') ?? rtt / 2), seed: kv.get('seed') ?? 1 };
}
