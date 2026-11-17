/**
 * The wire layer's shared cases in Chrome: the same case modules vitest runs in Node (tests/unit/net/cases),
 * the fixtures recorded from the real session (fetched from the page's server), and the WHATWG WebSocket
 * transport against the RFC 6455 test server the spec starts (its port in `?ws=`). Results go to
 * `window.__netResults` for tests/browser/net/net.spec.ts.
 */
import { ALL_CASES } from '../../unit/net/cases';
import { checkFixture, FIXTURE_FILES } from '../../unit/net/cases/fixtureCases';
import { decodeFrame, encodeFrame } from '@/net/codec/framing';
import { connectWebSocket } from '@/net/transport/websocket';

interface CaseResult {
  name: string;
  ok: boolean;
  error: string | null;
  ms: number;
}

declare global {
  interface Window {
    __netResults?: { done: boolean; results: CaseResult[]; userAgent: string };
  }
}

async function run(name: string, fn: () => void | Promise<void>, results: CaseResult[]): Promise<void> {
  const t0 = performance.now();
  try {
    await fn();
    results.push({ name, ok: true, error: null, ms: performance.now() - t0 });
  } catch (e) {
    results.push({ name, ok: false, error: e instanceof Error ? `${e.name}: ${e.message}` : String(e), ms: performance.now() - t0 });
  }
}

async function websocketCase(port: number): Promise<void> {
  const t = connectWebSocket(`ws://127.0.0.1:${port}/`);
  await new Promise<void>((resolve, reject) => {
    t.setHandler({ open: () => resolve(), frame: () => undefined, close: (i) => reject(new Error(`closed ${i.code}`)) });
  });
  // The test server echoes binary frames back.
  const frame = encodeFrame([{ type: 'ping', seq: 42 }, { type: 'timeSync', seq: 1, clientMs: 12.5 }]);
  const echoed = new Promise<Uint8Array>((resolve) => t.setHandler({ frame: resolve, close: () => undefined }));
  t.send(frame);
  const back = await echoed;
  const res = decodeFrame(back, { source: 'client' });
  if (!res.ok || res.messages.length !== 2 || JSON.stringify(res.messages[0]) !== JSON.stringify({ type: 'ping', seq: 42 })) throw new Error('the echoed frame differs');
  t.close();
}

async function main(): Promise<void> {
  const results: CaseResult[] = [];
  for (const c of ALL_CASES) await run(c.name, () => c.run(), results);
  for (const file of FIXTURE_FILES) {
    await run(`fixture ${file}: every frame re-encodes identically, every message round-trips`, async () => {
      const res = await fetch(`/tests/unit/net/fixtures/${file}`);
      if (!res.ok) throw new Error(`fetch ${file}: ${res.status}`);
      const n = checkFixture(file, new Uint8Array(await res.arrayBuffer()));
      if (n < 100) throw new Error(`${file}: only ${n} messages`);
    }, results);
  }
  const port = Number(new URLSearchParams(location.search).get('ws'));
  if (port > 0) await run('the WHATWG WebSocket transport exchanges binary frames with an RFC 6455 server', () => websocketCase(port), results);
  window.__netResults = { done: true, results, userAgent: navigator.userAgent };
  const out = document.getElementById('out');
  if (out) out.textContent = results.map((r) => `${r.ok ? 'ok  ' : 'FAIL'} ${r.name}${r.error ? ` - ${r.error}` : ''}`).join('\n');
}

void main();
