/**
 * The latency injector as a stand-alone proxy process (ARCHITECTURE 28.4: "a proxy that injects delay,
 * jitter and TCP-style stalls per client"). A TCP proxy: every accepted connection is piped to the target
 * through the injector's delay lines (src/net/injector/proxy.ts), so it carries a WebSocket or a role link
 * unchanged. Each connection gets the profile with its own seed (seed + connection index).
 *
 *   npx tsx tests/unit/net/proxy/latencyProxy.ts --listen 0 --target 127.0.0.1:8080 \
 *       --profile "rtt=150,jitter=20,stall=0.05,stallMs=200,seed=1" [--precise]
 *
 * Prints "listening <port>" when ready; stops on SIGINT, SIGTERM or the end of stdin. It lives here because
 * src/net may not import Node networking and tools/net belongs to later packages (net-joint-gate,
 * acceptance-multiclient): moving this file there is a copy, nothing in it depends on its place.
 */
import { createConnection, createServer, type Socket } from 'node:net';
import { parseProfile, pipeWithInjection } from '@/net/injector/proxy';
import { RealScheduler } from '@/net/time/scheduler';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const listen = Number(arg('listen') ?? '0');
const target = arg('target');
const profileSpec = arg('profile') ?? 'rtt=0';
if (!target || !/^[^:]+:\d+$/.test(target)) {
  console.error('usage: latencyProxy --listen <port> --target <host:port> [--profile "rtt=150,jitter=20,stall=0.05,stallMs=200,bw=0,seed=1"]');
  process.exit(2);
}
const [host, portText] = target.split(':') as [string, string];
const base = parseProfile(profileSpec);
// --precise: deliveries to the millisecond (a busy event loop just before each; see RealScheduler).
const scheduler = new RealScheduler({ precise: process.argv.includes('--precise') });
const sockets = new Set<Socket>();
let index = 0;

const server = createServer((client) => {
  const conn = index++;
  client.setNoDelay(true);
  const upstream = createConnection({ host, port: Number(portText) }, () => upstream.setNoDelay(true));
  for (const s of [client, upstream]) {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  }
  pipeWithInjection(client, upstream, { ...base, seed: base.seed + conn }, scheduler);
});

server.listen(listen, '127.0.0.1', () => {
  const a = server.address();
  console.log(`listening ${typeof a === 'object' && a ? a.port : listen}`);
});

const stop = (): void => {
  scheduler.clearAll();
  for (const s of sockets) s.destroy();
  server.close(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
process.stdin.on('end', stop);
process.stdin.resume();
