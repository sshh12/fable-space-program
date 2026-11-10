/**
 * Aerodynamics: lifting-capsule trim and L/D, static stability, stack drag and shadowing, flat plates,
 * and the q-alpha structural limit.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '@/core/contracts/defs';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3 } from '@/core/math/vec3';
import { aeroOut, evalAero, machLookup, refreshAeroCoefficients } from '@/sim/dynamics/aero';
import { assembleVessel, computeMassProps, structureOf, type Vessel } from '@/sim/vessel';
import { controls, earthAir, loadLibrary, makeEnv, run, runAll, VEHICLE } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

/** Free capsule (apex cover on, as during entry) prepared for aerodynamic evaluation at a Mach number. */
function entryCapsule(mach: number): Vessel {
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
  computeMassProps(v);
  refreshAeroCoefficients(structureOf(v), mach);
  return v;
}

/**
 * Aerodynamic force and torque for a flight direction tilted by alpha from the shield normal (-Y) in the
 * plane containing the body axis and the direction `side` (unit, normal to Y). Returns the pitching moment
 * about the axis that turns the shield normal toward the flight direction (positive = restoring toward
 * larger alpha), lift over drag, and the lift direction in the body.
 */
function capsuleAt(v: Vessel, alphaDeg: number, side = { x: 0, y: 0, z: -1 }): { moment: number; ld: number; lift: { x: number; y: number; z: number }; drag: number } {
  const a = alphaDeg * DEG;
  const speed = 3000;
  const t = { x: side.x * Math.sin(a), y: -Math.cos(a), z: side.z * Math.sin(a) };
  evalAero(v, structureOf(v), 0.01, t.x * speed, t.y * speed, t.z * speed, 0, 0, 0, aeroOut);
  const f = { x: aeroOut.fx, y: aeroOut.fy, z: aeroOut.fz };
  const drag = -v3.dot(f, t);
  const liftVec = v3.addScaled(f, t, -v3.dot(f, t));
  // Rotation axis that carries -Y toward `side`: (-Y) x side.
  const axis = v3.cross({ x: 0, y: -1, z: 0 }, side);
  const moment = aeroOut.tx * axis.x + aeroOut.ty * axis.y + aeroOut.tz * axis.z;
  return { moment, ld: v3.len(liftVec) / drag, lift: v3.normalize(liftVec), drag };
}

