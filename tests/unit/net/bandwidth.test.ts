/**
 * The downstream budget against real frames (review findings 6 and 13): per scenario, the bytes per second the
 * island would cost at its target rate, and what the budget (the lead's decisions (a)-(e)) delivers over ten
 * minutes with the near tier, the relevant set and the pads alongside: the sustained rate, the delta rate it
 * settled on, the burst used. The table printed here is the one in docs/handoff/wire-protocol.md.
 */
import { describe, expect, it } from 'vitest';
import type { IslandDeltaMessage, ServerMessage } from '@/core/contracts/net';
import { DEFAULT_UNIVERSE_RULES, wireLimits } from '@/core/contracts/net';
import { encodeDocument, encodeMessage } from '@/net/codec/framing';
import { HandleTableOut } from '@/net/codec/handles';
import { obsoletedKeys, randomMessage, specOf, supersedeKey } from '@/net/codec/messages';
import { Gen } from '@/net/codec/schema';
import { budgetClassOf, DownstreamBudget } from '@/net/session/budget';
import { budgetOptionsOf } from '@/net/session/server';
import { advance, coastingEntry, deltaOf, keyOf, scenePoses, type Motion } from '@/net/testing/scenes';

const limits = wireLimits(DEFAULT_UNIVERSE_RULES);
const ISLAND = 7;

type Contact = NonNullable<IslandDeltaMessage['vessels'][number]['contact']>;
function contact(i: number, t: number, probes: number): Contact {
  return {
    pos: { x: 12.5 + i + t * 1e-4, y: -3.25, z: 0.125 },
    vel: { x: 0.031, y: -0.002, z: 0.0001 },
    att: { x: 0.1, y: 0.2, z: 0.3, w: 0.927 },
    rate: { x: 0.0011, y: -0.0021, z: 0.0003 },
    probes: Array.from({ length: probes }, (_, p) => ({ probe: p, touching: true, wet: false, anchor: { x: 1.5 + p, y: 2.25, z: -0.75 } })),
    ports: probes === 0 ? [{ part: 14, state: 'soft' as const, armed: true, progress: 0.42 }] : [],
  };
}

interface Scenario {
  name: string;
  /** The island's delta at step `k` (60 Hz steps) and the key it is against. */
  island(k: number): { key: ServerMessage | null; delta: ServerMessage; contact: boolean };
}

function freeFlight(name: string, n: number, motion: Motion, steering: (k: number) => number[]): Scenario {
  let poses = scenePoses(n, 5, 1000, motion);
  let key = keyOf(ISLAND, 1_000_000, poses, motion);
  return {
    name,
    island(k) {
      poses = advance(poses, 2, 9 + k, motion);
      const tick = 1_000_000 + 2 * k;
      // A key every second (120 ticks), as the shard sends them.
      if (k % 60 === 0) {
        key = keyOf(ISLAND, tick, poses, motion);
        return { key, delta: deltaOf(key, tick, poses, steering(k)), contact: false };
      }
      return { key: null, delta: deltaOf(key, tick, poses, steering(k)), contact: false };
    },
  };
}

function inContact(name: string, probes: number): Scenario {
  return {
    name,
    island(k) {
      const tick = 1_000_000 + 2 * k;
      const keyTick = tick - (k % 60) * 2;
      const delta: ServerMessage = {
        type: 'islandDelta',
        island: ISLAND,
        tick,
        keyTick,
        vessels: [0, 1].map((slot) => ({ slot, pose: null, controls: null, partFast: [{ kind: 'engine' as const, part: 3, ignited: false, flameout: false, gimbalX: 0.0123, gimbalZ: -0.004 }], contact: contact(slot, k, probes) })),
      };
      const key = k % 60 === 0 ? keyOf(ISLAND, tick, scenePoses(2, 5, 30, 'docking'), 'docking') : null;
      return { key, delta, contact: true };
    },
  };
}

const SCENARIOS: Scenario[] = [
  freeFlight('ten vessels docking (two steering)', 10, 'docking', () => [2, 7]),
  freeFlight('ten vessels at 3 g, all steering', 10, 'ascent', () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]),
  inContact('a pair in contact, exact form', 0),
  inContact('a landed pair, four probes each', 4),
];

