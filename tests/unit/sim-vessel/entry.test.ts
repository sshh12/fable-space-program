/**
 * SAS under aerodynamic torque: a full lunar-return entry of the capsule from 122 km at 11.0 km/s,
 * flight-path angle -6.5 degrees, SAS in (surface) retrograde, roll commanded by the lift-up / lift-down
 * rule of sim-design 16.2 phase 15 - then drogues, mains and splashdown.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { ControlInputs } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { SimEvent } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { assembleVessel, fireNextStage, nextChuteEnvelope, setRcsEnabled, setSasEnabled, setSasHoldDirection, setSasMode, stepVessel, vesselReadouts, type Vessel } from '@/sim/vessel';
import { controls, DT, loadLibrary, makeEnv, STANDARD_DENSITY, VEHICLE, type FakeEnv } from './helpers';

let defs: DefLibrary;
beforeAll(async () => {
  defs = await loadLibrary();
});

interface EntryLog {
  events: SimEvent[];
  peakG: number;
  peakQ: number;
  peakQTime: number;
  peakFlux: number;
  /** Longest continuous time a pitch or yaw thruster was at full level, s, when it began and in what condition. */
  longestSaturation: number;
  saturationAt: number;
  saturationInfo: string;
  rcsAtDrogue: number;
  ablatorAtDrogue: number;
  drogueTime: number;
  trimAtPeakQ: number;
  holdAtPeakQ: number[];
  maxBackShell: number;
  maxSubstrate: number;
  reversal: { start: number; duration: number } | null;
  /** Number of lift reversals the rule commanded. */
  ruleFlips: number;
  skipped: boolean;
  time: number;
}

/**
 * Fly the entry. `forceReversalAt`, when set, flips the commanded lift direction at that time (a bank
 * reversal on demand) so its duration can be measured; everything else follows the lift rule.
 */