function trimAngle(v: Vessel): number {
  let lo = 1;
  let hi = 45;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    // Below trim the offset CoM pushes alpha up (moment toward larger alpha is negative of restoring).
    if (capsuleAt(v, mid).moment < 0) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

describe('lifting capsule', () => {
  it('trims at 15-20 degrees angle of attack with L/D 0.26-0.34 at Mach 10', () => {
    const v = entryCapsule(10);
    const alpha = trimAngle(v);
    const at = capsuleAt(v, alpha);
    console.log(`capsule trim at Mach 10: alpha ${alpha.toFixed(2)} deg, L/D ${at.ld.toFixed(3)}, CoM (${v.mp.com.x.toFixed(4)}, ${v.mp.com.y.toFixed(4)}, ${v.mp.com.z.toFixed(4)})`);
    expect(alpha).toBeGreaterThan(15);
    expect(alpha).toBeLessThan(20);
    expect(at.ld).toBeGreaterThan(0.26);
    expect(at.ld).toBeLessThan(0.34);
    expect(Math.abs(at.moment)).toBeLessThan(1e-3 * at.drag);
    // The lift points to the side the CoM is offset to (-Z): the capsule is rolled to steer.
    expect(at.lift.z).toBeLessThan(-0.9);
    expect(v.mp.com.z).toBeLessThan(-0.1);
  });

  it('is statically stable shield-first and has no second trim apex-first', () => {
    const v = entryCapsule(10);
    const alpha = trimAngle(v);
    // Restoring on both sides of the trim point, in the trim plane.
    expect(capsuleAt(v, alpha - 5).moment).toBeLessThan(0);
    expect(capsuleAt(v, alpha + 5).moment).toBeGreaterThan(0);
    // Sweep the whole circle in the pitch plane: exactly one stable equilibrium.
    let stable = 0;
    let previous = capsuleAt(v, -179.5).moment;
    for (let a = -179; a <= 179.5; a += 0.5) {
      const m = capsuleAt(v, a).moment;
      // moment > 0 pushes alpha down toward the equilibrium below; a stable point is a - to + crossing.
      if (previous < 0 && m >= 0) stable++;
      previous = m;
    }
    expect(stable).toBe(1);
    // Out of plane (sideslip) the capsule is restored toward zero sideslip.
    const side = { x: 1, y: 0, z: 0 };
    expect(capsuleAt(v, 10, side).moment).toBeGreaterThan(0);
    expect(capsuleAt(v, -10, side).moment).toBeLessThan(0);
    // Toward apex-first the moment keeps pushing back to shield-first from both sides.
    expect(capsuleAt(v, 150).moment).toBeGreaterThan(0);
    expect(capsuleAt(v, -150).moment).toBeLessThan(0);
  });

  it('released apex-first in a dense flow it swings round to shield-first', () => {
    const env = makeEnv({ atmosphere: earthAir });
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
    // Falling at 300 m/s through 20 km, 30 degrees off apex-first.
    v.r = { x: 0, y: env.radius + 20000, z: 0 };
    v.v = { x: 0, y: -300, z: 0 };
    v.q = quat.fromAxisAngle({ x: 1, y: 0, z: 0 }, 150 * DEG);
    let minAoa = Infinity;
    run(v, env, 40, controls(), (t) => {
      if (t > 30) minAoa = Math.min(minAoa, v.aero.aoa / DEG);
    });
    // The apex trails: the nose stays within 40 degrees of pointing straight back along the velocity.
    expect(minAoa).toBeGreaterThan(140);
  });

  it('axial drag coefficient follows the capsule table', () => {
    const v = entryCapsule(2);
    const table = defs.parts['kestrel-capsule']!.aero!.find((e) => e.kind === 'bluntCapsule');
    if (!table || table.kind !== 'bluntCapsule') throw new Error('no table');
    expect(machLookup(table.cdTable, 2)).toBe(1.45);
    expect(machLookup(table.cdTable, 0.3)).toBeCloseTo(0.91, 9);
    expect(machLookup(table.cdTable, 50)).toBe(1.3);
    const q = 0.5 * 0.01 * 3000 * 3000;
    expect(capsuleAt(v, 0).drag).toBeCloseTo(q * table.refArea * 1.45, -1);
  });
});

describe('launch stack', () => {
  it('nose-first drag area equals the table coefficient times the maximum cross-section', () => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    computeMassProps(v);
    const st = structureOf(v);
    for (const [mach, cd] of [[0.5, 0.3], [1.1, 0.55], [3, 0.32]] as const) {
      refreshAeroCoefficients(st, mach);
      const speed = 400;
      const rho = 0.3;
      evalAero(v, st, rho, 0, speed, 0, 0, 0, 0, aeroOut);
      const cdA = -aeroOut.fy / (0.5 * rho * speed * speed);
      // The covered fractions use each part's own envelope radius (boost cover 2.05 m, fairing 3.35 m).
      expect(cdA / (cd * Math.PI * 4.5 * 4.5)).toBeGreaterThan(0.97);
      expect(cdA / (cd * Math.PI * 4.5 * 4.5)).toBeLessThan(1.03);
      expect(Math.abs(aeroOut.fx) + Math.abs(aeroOut.fz)).toBeLessThan(1e-6 * Math.abs(aeroOut.fy));
    }
    // Parts inside the fairing and under the boost cover contribute nothing.
    const shielded = v.parts.filter((p) => p.shielded).map((p) => p.instanceId).sort();
    expect(shielded).toEqual(['apex-cover', 'ascent-stage', 'capsule', 'capsule-adapter', 'descent-stage', 'landing-legs', 'lyra-a', 'lyra-d', 'payload-adapter', 'stage-separator']);
    expect(st.aero.some((e) => shielded.includes(v.parts[e.part]!.instanceId))).toBe(false);
  });

  it('cross-flow gives a normal force and a moment at angle of attack; flying backwards uses the blunt table', () => {
    const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
    computeMassProps(v);
    const st = structureOf(v);
    refreshAeroCoefficients(st, 1.5);
    const speed = 450;
    const rho = 0.25;
    const a = 6 * DEG;
    evalAero(v, st, rho, 0, speed * Math.cos(a), speed * Math.sin(a), 0, 0, 0, aeroOut);
    expect(aeroOut.fz).toBeLessThan(0);
    expect(Math.abs(aeroOut.tx)).toBeGreaterThan(1e4);
    const fwd = -aeroOut.fy;
    evalAero(v, st, rho, 0, -speed, 0, 0, 0, 0, aeroOut);
    expect(aeroOut.fy).toBeGreaterThan(1.5 * fwd);
  });

  it('breaks at the weakest joint when q-alpha exceeds the limit, but not in a gentle turn', () => {
    const fly = (alphaDeg: number): { events: string[]; vessels: Vessel[]; qAlpha: number } => {
      const env = makeEnv({ atmosphere: earthAir });
      const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 1 });
      // Max-q: about 30 kPa at 11 km and 480 m/s.
      v.r = { x: 0, y: env.radius + 11000, z: 0 };
      v.q = quat.fromAxisAngle({ x: 0, y: 0, z: 1 }, -alphaDeg * DEG);
      v.v = { x: 0, y: 480, z: 0 };
      const vessels = [v];
      let qAlpha = 0;
      const ev = runAll(vessels, env, 1.0, controls({ throttle: 1 }), () => {
        qAlpha = Math.max(qAlpha, v.aero.q * v.aero.aoa);
      });
      return { events: ev.map((e) => (e.type === 'jointBroken' ? `jointBroken:${e.partId}` : e.type)), vessels, qAlpha };
    };
    const gentle = fly(3);
    expect(gentle.qAlpha).toBeGreaterThan(1200);
    expect(gentle.events.some((e) => e.startsWith('jointBroken'))).toBe(false);
    expect(gentle.vessels).toHaveLength(1);
    const hard = fly(9);
    expect(hard.qAlpha).toBeGreaterThan(3500);
    expect(hard.events).toContain('jointBroken:interstage-2');
    expect(hard.vessels.length).toBeGreaterThan(1);
    // The limit in the data: 6 degrees at 33 kPa (sim-design 8.2).
    const limit = defs.parts['meridian-interstage-2']!.joint.maxQAlpha!;
    expect(limit).toBeLessThan(33000 * 6 * DEG * 1.05);
    expect(limit).toBeGreaterThan(31000 * 4 * DEG * 1.3);
  });
});

