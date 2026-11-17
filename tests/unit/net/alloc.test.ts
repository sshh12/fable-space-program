/**
 * Zero allocations per message in steady state for the high-rate types (the brief's acceptance): encoding
 * into a reused `FrameWriter` and decoding through a `FrameReader` (reused frames) allocate nothing once the
 * pools have grown. Measured as the growth of the heap and of array-buffer memory over 100,000 messages of
 * each type after a forced collection, with a collection forbidden in between (the heap is checked for
 * growth only; any allocation of an object is at least 16 bytes, so 100,000 messages that allocate leave
 * at least 1.6 MB behind).
 */
import { setFlagsFromString } from 'node:v8';
import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import type { WireMessage } from '@/core/contracts/net';
import { FrameReader, FrameWriter, type FrameSource } from '@/net/codec/framing';
import { HandleTableIn, HandleTableOut } from '@/net/codec/handles';
import { advance, coastingEntry, deltaOf, keyOf, scenePoses } from '@/net/testing/scenes';

setFlagsFromString('--expose-gc');
const gc = runInNewContext('gc') as () => void;

const N = 100_000;

function used(): number {
  const m = process.memoryUsage();
  return m.heapUsed + m.arrayBuffers;
}

/** Growth over N runs of `once` after a warm-up and a forced collection. */
function growthOf(once: () => void): number {
  for (let i = 0; i < 20_000; i++) once();
  gc();
  gc();
  const before = used();
  for (let i = 0; i < N; i++) once();
  return used() - before;
}

/**
 * Encoding: into the reused writer of a `FrameWriter` (the frame view handed to a transport, one per frame,
 * is not counted). Decoding: a frame as a transport delivers it, through a `FrameReader`.
 */
function steadyGrowth(msg: WireMessage, source: FrameSource, table: HandleTableOut | null, inTable: HandleTableIn | null): { encode: number; decode: number } {
  const fw = new FrameWriter();
  fw.w.table = table;
  let bytes = 0;
  const encode = growthOf(() => {
    fw.begin();
    fw.add(msg);
    bytes += fw.bytesSoFar;
  });
  expect(bytes).toBeGreaterThan(0);
  fw.begin();
  fw.add(msg);
  const frame = fw.finish().slice();
  const reader = new FrameReader(source, inTable);
  let visited = 0;
  const visit = (m: WireMessage): void => {
    if (m.type === msg.type) visited++;
  };
  const decode = growthOf(() => {
    const err = reader.read(frame, visit);
    if (err) throw new Error(`${msg.type}: ${JSON.stringify(err)}`);
  });
  expect(visited).toBe(20_000 + N);
  return { encode, decode };
}

describe('the high-rate messages allocate nothing in steady state', () => {
  const key = keyOf(7, 1_000_000, scenePoses(10, 5, 1000, 'docking'), 'docking');
  const delta = deltaOf(key, key.tick + 60, advance(scenePoses(10, 5, 1000, 'docking'), 60, 9, 'docking'), [2, 7]);
  const contact = (i: number) => ({
    pos: { x: 12.5 + i, y: -3.25, z: 0.125 },
    vel: { x: 0.031, y: -0.002, z: 0.0001 },
    att: { x: 0.1, y: 0.2, z: 0.3, w: 0.927 },
    rate: { x: 0.0011, y: -0.0021, z: 0.0003 },
    probes: [{ probe: 2, touching: true, wet: false, anchor: { x: 1.5, y: 2.25, z: -0.75 } }],
    ports: [{ part: 14, state: 'soft' as const, armed: true, progress: 0.42 }],
  });
  const pair: WireMessage = {
    type: 'islandDelta',
    island: 7,
    tick: 1_000_090,
    keyTick: 1_000_000,
    vessels: [0, 1].map((slot) => ({ slot, pose: null, controls: null, partFast: [{ kind: 'engine' as const, part: 3, ignited: false, flameout: false, gimbalX: 0.0123, gimbalZ: -0.004 }], contact: contact(slot) })),
  };
  const cases: [string, WireMessage, FrameSource][] = [
    ['islandDelta (10 vessels, two control groups)', delta, 'server'],
    ['islandDelta (a pair in contact, exact form, part-fast)', pair, 'server'],
    ['islandKey (10 vessels)', key, 'server'],
    ['inputAck', { type: 'inputAck', marginMs: 41.5, stamped: [{ from: 10, to: 40 }, { from: 42, to: 50 }], late: [{ seq: 41, appliedTick: 123456 }] }, 'server'],
    [
      'input (4 samples, one with a hold vector)',
      {
        type: 'input',
        samples: Array.from({ length: 4 }, (_, i) => ({ seq: 100 + i, applyTick: 5000 + 4 * i, throttle: 200, pitch: -3, yaw: 0, roll: 12, tx: 0, ty: 0, tz: 0, sasHold: i === 2 ? { x: 0.6, y: 0.8, z: 0 } : null })),
      },
      'client',
    ],
  ];
  for (const [name, msg, source] of cases) {
    it(name, () => {
      const g = steadyGrowth(msg, source, null, null);
      console.log(`${name}: encode ${g.encode} B, decode ${g.decode} B over ${N} messages`);
      expect(g.encode).toBeLessThan(64 * 1024);
      expect(g.decode).toBeLessThan(64 * 1024);
    });
  }

  it('near (8 vessels, strings as session handles)', () => {
    const table = new HandleTableOut();
    const inTable = new HandleTableIn();
    const msg: WireMessage = {
      type: 'near',
      tick: 1_000_060,
      vessels: Array.from({ length: 8 }, (_, i) => ({
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
        thrust: i % 2 ? { x: 0, y: 127, z: 0 } : null,
        stage: 2,
        burning: i % 2 === 1,
        flameout: false,
        controls: null,
      })),
    };
    // The handles are assigned once, as a session would.
    const pending = (() => {
      const fw = new FrameWriter();
      fw.w.table = table;
      fw.add(msg);
      return table.takePending();
    })();
    if (pending) inTable.apply(pending);
    const g = steadyGrowth(msg, 'server', table, inTable);
    console.log(`near (8 vessels): encode ${g.encode} B, decode ${g.decode} B over ${N} messages`);
    expect(g.encode).toBeLessThan(64 * 1024);
    expect(g.decode).toBeLessThan(64 * 1024);
  });
});