function flyEntry(forceReversalAt: number | null): { v: Vessel; env: FakeEnv; log: EntryLog } {
  const heating = defs.bodies['earth']!.atmosphere!.heating;
  const env = makeEnv({ densityTable: STANDARD_DENSITY, heating, terrain: () => -3000, ocean: { density: 1025 } });
  const v = assembleVessel(defs, VEHICLE, { stagesAlreadyFired: 8 });
  const gamma = -6.5 * DEG;
  v.r = { x: 0, y: env.radius + 122000, z: 0 };
  v.v = { x: 11000 * Math.cos(gamma), y: 11000 * Math.sin(gamma), z: 0 };
  // Shield first, lift (body -Z) up: nose = -v, body +Z toward the ground.
  const yAxis = v3.neg(v3.normalize(v.v));
  const up = v3.normalize(v.r);
  const zAxis = v3.neg(v3.normalize(v3.reject(up, yAxis)));
  v.q = quat.fromBasis(v3.cross(yAxis, zAxis), yAxis, zAxis);
  setRcsEnabled(v, true);
  setSasEnabled(v, true);
  setSasMode(v, 'retrograde');

  const log: EntryLog = {
    events: [],
    peakG: 0,
    peakQ: 0,
    peakQTime: 0,
    peakFlux: 0,
    longestSaturation: 0,
    saturationAt: 0,
    saturationInfo: '',
    rcsAtDrogue: -1,
    ablatorAtDrogue: -1,
    drogueTime: -1,
    trimAtPeakQ: 0,
    holdAtPeakQ: [1, 1, 1],
    maxBackShell: 0,
    maxSubstrate: 0,
    reversal: null,
    ruleFlips: 0,
    skipped: false,
    time: 0,
  };
  const input: ControlInputs = controls();
  let saturated = 0;
  let saturationStart = 0;
  let t = 0;
  let reversalSign = 1;
  let reversalStart = -1;
  let frozenRule: boolean | null = null;
  let lastRule: boolean | null = null;
  let stagePressedAt = -10;
  const rcsModule = v.parts[0]!.modules.find((m) => m.type === 'rcs');
  if (!rcsModule || rcsModule.type !== 'rcs') throw new Error('no rcs');

  while (t < 2400) {
    const r = v.r;
    const rl = v3.len(r);
    const upDir: Vec3 = v3.scale(r, 1 / rl);
    const speed = v3.len(v.v);
    const vHat = v3.scale(v.v, 1 / Math.max(speed, 1e-6));
    const vr = v3.dot(v.v, upDir);
    const altitude = rl - env.radius;
    // --- the "pilot": SAS surface-retrograde, roll only.
    setSasHoldDirection(v, v3.neg(vHat));
    let liftDown = (vr > 0 && speed > 7600) || (vr > -150 && speed > 7900);
    if (forceReversalAt !== null && t >= forceReversalAt && reversalStart < 0) {
      reversalSign = -1;
      reversalStart = t;
      frozenRule = liftDown;
    }
    // While the forced reversal is being timed the rule's own state is frozen, so exactly one flip happens.
    if (frozenRule !== null) liftDown = frozenRule;
    if (lastRule !== null && lastRule !== liftDown) log.ruleFlips++;
    lastRule = liftDown;
    const want = v3.scale(v3.normalize(v3.reject(upDir, vHat)), (liftDown ? -1 : 1) * reversalSign);
    // The lift is along body -Z; bank error measured about the nose (+Y), the roll axis.
    const noseDir = quat.rotate(v.q, { x: 0, y: 1, z: 0 });
    const lift = v3.normalize(v3.reject(quat.rotate(v.q, { x: 0, y: 0, z: -1 }), vHat));
    const bank = Math.atan2(v3.dot(v3.cross(lift, want), noseDir), v3.dot(lift, want));
    let roll = 0;
    const chutesOut = v.parts[0]!.modules.some((m) => m.type === 'parachute' && m.state !== 'stowed');
    if (!chutesOut && altitude > 9000 && v.aero.q > 20) {
      roll = 2.5 * bank - 3.0 * v.w.y;
      roll = roll > 1 ? 1 : roll < -1 ? -1 : roll;
      if (Math.abs(bank) < 3 * DEG && Math.abs(v.w.y) < 0.5 * DEG) roll = 0;
    }
    input.roll = roll;
    if (reversalStart >= 0 && log.reversal === null && t > reversalStart + 0.5 && Math.abs(bank) < 10 * DEG && Math.abs(v.w.y) < 3 * DEG) {
      log.reversal = { start: reversalStart, duration: t - reversalStart };
    }
    // --- chutes by hand, as the player would.
    if (t - stagePressedAt > 1) {
      if (v.crafts[0]!.nextStage === 8 && altitude < 7500 && nextChuteEnvelope(v, env) === 'safe') {
        log.rcsAtDrogue = vesselReadouts(v, env).rcsFraction ?? -1;
        log.ablatorAtDrogue = vesselReadouts(v, env).ablatorFraction ?? -1;
        log.drogueTime = t;
        log.events.push(...fireNextStage(v, env).events);
        stagePressedAt = t;
      } else if (v.crafts[0]!.nextStage === 9 && altitude < 3200 && v3.len(v.aero.airVelocity) < 90 && nextChuteEnvelope(v, env) === 'safe') {
        log.events.push(...fireNextStage(v, env).events);
        stagePressedAt = t;
      }
    }
    const res = stepVessel(v, env, input, DT);
    env.advance(DT);
    t += DT;
    log.events.push(...res.events);
    if (v.destroyed) break;
    // --- bookkeeping
    if (v.gLoad > log.peakG) log.peakG = v.gLoad;
    if (v.aero.q > log.peakQ) {
      log.peakQ = v.aero.q;
      log.peakQTime = t;
      log.trimAtPeakQ = 180 - v.aero.aoa / DEG;
      log.holdAtPeakQ = [...v.sas.hold];
    }
    if (v.aero.heatFlux > log.peakFlux) log.peakFlux = v.aero.heatFlux;
    log.maxSubstrate = Math.max(log.maxSubstrate, v.parts[0]!.temps[0]!);
    log.maxBackShell = Math.max(log.maxBackShell, v.parts[0]!.temps[1]!);
    // Thrusters 4..11 are the pitch and yaw jets.
    if (rcsModule.levels.slice(4).some((l) => l >= 0.999)) {
      if (saturated === 0) saturationStart = t;
      saturated += DT;
    } else saturated = 0;
    if (saturated > log.longestSaturation) {
      log.longestSaturation = saturated;
      log.saturationAt = saturationStart;
      const rates = [v.w.x, v.w.y, v.w.z].map((x) => (x / DEG).toFixed(1)).join('/');
      log.saturationInfo = 'q ' + v.aero.q.toFixed(0) + ' Pa at ' + (altitude / 1000).toFixed(1) + ' km, hold ' + v.sas.hold.map((h) => h.toFixed(2)).join('/') + ', rates ' + rates + ' deg/s, alpha ' + (180 - v.aero.aoa / DEG).toFixed(1) + ' deg';
    }
    if (vr > 50 && altitude > 100000 && t > 60) log.skipped = true;
    if (v.surface === 'splashed' && t > 60) break;
    if (forceReversalAt !== null && log.reversal !== null && t > forceReversalAt + 20) break;
    if (forceReversalAt !== null && t > forceReversalAt + 60) break;
  }
  log.time = t;
  return { v, env, log };
}