/** The near tier (8 vessels at 10 Hz), the relevant set (2 entries a second), the pads (1 Hz), input acks (1 Hz). */
function background(table: HandleTableOut) {
  const g = new Gen(5);
  const near = randomMessage('near', g);
  near.band = 'near';
  // Eight vessels near by, as the allocation test builds them (two thirds with thrust on).
  near.vessels = Array.from({ length: 8 }, (_, i) => ({
    vesselId: coastingEntry(i, 0).vesselId,
    island: 40 + i,
    coarse: false,
    px: 1200 * i,
    py: -300,
    pz: 77,
    vx: 15,
    vy: -2,
    vz: 0,
    attLargest: 3 as const,
    qa: 120,
    qb: -800,
    qc: 3,
    throttle: i * 30,
    thrust: i % 3 ? { x: 0, y: 127, z: 0 } : null,
    stage: 2,
    burning: i % 3 !== 0,
    flameout: false,
    controls: null,
  }));
  const pads = randomMessage('pads', new Gen(6));
  return {
    near: (k: number): ServerMessage => ({ ...near, tick: 1_000_000 + 2 * k }),
    relevant: (k: number): ServerMessage => ({ type: 'relevantDelta', seq: k + 1, baseSeq: k, tick: 1_000_000 + 2 * k, changed: [coastingEntry(k % 30, 1_000_000), coastingEntry((k + 7) % 30, 1_000_000)], removed: [], elements: [] }),
    pads: (): ServerMessage => pads,
    ack: (k: number): ServerMessage => ({ type: 'inputAck', marginMs: 41.5, stamped: [{ from: k * 60, to: k * 60 + 59 }], late: [] }),
    table,
  };
}

function offer(b: DownstreamBudget, m: ServerMessage, table: HandleTableOut, now: number, extra: { contact?: boolean } = {}): number {
  const rec = encodeMessage(m, table);
  const h = table.takePending();
  let n = rec.length;
  if (h) {
    const hr = encodeMessage(h);
    n += hr.length;
    b.offer(hr, 0, null, now);
  }
  const key = specOf(m.type).delivery === 'latest' ? supersedeKey(m) : null;
  b.offer(rec, budgetClassOf(m), key, now, { obsoletes: obsoletedKeys(m), contact: extra.contact ?? false });
  return n;
}

