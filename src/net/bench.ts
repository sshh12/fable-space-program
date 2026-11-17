/**
 * Benchmark of the wire codec (the brief's acceptance: encode at most 5 us and decode at most 5 us per
 * vessel for a delta, on this machine; run through the gate):
 *
 *   node tools/dev/heavy.mjs --class=cpu -- npx tsx src/net/bench.ts
 *
 * Each line times many messages after a warm-up and prints the median of seven trials, per message and per
 * vessel. "Delta encode" is the sender's whole work per send tick: quantising every vessel against the key
 * and writing the frame; "delta decode" the receiver's: decoding into the reusable frame and rebuilding every
 * pose from the key. The codec-only lines leave the quantisation out. Garbage collections during the timed
 * runs are counted where the runtime reports them (Node: 'gc' performance entries), as the allocation check.
 * Numbers taken while other heavy jobs run are provisional (PACKAGE_RULES 16).
 */
import type { DeltaPose, IslandDeltaMessage, IslandKeyMessage, WireMessage } from '@/core/contracts/net';
import { FrameReader, FrameWriter } from './codec/framing';
import { IslandDeltaFrame, islandDeltaCodec } from './codec/island';
import { dequantizePose, makePose, quantizePose, type IslandPose } from './codec/quant';
import { ByteReader } from './codec/bytes';
import { advance, deltaOf, keyOf, scenePoses } from './testing/scenes';

interface Line {
  name: string;
  perMessageUs: number;
  vessels: number;
  gcs: number;
}

let gcCount = 0;
function watchGc(): void {
  const PO = (globalThis as { PerformanceObserver?: typeof PerformanceObserver }).PerformanceObserver;
  if (!PO) return;
  try {
    new PO((list) => {
      gcCount += list.getEntries().length;
    }).observe({ entryTypes: ['gc'] });
  } catch {
    // The runtime has no 'gc' entries (a browser): collections are not counted there.
  }
}

/** Median time per call of `fn` over `trials` runs of `n` calls, in microseconds; and the collections seen. */
function time(fn: () => void, n: number, trials = 7): { us: number; gcs: number } {
  for (let i = 0; i < n; i++) fn();
  const runs: number[] = [];
  const before = gcCount;
  for (let t = 0; t < trials; t++) {
    const t0 = performance.now();
    for (let i = 0; i < n; i++) fn();
    runs.push(((performance.now() - t0) * 1000) / n);
  }
  runs.sort((a, b) => a - b);
  return { us: runs[Math.floor(runs.length / 2)]!, gcs: gcCount - before };
}

export async function runBench(log: (s: string) => void = console.log): Promise<Line[]> {
  watchGc();
  const lines: Line[] = [];
  const add = (name: string, vessels: number, r: { us: number; gcs: number }) => lines.push({ name, perMessageUs: r.us, vessels, gcs: r.gcs });

  for (const n of [2, 10]) {
    const poses = scenePoses(n, 11, 1000, 'docking');
    const key: IslandKeyMessage = keyOf(7, 1_000_000, poses, 'docking');
    const now: IslandPose[] = advance(poses, 60, 5, 'docking');
    const delta: IslandDeltaMessage = deltaOf(key, key.tick + 60, now, [1]);
    const fw = new FrameWriter();
    const poseScratch = delta.vessels.map((v) => v.pose!) as DeltaPose[];

    add(`islandDelta encode, ${n} vessels (quantise + write)`, n, time(() => {
      for (let i = 0; i < n; i++) quantizePose(key.vessels[i]!, 60, now[i]!, poseScratch[i]!);
      fw.begin();
      fw.add(delta);
    }, 20_000));
    add(`islandDelta encode, ${n} vessels (write only)`, n, time(() => {
      fw.begin();
      fw.add(delta);
    }, 20_000));

    fw.begin();
    fw.add(delta);
    const frame = fw.finish().slice();
    const reader = new FrameReader('server');
    const rebuilt = key.vessels.map(() => makePose());
    let ok = true;
    const visit = (m: WireMessage): void => {
      if (m.type !== 'islandDelta') return;
      for (let i = 0; i < m.vessels.length; i++) ok = dequantizePose(key.vessels[i]!, m.tick - m.keyTick, m.vessels[i]!.pose!, rebuilt[i]!) && ok;
    };
    add(`islandDelta decode, ${n} vessels (read + rebuild poses)`, n, time(() => {
      reader.read(frame, visit);
    }, 20_000));
    if (!ok) throw new Error('bench: a delta did not rebuild');
    const r = new ByteReader();
    const into = new IslandDeltaFrame();
    // The message payload starts after the frame header (count, code, length).
    const start = 1 + 1 + (frame.length - 3 > 127 ? 2 : 1);
    add(`islandDelta decode, ${n} vessels (read only)`, n, time(() => {
      r.reset(frame, start);
      islandDeltaCodec.readInto(r, into);
    }, 20_000));

    const kfw = new FrameWriter();
    add(`islandKey encode, ${n} vessels`, n, time(() => {
      kfw.begin();
      kfw.add(key);
    }, 20_000));
    kfw.begin();
    kfw.add(key);
    const kframe = kfw.finish().slice();
    const kreader = new FrameReader('server');
    const kvisit = (): void => undefined;
    add(`islandKey decode, ${n} vessels`, n, time(() => {
      kreader.read(kframe, kvisit);
    }, 20_000));
  }

  const input: WireMessage = {
    type: 'input',
    samples: Array.from({ length: 4 }, (_, i) => ({ seq: 100 + i, applyTick: 5000 + 4 * i, throttle: 200, pitch: -3, yaw: 0, roll: 12, tx: 0, ty: 0, tz: 0, sasHold: null })),
  };
  const ifw = new FrameWriter();
  add('input encode (4 samples)', 1, time(() => {
    ifw.begin();
    ifw.add(input);
  }, 50_000));
  ifw.begin();
  ifw.add(input);
  const iframe = ifw.finish().slice();
  const ireader = new FrameReader('client');
  const ivisit = (): void => undefined;
  add('input decode (4 samples)', 1, time(() => {
    ireader.read(iframe, ivisit);
  }, 50_000));

  log('wire codec benchmark (median of 7 trials)');
  log(`${'line'.padEnd(58)} ${'per msg'.padStart(10)} ${'per vessel'.padStart(11)} ${'GCs'.padStart(5)}`);
  for (const l of lines) log(`${l.name.padEnd(58)} ${l.perMessageUs.toFixed(3).padStart(8)} us ${(l.perMessageUs / l.vessels).toFixed(3).padStart(8)} us ${String(l.gcs).padStart(5)}`);
  return lines;
}

const isMain = typeof process !== 'undefined' && Array.isArray(process.argv) && /bench\.ts$/.test(process.argv[1] ?? '');
if (isMain) {
  void runBench().then((lines) => {
    const worst = (re: RegExp) => Math.max(...lines.filter((l) => re.test(l.name)).map((l) => l.perMessageUs / l.vessels));
    const enc = worst(/islandDelta encode.*quantise/);
    const dec = worst(/islandDelta decode.*rebuild/);
    console.log(`delta per vessel: encode ${enc.toFixed(3)} us (limit 5), decode ${dec.toFixed(3)} us (limit 5): ${enc <= 5 && dec <= 5 ? 'MET' : 'NOT MET'}`);
  });
}