describe('flat plates', () => {
  it('a fairing panel is a plate with Cd 1.28 on its projected area', () => {
    const stack = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 2 });
    const env = makeEnv({ atmosphere: earthAir });
    stack.r = { x: 0, y: env.radius + 30000, z: 0 };
    const vessels = [stack];
    const { spawned } = { spawned: [] as Vessel[] };
    void spawned;
    // Jettison through the stage, then look at one panel.
    const res = runAll(vessels, env, 0.01, controls());
    void res;
    const fairing = stack.parts.find((p) => p.instanceId === 'fairing')!;
    const b = fairing.def.bounds;
    const chordArea = 2 * b.radius * Math.sin(Math.PI / 4) * (b.yMax - b.yMin);
    // Build a panel vessel through the public split and evaluate it face-on and edge-on.
    return import('@/sim/vessel').then(({ splitForStage }) => {
      const panels = splitForStage(defs, stack, 2).spawned.filter((x) => x.id.includes('#panel'));
      const p = panels[0]!;
      computeMassProps(p);
      const st = structureOf(p);
      const speed = 200;
      const rho = 0.02;
      // Panel 0 is centred at azimuth 45 degrees: radial direction (sin 45, 0, cos 45).
      const n = { x: Math.SQRT1_2, y: 0, z: Math.SQRT1_2 };
      evalAero(p, st, rho, n.x * speed, 0, n.z * speed, 0, 0, 0, aeroOut);
      const f = Math.hypot(aeroOut.fx, aeroOut.fy, aeroOut.fz);
      expect(f).toBeCloseTo(0.5 * rho * speed * speed * chordArea * 1.28, 0);
      expect(aeroOut.fx * n.x + aeroOut.fz * n.z).toBeLessThan(0);
      evalAero(p, st, rho, 0, speed, 0, 0, 0, 0, aeroOut);
      expect(Math.hypot(aeroOut.fx, aeroOut.fy, aeroOut.fz)).toBeLessThan(1e-6);
    });
  });
});
