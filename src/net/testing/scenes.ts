/**
 * Realistic messages for the size report, the benchmark (src/net/bench.ts) and the fixtures: vessels of an
 * island near their reference orbit with the motion of a docking approach or of an ascent, a staging
 * operation with directory-issued ids, coasting ships of the census. Deterministic (seeded).
 */
import type { CensusEntry, DeltaPose, DeltaVessel, IslandDeltaMessage, IslandKeyMessage, IslandOpMessage, KeyVessel, WireControlState } from '@/core/contracts/net';
import { conicFromState } from '@/core/math/conic';
import { Prng } from '@/core/math/hash';
import type { Quat } from '@/core/math/quat';
import { canonicalRadius } from '../codec/census';
import { quantizePose, makePose, type IslandPose } from '../codec/quant';

/** Motion of the vessels of a scene between the key and the delta. */
export type Motion = 'docking' | 'ascent';

const EARTH_MU = 3.986004418e14;

function unitQuat(p: Prng): Quat {
  const q = { x: p.next() - 0.5, y: p.next() - 0.5, z: p.next() - 0.5, w: p.next() - 0.5 };
  const n = Math.hypot(q.x, q.y, q.z, q.w);
  return { x: q.x / n, y: q.y / n, z: q.z / n, w: q.w / n };
}

/** The controls a pilot holds: SAS on in a hold mode, throttle as given. */
export function heldControls(throttle: number, rcs: { x: number; y: number; z: number } = { x: 0, y: 0, z: 0 }): WireControlState {
  return { throttle, pitch: 0, yaw: 0, roll: 0, tx: rcs.x, ty: rcs.y, tz: rcs.z, sasEnabled: true, rcsEnabled: true, fineControl: false, sasMode: 'prograde', sasHold: null };
}

/** The exact poses of `n` vessels at the key tick, within `spread` metres of the reference orbit. */
export function scenePoses(n: number, seed: number, spread: number, motion: Motion): IslandPose[] {
  const p = new Prng(seed);
  const out: IslandPose[] = [];
  for (let i = 0; i < n; i++) {
    const pose = makePose();
    pose.pos = { x: (p.next() - 0.5) * spread, y: (p.next() - 0.5) * spread, z: (p.next() - 0.5) * spread };
    const vs = motion === 'docking' ? 0.5 : 300;
    pose.vel = { x: (p.next() - 0.5) * vs, y: (p.next() - 0.5) * vs, z: (p.next() - 0.5) * vs };
    pose.att = unitQuat(p);
    const ws = motion === 'docking' ? 0.01 : 0.05;
    pose.rate = { x: (p.next() - 0.5) * ws, y: (p.next() - 0.5) * ws, z: (p.next() - 0.5) * ws };
    out.push(pose);
  }
  return out;
}

/** A key of the poses (attitude and rate rounded to float32, as the key carries them). */
export function keyOf(island: number, tick: number, poses: readonly IslandPose[], motion: Motion): IslandKeyMessage {
  const vessels: KeyVessel[] = poses.map((s, slot) => ({
    slot,
    pos: { ...s.pos },
    vel: { ...s.vel },
    att: { x: Math.fround(s.att.x), y: Math.fround(s.att.y), z: Math.fround(s.att.z), w: Math.fround(s.att.w) },
    rate: { x: Math.fround(s.rate.x), y: Math.fround(s.rate.y), z: Math.fround(s.rate.z) },
    // Under thrust the shard states the acceleration at the key (float32), as the codec carries it.
    acc: motion === 'ascent' ? f32vec(thrustOf(s.att)) : null,
    controls: heldControls(motion === 'ascent' ? 255 : 0),
  }));
  return { type: 'islandKey', island, tick, vessels };
}

/** Thrust of an ascent: 3 g (29.4 m/s^2) along the vessel's +Y axis, in island axes. */
export const ASCENT_ACCELERATION = 29.4;
export function thrustOf(q: { x: number; y: number; z: number; w: number }): { x: number; y: number; z: number } {
  const A = ASCENT_ACCELERATION;
  return { x: 2 * (q.x * q.y - q.w * q.z) * A, y: (1 - 2 * (q.x * q.x + q.z * q.z)) * A, z: 2 * (q.y * q.z + q.w * q.x) * A };
}

function f32vec(v: { x: number; y: number; z: number }): { x: number; y: number; z: number } {
  return { x: Math.fround(v.x), y: Math.fround(v.y), z: Math.fround(v.z) };
}

/**
 * The poses `dtTicks` later: a docking approach (RCS at 0.05 m/s^2 in random directions, turning at up to
 * 0.3 deg/s) or an ascent (3 g of thrust along the vessel's axis, turning at up to 3 deg/s, with +-0.5 m/s^2
 * of throttle and steering noise).
 */