describe('the budget against real frames, per scenario', () => {
  it('prints the bytes per second at the target rate and what the budget delivers over ten minutes', () => {
    const rows: string[] = [];
    for (const sc of SCENARIOS) {
      const table = new HandleTableOut();
      const bg = background(table);
      const b = new DownstreamBudget(budgetOptionsOf(limits));
      let deltaBytes = 0;
      let deltas = 0;
      let keyBytes = 0;
      let firstMinute = 0;
      let sent = 0;
      const SECONDS = 600;
      for (let k = 0; k < SECONDS * 60; k++) {
        const now = (k * 1000) / 60;
        const isl = sc.island(k);
        if (isl.key) keyBytes += offer(b, isl.key, table, now);
        const n = offer(b, isl.delta, table, now, { contact: isl.contact });
        deltaBytes += n;
        deltas++;
        if (k % 6 === 0) offer(b, bg.near(k), table, now);
        if (k % 60 === 0) {
          offer(b, bg.relevant(k / 60), table, now);
          offer(b, bg.pads(), table, now);
          offer(b, bg.ack(k / 60), table, now);
        }
        for (const r of b.take(now)) {
          sent += r.record.length;
          if (now < 60_000) firstMinute += r.record.length;
        }
      }
      const avgDelta = deltaBytes / deltas;
      const keyPerS = keyBytes / SECONDS;
      const at = (hz: number) => ((avgDelta * hz + keyPerS) / 1000).toFixed(1);
      const s = b.stats;
      const row = `${sc.name}: delta ${avgDelta.toFixed(0)} B, key ${(keyPerS).toFixed(0)} B/s; island alone ${at(30)} kB/s at 30 Hz, ${at(60)} kB/s at 60 Hz; delivered over 600 s ${(sent / SECONDS / 1000).toFixed(2)} kB/s (first minute ${(firstMinute / 60 / 1000).toFixed(1)} kB/s), delta rate settled at ${s.deltaRateHz.toFixed(1)} Hz, ${s.burstSeconds.toFixed(0)} s of burst`;
      rows.push(row);
      // (a) never above the sustained rate plus one burst allowance per 600 s, and the burst is bounded.
      expect(sent).toBeLessThanOrEqual(limits.downstreamBytesPerSecond * SECONDS + (limits.downstreamBurstBytesPerSecond - limits.downstreamBytesPerSecond) * limits.downstreamBurstSeconds + 64 * 1024);
      expect(s.burstSeconds).toBeLessThanOrEqual(limits.downstreamBurstSeconds + 1);
      // (b) the delta rate never falls under the floor, and (e) the relevant set got through.
      expect(s.deltaRateHz).toBeGreaterThanOrEqual(limits.deltaRateFloor);
      expect(s.sentBytes[3]).toBeGreaterThan(0);
    }
    console.log(rows.join('\n'));
  });

  it('finding 13: the ten-vessel delta with all ten steering, and a census entry on first sight', () => {
    const all = freeFlight('ten vessels at 3 g, all steering', 10, 'ascent', () => [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    let n = 0;
    let bytes = 0;
    for (let k = 1; k < 600; k++) {
      const isl = all.island(k);
      if (k % 60 === 0) continue;
      bytes += encodeMessage(isl.delta).length;
      n++;
    }
    const table = new HandleTableOut();
    const entry: ServerMessage = { type: 'relevantDelta', seq: 2, baseSeq: 1, tick: 1_000_000, changed: [coastingEntry(3, 1_000_000)], removed: [], elements: [] };
    const empty: ServerMessage = { type: 'relevantDelta', seq: 2, baseSeq: 1, tick: 1_000_000, changed: [], removed: [], elements: [] };
    const rec = encodeMessage(entry, table);
    const handles = table.takePending();
    const first = rec.length - encodeMessage(empty).length + (handles ? encodeMessage(handles).length : 0);
    const again = encodeMessage(entry, table).length - encodeMessage(empty).length;
    console.log(`ten vessels, all steering: ${(bytes / n).toFixed(0)} B per delta; a census entry: ${first} B on first sight (with its handles), ${again} B after`);
    // At 3 g the residuals of a key-relative pose grow with the square of the time since the key; docking (the
    // brief's case) is measured in the next test against the 300 B line.
    expect(bytes / n).toBeLessThan(420);
    expect(again).toBeLessThanOrEqual(90);
    expect(first).toBeLessThan(150);
  });

  it('the size lines after the review of 2026-11-17: ten docking vessels ALL steering within 300 B; 10,000 census objects', () => {
    // Worst of every 30 Hz send tick of a key interval, 20 seeds (the first delivery's method).
    let worst = 0;
    let sum = 0;
    let n = 0;
    for (let seed = 1; seed <= 20; seed++) {
      const p0 = scenePoses(10, seed, 1000, 'docking');
      const key = keyOf(ISLAND, 1_000_000, p0, 'docking');
      for (let dt = 4; dt <= 120; dt += 4) {
        const b = encodeMessage(deltaOf(key, key.tick + dt, advance(p0, dt, 9 + seed, 'docking'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).length;
        worst = Math.max(worst, b);
        sum += b;
        n++;
      }
    }
    // The public census of one sphere: 10,000 coasting ships in one snapshot document (its own string table).
    const entries = Array.from({ length: 10_000 }, (_, i) => coastingEntry(i, 1_000_000_000));
    const doc = encodeDocument({ type: 'censusSnapshot', soi: 'earth', seq: 1, wallMs: 1_763_000_000_000, tick: 1_000_000_000, pollAfterS: 30, entries });
    console.log(`ten docking vessels, all steering: worst ${worst} B, mean ${(sum / n).toFixed(1)} B; census of 10,000 objects: ${(doc.length / 1000).toFixed(0)} kB (${(doc.length / 10_000).toFixed(1)} B per object)`);
    expect(worst).toBeLessThanOrEqual(300);
    // ARCHITECTURE 14 plans 840 kB: met since names and callsigns left the documents (lead decision, 2026-11-17).
    expect(doc.length).toBeLessThanOrEqual(840_000);
  });

  it('ten vessels at 3 g, all steering: the acceleration term of the key against the same deltas without it', () => {
    const measure = (withAcc: boolean) => {
      let sum = 0;
      let worst = 0;
      let n = 0;
      let keyBytes = 0;
      for (let seed = 1; seed <= 20; seed++) {
        const p0 = scenePoses(10, seed, 1000, 'ascent');
        const k0 = keyOf(ISLAND, 1_000_000, p0, 'ascent');
        const key = withAcc ? k0 : { ...k0, vessels: k0.vessels.map((v) => ({ ...v, acc: null })) };
        keyBytes = encodeMessage(key).length;
        for (let dt = 4; dt <= 120; dt += 4) {
          const b = encodeMessage(deltaOf(key, key.tick + dt, advance(p0, dt, 9 + seed, 'ascent'), [0, 1, 2, 3, 4, 5, 6, 7, 8, 9])).length;
          sum += b;
          worst = Math.max(worst, b);
          n++;
        }
      }
      return { mean: sum / n, worst, key: keyBytes };
    };
    const a = measure(true);
    const b = measure(false);
    console.log(`3 g, all steering: with the term mean ${a.mean.toFixed(1)} B, worst ${a.worst} B, key ${a.key} B; without it mean ${b.mean.toFixed(1)} B, worst ${b.worst} B, key ${b.key} B`);
    expect(a.mean).toBeLessThan(b.mean - 40);
    // The term costs 12 B per thrusting vessel in the key, nothing for a coasting one.
    expect(a.key - b.key).toBe(12 * 10);
  });
});
