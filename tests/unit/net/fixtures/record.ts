/**
 * Records the message fixtures of tests/unit/net/fixtures from the REAL session (`createSession` of
 * src/session on the QA scenarios), as a server would send them: island keys at 1 Hz and deltas at 10 Hz of
 * the active vessel relative to a reference orbit point (the vessel's own state at the key, advanced on a
 * straight line, as an island's ISL frame would be near its anchor), PART-FAST groups from the engines,
 * legs and chutes, every SimEvent, a staging split for each decoupling, the clock and the census entry of
 * the vessel with its real patches. Each scene is stored as a recording (`.fspw`) plus `fixtures.json`.
 *
 *   npx tsx tests/unit/net/fixtures/record.ts
 *
 * FakeSession does not exist yet (presentation-sweep builds it); the scenes it will offer (rendezvous, docking
 * approach, assembly, echoes, the time strip) are to be recorded from it when it exists (docs/handoff/
 * wire-protocol.md lists them). This tool records what the real session can fly today.
 */
import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CensusEntry, DeltaPose, IslandDeltaMessage, IslandKeyMessage, PartFastEntry, ServerMessage, WireControlState } from '@/core/contracts/net';
import { CONTROL_TICK_STEPS, type SimSnapshot, type VesselSnapshot } from '@/core/contracts/sim';
import { assembleFrame, encodeMessage } from '@/net/codec/framing';
import { HandleTableOut } from '@/net/codec/handles';
import { canonicalRadius } from '@/net/codec/census';
import { quantizePose } from '@/net/codec/quant';
import { encodeRecording, type RecordedFrame } from '@/net/record/recorder';
import { controls as neutral, flatTerrain, loadLibrary, makeSim } from '../../sim-world/helpers';

const dir = path.dirname(fileURLToPath(import.meta.url));

interface Scene {
  name: string;
  scenario: string;
  seconds: number;
  /** Controls by time (s): the pilot of the scene. */
  pilot(t: number, s: SimSnapshot): { throttle: number; pitch: number; roll: number; translate: { x: number; y: number; z: number }; stage: boolean };
}

const SCENES: Scene[] = [
  {
    name: 'leo-coast-rcs',
    scenario: 'qa-leo',
    seconds: 20,
    pilot: (t) => ({ throttle: 0, pitch: t > 4 && t < 6 ? 0.4 : 0, roll: t > 8 && t < 9 ? -0.6 : 0, translate: { x: t > 10 && t < 14 ? 1 : 0, y: 0, z: t > 15 && t < 16 ? -1 : 0 }, stage: false }),
  },
  {
    name: 'ascent-staging',
    scenario: 'lunar-direct',
    seconds: 40,
    pilot: (t) => ({ throttle: 1, pitch: t > 12 && t < 20 ? 0.15 : 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, stage: t > 0.5 && t < 0.6 }),
  },
  {
    name: 'entry-chutes',
    scenario: 'qa-drogues',
    seconds: 30,
    pilot: () => ({ throttle: 0, pitch: 0, roll: 0, translate: { x: 0, y: 0, z: 0 }, stage: false }),
  },
];

const q8 = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)));

function controlState(v: VesselSnapshot, c: { throttle: number; pitch: number; roll: number; translate: { x: number; y: number; z: number } }): WireControlState {
  return { throttle: Math.round(c.throttle * 255), pitch: q8(c.pitch), yaw: 0, roll: q8(c.roll), tx: q8(c.translate.x), ty: q8(c.translate.y), tz: q8(c.translate.z), sasEnabled: true, rcsEnabled: true, fineControl: false, sasMode: 'stability', sasHold: null };
}

function partFast(v: VesselSnapshot): PartFastEntry[] {
  const out: PartFastEntry[] = [];
  v.parts.forEach((p, i) => {
    for (const m of p.modules ?? []) {
      if (m.type === 'engine' && (m.active || m.flameout)) out.push({ kind: 'engine', part: i, ignited: m.active, flameout: m.flameout, gimbalX: Math.round(m.gimbal[0] * 1e4) / 1e4, gimbalZ: Math.round(m.gimbal[1] * 1e4) / 1e4 });
      else if (m.type === 'legs' && m.deploy > 0) out.push({ kind: 'legs', part: i, deploy: Math.round(m.deploy * 255), broken: m.broken.some(Boolean) });
      else if (m.type === 'parachute' && m.state !== 'stowed') out.push({ kind: 'chute', part: i, state: m.state, inflation: Math.round(m.inflation * 255) });
    }
  });
  return out;
}

function entryOf(v: VesselSnapshot, s: SimSnapshot, tick: number): CensusEntry {
  const patches = s.patches.current.slice(0, 4).map((p) => ({ bodyId: p.bodyId, conic: p.conic, fromTick: Math.round(p.tStart * 120), toTick: Number.isFinite(p.tEnd) ? Math.round(p.tEnd * 120) : Math.round(p.tStart * 120) + 1_000_000, forecast: false }));
  return {
    vesselId: v.id,
    craftIds: (v.crafts ?? []).map((c) => c.id),
    kind: 'ship',
    name: v.name,
    vehicleId: v.vehicleId,
    ownerIds: (v.crafts ?? []).map(() => 'acct-fixture'),
    ownerCallsigns: (v.crafts ?? []).map(() => 'FIXTURE'),
    bodyId: v.bodyId,
    patches,
    landed: null,
    headTick: tick,
    horizonTick: null,
    chainEndTick: patches.length ? patches[patches.length - 1]!.toTick : tick,
    clockId: 'live',
    reservedBy: null,
    limitTick: null,
    radius: canonicalRadius(v.boundingRadius),
    expiresWallMs: null,
    thrusting: v.thrust > 0,
    revision: s.revision ?? 0,
  };
}