export function advance(poses: readonly IslandPose[], dtTicks: number, seed: number, motion: Motion): IslandPose[] {
  const p = new Prng(seed);
  const dt = dtTicks / 120;
  const acc = motion === 'docking' ? 0.05 : 1;
  return poses.map((s) => {
    const noise = { x: (p.next() - 0.5) * acc, y: (p.next() - 0.5) * acc, z: (p.next() - 0.5) * acc };
    const t = motion === 'ascent' ? thrustOf(s.att) : { x: 0, y: 0, z: 0 };
    const a = { x: t.x + noise.x, y: t.y + noise.y, z: t.z + noise.z };
    const n = makePose();
    n.pos = { x: s.pos.x + s.vel.x * dt + 0.5 * a.x * dt * dt, y: s.pos.y + s.vel.y * dt + 0.5 * a.y * dt * dt, z: s.pos.z + s.vel.z * dt + 0.5 * a.z * dt * dt };
    n.vel = { x: s.vel.x + a.x * dt, y: s.vel.y + a.y * dt, z: s.vel.z + a.z * dt };
    // Exact rotation by the rate over dt (the key's first-order prediction leaves a second-order residual).
    const w = s.rate;
    const ang = Math.hypot(w.x, w.y, w.z) * dt;
    const k = ang > 0 ? Math.sin(ang / 2) / (ang / dt) : 0;
    const r = { x: w.x * k, y: w.y * k, z: w.z * k, w: Math.cos(ang / 2) };
    const q = s.att;
    // q (x) r: rate in VES axes.
    n.att = {
      x: q.w * r.x + q.x * r.w + q.y * r.z - q.z * r.y,
      y: q.w * r.y - q.x * r.z + q.y * r.w + q.z * r.x,
      z: q.w * r.z + q.x * r.y - q.y * r.x + q.z * r.w,
      w: q.w * r.w - q.x * r.x - q.y * r.y - q.z * r.z,
    };
    const jitter = motion === 'docking' ? 1e-4 : 1e-3;
    n.rate = { x: w.x + (p.next() - 0.5) * jitter, y: w.y + (p.next() - 0.5) * jitter, z: w.z + (p.next() - 0.5) * jitter };
    return n;
  });
}

/** The delta of `now` against `key`, with a CONTROL group for the vessels whose controls changed. */
export function deltaOf(key: IslandKeyMessage, tick: number, now: readonly IslandPose[], changedControls: readonly number[] = []): IslandDeltaMessage {
  const vessels: DeltaVessel[] = key.vessels.map((kv, i) => {
    const pose: DeltaPose = { coarsePos: false, coarseVel: false, px: 0, py: 0, pz: 0, vx: 0, vy: 0, vz: 0, attLargest: 0, attAbsolute: false, qa: 0, qb: 0, qc: 0, wx: 0, wy: 0, wz: 0 };
    quantizePose(kv, tick - key.tick, now[i]!, pose);
    return { slot: kv.slot, pose, controls: changedControls.includes(i) ? heldControls(0, { x: 40, y: 0, z: -12 }) : null, partFast: null, contact: null };
  });
  return { type: 'islandDelta', island: key.island, tick, keyTick: key.tick, vessels };
}

/** Ids as the directory issues them: a 12-character craft id, part instance ids as in the vehicle files. */
export const SCENE_CRAFT = 'k7x2m9q4b1zt';

/** A staging split with the server's id of the spent stage (ARCHITECTURE 13.4: "tens of bytes"). */
export function stagingOp(island: number, tick: number): IslandOpMessage {
  return {
    type: 'islandOp',
    island,
    epoch: 3,
    tick,
    seq: 17,
    body: { op: 'split', slot: 0, cutJoints: [21], newVesselIds: [`${SCENE_CRAFT}~interstage-s1`] },
    checksum: { partCount: 17, craftHash: 0x9e3779b9, massKg: 162_431.75 },
  };
}

/** A coasting ship in low Earth orbit as the census and the relevant set carry it. */
export function coastingEntry(i: number, baseTick: number): CensusEntry {
  const p = new Prng(1000 + i);
  const r = 6.371e6 + 4e5 + p.next() * 2e5;
  const th = p.next() * 2 * Math.PI;
  const inc = 0.3 + p.next() * 0.6;
  const pos = { x: r * Math.cos(th), y: r * Math.sin(th) * Math.cos(inc), z: r * Math.sin(th) * Math.sin(inc) };
  const vc = Math.sqrt(EARTH_MU / r) * (1 + (p.next() - 0.5) * 0.02);
  const vel = { x: -vc * Math.sin(th), y: vc * Math.cos(th) * Math.cos(inc), z: vc * Math.cos(th) * Math.sin(inc) };
  const head = baseTick - Math.floor(p.next() * 1e7);
  const conic = conicFromState(EARTH_MU, pos, vel, head / 120);
  const chainEnd = head + 16 * 3_000_000;
  const craft = `c${(1e11 + i * 7919).toString(36)}`;
  return {
    vesselId: craft,
    craftIds: [craft],
    kind: 'ship',
    name: `ORBITER ${i}`,
    vehicleId: 'meridian-lunar',
    ownerIds: [`acct-${i % 37}`],
    ownerCallsigns: [`PILOT-${i % 37}`],
    bodyId: 'earth',
    patches: [{ bodyId: 'earth', conic, fromTick: head, toTick: chainEnd, forecast: true }],
    landed: null,
    headTick: head,
    horizonTick: null,
    chainEndTick: chainEnd,
    clockId: null,
    reservedBy: null,
    limitTick: baseTick + 30 * 86400 * 120,
    radius: canonicalRadius(14.2 + p.next()),
    expiresWallMs: 1_900_000_000_000 + Math.floor(p.next() * 1e9),
    thrusting: false,
    revision: 1 + Math.floor(p.next() * 50),
  };
}