describe('capsule entry from lunar return', () => {
  let nominal: ReturnType<typeof flyEntry>;
  beforeAll(() => {
    nominal = flyEntry(null);
    const l = nominal.log;
    console.log(
      [
        'entry: peak ' + l.peakG.toFixed(2) + ' g, peak q ' + (l.peakQ / 1000).toFixed(1) + ' kPa at ' + l.peakQTime.toFixed(0) + ' s (alpha ' + l.trimAtPeakQ.toFixed(1) + ' deg, hold weights ' + l.holdAtPeakQ.map((h) => h.toFixed(2)).join('/') + ')',
        '       peak flux ' + (l.peakFlux / 1e6).toFixed(2) + ' MW/m^2, shield substrate max ' + l.maxSubstrate.toFixed(0) + ' K, back shell max ' + l.maxBackShell.toFixed(0) + ' K',
        '       drogues at ' + l.drogueTime.toFixed(0) + ' s: RCS propellant left ' + (l.rcsAtDrogue * 100).toFixed(1) + ' %, ablator left ' + (l.ablatorAtDrogue * 100).toFixed(1) + ' %',
        '       longest pitch/yaw thruster saturation ' + l.longestSaturation.toFixed(2) + ' s from t = ' + l.saturationAt.toFixed(1) + ' s (' + l.saturationInfo + ')',
        '       g-dose ' + nominal.v.gDose.toFixed(2) + ', lift reversals by the rule ' + l.ruleFlips + ', total time ' + l.time.toFixed(0) + ' s, skipped out: ' + l.skipped,
      ].join('\n'),
    );
  }, 120000);

  it('survives: peak g under 10, no dose, no skip-out, crew alive', () => {
    const { v, log } = nominal;
    expect(v.destroyed).toBe(false);
    expect(v.crewAlive).toBe(true);
    expect(log.events.some((e) => e.type === 'partDestroyed' || e.type === 'crewLost' || e.type === 'jointBroken')).toBe(false);
    expect(log.peakG).toBeLessThan(10);
    expect(log.peakG).toBeGreaterThan(4);
    expect(v.gDose).toBeLessThan(5);
    expect(log.skipped).toBe(false);
  });

  it('rides its aerodynamic trim: 15-20 degrees at peak dynamic pressure, pitch hold released', () => {
    const { log } = nominal;
    expect(log.peakQ).toBeGreaterThan(5000);
    expect(log.trimAtPeakQ).toBeGreaterThan(15);
    expect(log.trimAtPeakQ).toBeLessThan(20);
    expect(log.holdAtPeakQ[0]).toBeLessThan(0.05);
  });

  it('uses less than 60 % of the RCS propellant by drogue altitude and never holds a pitch/yaw thruster saturated for 2 s', () => {
    const { log } = nominal;
    expect(log.drogueTime).toBeGreaterThan(0);
    expect(log.rcsAtDrogue).toBeGreaterThan(0.4);
    expect(log.longestSaturation).toBeLessThan(2);
  });

  it('keeps the heat shield and structure within limits', () => {
    const { log } = nominal;
    expect(log.peakFlux).toBeGreaterThan(1.0e6);
    expect(log.ablatorAtDrogue).toBeGreaterThan(0.25);
    expect(log.ablatorAtDrogue).toBeLessThan(0.9);
    expect(log.maxSubstrate).toBeLessThan(1400 * 0.8);
    expect(log.maxBackShell).toBeLessThan(1900 * 0.8);
  });

  it('drogues, mains and splashdown follow, inside the envelopes', () => {
    const { v, log } = nominal;
    expect(log.events.filter((e) => e.type === 'chuteDeployed').map((e) => (e.type === 'chuteDeployed' ? e.mode : ''))).toEqual(['drogue', 'main']);
    expect(log.events.some((e) => e.type === 'chuteFailed')).toBe(false);
    const splash = log.events.find((e) => e.type === 'splash');
    expect(splash && splash.type === 'splash' ? splash.speed : 99).toBeLessThan(9.5);
    expect(v.surface).toBe('splashed');
    expect(v3.angle(quat.rotate(v.q, { x: 0, y: 1, z: 0 }), v3.normalize(v.r)) / DEG).toBeLessThan(20);
  });

  it('completes a 180 degree bank reversal at peak dynamic pressure in under 15 s', () => {
    const forced = flyEntry(nominal.log.peakQTime);
    expect(forced.log.reversal).not.toBeNull();
    console.log('bank reversal at peak q (' + (nominal.log.peakQ / 1000).toFixed(1) + ' kPa): ' + forced.log.reversal!.duration.toFixed(1) + ' s');
    expect(forced.log.reversal!.duration).toBeLessThan(15);
    // RCS alone (1.05 kN m on 7 600 kg m^2) would need 8-9 s; the offset CoM adds an aerodynamic rolling
    // moment in the sideslip that the roll itself creates, which shortens it.
    expect(forced.log.reversal!.duration).toBeGreaterThan(4);
    expect(forced.v.destroyed).toBe(false);
  }, 120000);
});