async function recordScene(scene: Scene, defs: Awaited<ReturnType<typeof loadLibrary>>): Promise<{ frames: RecordedFrame[]; counts: Record<string, number> }> {
  const terrain = flatTerrain(defs, { earth: -100, moon: 0 });
  const sim = await makeSim(defs, scenario(scene), terrain);
  const frames: RecordedFrame[] = [];
  const counts: Record<string, number> = {};
  // The session's handle table: new strings go out as a `handles` message at the head of the frame.
  const table = new HandleTableOut();
  const out = (atMs: number, msgs: ServerMessage[]) => {
    for (const m of msgs) counts[m.type] = (counts[m.type] ?? 0) + 1;
    const records = msgs.map((m) => encodeMessage(m, table));
    const handles = table.takePending();
    frames.push({ atMs, dir: 's2c', conn: 0, bytes: assembleFrame(handles ? [encodeMessage(handles), ...records] : records) });
  };
  let key: IslandKeyMessage | null = null;
  let ref = { r: { x: 0, y: 0, z: 0 }, v: { x: 0, y: 0, z: 0 }, tick: 0 };
  let opSeq = 0;
  const steps = scene.seconds * 120;
  const first = sim.peek();
  const tick0 = Math.round(first.simUt * 120);
  out(0, [{ type: 'clock', role: 'own', clock: { id: 'live', kind: 'live', tick0, anchorUpMs: 0, rate: 1, untilTick: null, limitedBy: null, members: [], proposals: [] }, maxRate: 4, offers: [] }]);
  for (let i = 0; i <= steps; i++) {
    const s = sim.peek();
    const v = s.vessels.find((x) => x.id === s.activeVesselId)!;
    const tick = Math.round(s.simUt * 120);
    const t = i / 120;
    const atMs = (1000 * i) / 120;
    const c = scene.pilot(t, s);
    if (i % CONTROL_TICK_STEPS === 0) {
      sim.setControls({ ...neutral(), throttle: c.throttle, pitch: c.pitch, roll: c.roll, translate: c.translate });
      if (c.stage) sim.commands.stage();
    }
    if (i % 120 === 0) {
      ref = { r: { ...v.r }, v: { ...v.v }, tick };
      key = {
        type: 'islandKey',
        island: 1,
        tick,
        vessels: [{ slot: 0, pos: { x: 0, y: 0, z: 0 }, vel: { x: 0, y: 0, z: 0 }, att: { x: Math.fround(v.q.x), y: Math.fround(v.q.y), z: Math.fround(v.q.z), w: Math.fround(v.q.w) }, rate: { x: Math.fround(v.w.x), y: Math.fround(v.w.y), z: Math.fround(v.w.z) }, controls: controlState(v, c) }],
      };
      out(atMs, [key, { type: 'relevantDelta', seq: i / 120 + 1, baseSeq: i / 120, tick, changed: [entryOf(v, s, tick)], removed: [], elements: [] }, { type: 'durable', tick: tick - 30 }]);
    } else if (i % 12 === 0 && key) {
      const dt = (tick - ref.tick) / 120;
      const cur = {
        pos: { x: v.r.x - (ref.r.x + ref.v.x * dt), y: v.r.y - (ref.r.y + ref.v.y * dt), z: v.r.z - (ref.r.z + ref.v.z * dt) },
        vel: { x: v.v.x - ref.v.x, y: v.v.y - ref.v.y, z: v.v.z - ref.v.z },
        att: v.q,
        rate: v.w,
      };
      const pose = {} as DeltaPose;
      quantizePose(key.vessels[0]!, tick - key.tick, cur, pose);
      const pf = partFast(v);
      const delta: IslandDeltaMessage = { type: 'islandDelta', island: 1, tick, keyTick: key.tick, vessels: [{ slot: 0, pose, controls: controlState(v, c), partFast: pf.length ? pf : null, contact: null }] };
      out(atMs, [delta]);
    }
    const events = s.events;
    if (events.length) {
      const msgs: ServerMessage[] = events.map((e) => ({ type: 'event', tick, epoch: 1, event: e }));
      for (const e of events) {
        if (e.type === 'decoupled' || e.type === 'fairingJettisoned') {
          msgs.push({ type: 'islandOp', island: 1, epoch: 1, tick, seq: ++opSeq, body: { op: 'split', slot: 0, cutJoints: [v.parts.findIndex((p) => p.instanceId === e.partId)].filter((x) => x >= 0), newVesselIds: e.newVesselIds }, checksum: { partCount: v.parts.length, craftHash: 0, massKg: v.mass } });
        }
      }
      out(atMs, msgs);
    }
    sim.snapshot();
    if (sim.needsIntegration || i < steps) sim.step();
    const pending = sim.terrainPending();
    if (pending) await pending;
  }
  return { frames, counts };
}

function scenario(scene: Scene): string {
  return scene.scenario;
}

const defs = await loadLibrary();
const manifest: Record<string, { file: string; frames: number; bytes: number; messages: Record<string, number>; scenario: string; seconds: number }> = {};
for (const scene of SCENES) {
  const { frames, counts } = await recordScene(scene, defs);
  const bytes = encodeRecording(frames);
  const file = `${scene.name}.fspw`;
  writeFileSync(path.join(dir, file), bytes);
  manifest[scene.name] = { file, frames: frames.length, bytes: bytes.length, messages: counts, scenario: scene.scenario, seconds: scene.seconds };
  console.log(`${file}: ${frames.length} frames, ${bytes.length} B, ${JSON.stringify(counts)}`);
}
writeFileSync(path.join(dir, 'fixtures.json'), `${JSON.stringify(manifest, null, 2)}\n`);
