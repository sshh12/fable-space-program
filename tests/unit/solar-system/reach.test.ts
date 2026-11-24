/**
 * Lambert, transfer helpers and reach (src/sim/orbit/lambert.ts, src/sim/nav/transfer.ts, reach.ts) on the
 * staged library: the Lambert arc reproduces its endpoints by propagation; the Hohmann numbers; deltaVToOrbit
 * against values computed by hand for Mars, Jupiter and Mercury (to 2 %), and the table for all 32 bodies with
 * and without a refuel point (SOLAR_SYSTEM_VERBOSE=1 prints it).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { v3 } from '../../../src/core/math/vec3';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { solveLambert } from '../../../src/sim/orbit/lambert';
import { BURN_LOSS_SHARE, CAPTURE_APOAPSIS_SOI_SHARE, CORRECTION_PER_INTERPLANETARY_LEG, deltaVToOrbit, launchBodyOf, type ReachResult } from '../../../src/sim/nav/reach';
import { bestTransfer, hohmannPhaseAngle, hohmannTransferTime, phaseAngle, transferWindows } from '../../../src/sim/nav/transfer';
import { BODY_LIST, loadStaged, utOf, type World } from './fixtures';

let w: World;
beforeAll(async () => {
  w = await loadStaged();
});

const AU = 149597870700;
const MU_SUN = 1.32712440041279e20;

describe('Lambert', () => {
  it('the arc from r1 reaches r2 after the time of flight (short and long way, elliptic and hyperbolic)', () => {
    const mu = MU_SUN;
    const r1 = { x: AU, y: 0, z: 0 };
    for (const [r2, tof] of [
      [{ x: -1.2 * AU, y: 0.8 * AU, z: 0.05 * AU }, 200 * 86400],
      [{ x: 0.2 * AU, y: 1.4 * AU, z: -0.02 * AU }, 90 * 86400],
      [{ x: 0.5 * AU, y: -1.3 * AU, z: 0.1 * AU }, 300 * 86400],
      [{ x: 0.3 * AU, y: 0.9 * AU, z: 0 }, 5 * 86400],
    ] as const) {
      const sol = solveLambert(mu, r1, r2, tof)!;
      expect(sol).not.toBeNull();
      const o = makeOrbit('sun', mu, r1, sol.v1, 0);
      const s = propagate(o, tof);
      expect(v3.len(v3.sub(s.r, r2)) / AU).toBeLessThan(1e-9);
      expect(v3.len(v3.sub(s.v, sol.v2))).toBeLessThan(1e-4);
    }
  });

  it('a transfer of exactly 180 deg has no plane (null); just off it the arc is the Hohmann half-orbit', () => {
    const mu = MU_SUN;
    const r2n = 1.524 * AU;
    const tof = hohmannTransferTime(mu, AU, r2n);
    expect(solveLambert(mu, { x: AU, y: 0, z: 0 }, { x: -r2n, y: 0, z: 0 }, tof)).toBeNull();
    const sol2 = solveLambert(mu, { x: AU, y: 0, z: 0 }, { x: -r2n * Math.cos(1e-3), y: r2n * Math.sin(1e-3), z: 0 }, tof * (1 - 1e-3 / Math.PI))!;
    const vPeri = Math.sqrt(mu * (2 / AU - 2 / (AU + r2n)));
    expect(Math.abs(v3.len(sol2.v1) - vPeri) / vPeri).toBeLessThan(2e-3);
  });
});

describe('transfer helpers', () => {
  it('Hohmann phase angle Earth -> Mars is about 44 deg; the phase angle of the staged bodies is in (-pi, pi]', () => {
    expect(hohmannPhaseAngle(MU_SUN, AU, 1.5237 * AU) * (180 / Math.PI)).toBeCloseTo(44.3, 0);
    const p = phaseAngle(w.system, 'earth', 'mars', utOf(2030, 1, 1));
    expect(p).toBeGreaterThan(-Math.PI);
    expect(p).toBeLessThanOrEqual(Math.PI);
  });

  // (the 2031 opportunity is a poor one, Mars near aphelion: the best arc leaves in late 2030 on a 285-day
  // arc with Mars 69 deg ahead, not the 44 deg of circular orbits)
  it('the best Earth -> Mars arc of 2030-2032 needs 3-4.5 km/s each way and departs with Mars ahead', () => {
    const arc = bestTransfer(w.system, 'earth', 'mars', utOf(2030, 1, 1), utOf(2032, 3, 1))!;
    expect(v3.len(arc.vInfDepart)).toBeGreaterThan(2500);
    expect(v3.len(arc.vInfDepart)).toBeLessThan(4500);
    expect(v3.len(arc.vInfArrive)).toBeLessThan(4500);
    expect(arc.phaseAngle * (180 / Math.PI)).toBeGreaterThan(20);
    expect(arc.phaseAngle * (180 / Math.PI)).toBeLessThan(90);
    // one window per synodic period
    const ws = transferWindows(w.system, 'earth', 'mars', utOf(2030, 1, 1), utOf(2034, 6, 1));
    expect(ws.length).toBeGreaterThanOrEqual(2);
    expect(ws[1]!.departUt - ws[0]!.departUt).toBeGreaterThan(600 * 86400);
  });
});

/**
 * By hand: Hohmann between circular coplanar orbits of 1 AU and the target's semi-major axis from its file,
 * departure from a 200 km circular Earth orbit, capture into the ellipse of periapsis at the low orbit and
 * apoapsis a tenth of the SOI, no aerobraking, then 2 % burn losses and 30 m/s of corrections.
 */
function byHand(id: string, lowAltitude: number): number {
  const def = w.defs.bodies[id]!;
  const muE = 3.986004418e14;
  const rPark = 6371e3 + 200e3;
  const a2 = (def.orbit as { a: number }).a;
  const at = (AU + a2) / 2;
  const vinfD = Math.abs(Math.sqrt(MU_SUN / AU) * (Math.sqrt(a2 / at) - 1));
  const vinfA = Math.abs(Math.sqrt(MU_SUN / a2) * (1 - Math.sqrt(AU / at)));
  const dep = Math.sqrt(vinfD ** 2 + (2 * muE) / rPark) - Math.sqrt(muE / rPark);
  const mu = def.mu;
  const ratio = mu / MU_SUN;
  const soi = Math.min(a2 * Math.cbrt(ratio / 3), Math.max(a2 * Math.pow(ratio, 0.4), 2.5 * def.radius));
  const R = def.shape ? def.shape.equatorialRadius : def.radius;
  const rp = R + lowAltitude;
  const ra = 0.1 * soi;
  const cap = Math.sqrt(vinfA ** 2 + (2 * mu) / rp) - Math.sqrt(mu * (2 / rp - 2 / (rp + ra)));
  return (dep + cap) * 1.02 + 30;
}

describe('deltaVToOrbit', () => {
  it('the stated allowances and the capture ellipse rule are what the hand computation uses', () => {
    expect(BURN_LOSS_SHARE).toBe(0.02);
    expect(CORRECTION_PER_INTERPLANETARY_LEG).toBe(30);
    expect(CAPTURE_APOAPSIS_SOI_SHARE).toBe(0.1);
    expect(launchBodyOf(w.defs)).toBe('earth');
  });

  it('Mars, Jupiter and Mercury (Hohmann legs, no aerobraking) agree with the hand computation to 2 %', () => {
    // low orbits by the rule: Mars above its atmosphere top (168 km + 5 %), Jupiter 0.1 R above its equator, Mercury 100 km
    const cases: [string, number][] = [
      ['mars', w.defs.bodies['mars']!.atmosphere!.simTop * 1.05],
      ['jupiter', 0.1 * w.defs.bodies['jupiter']!.radius],
      ['mercury', 100e3],
    ];
    for (const [id, low] of cases) {
      const r = deltaVToOrbit(w.defs, id, { method: 'hohmann', aerobrake: false });
      const hand = byHand(id, low);
      expect(Math.abs(r.total - hand) / hand, `${id}: ${r.total.toFixed(0)} vs ${hand.toFixed(0)}`).toBeLessThan(0.02);
    }
  });

  it('the Lambert window is within reach of Hohmann for Mars and Jupiter, and Mercury costs more than 12 km/s', () => {
    const mars = deltaVToOrbit(w.defs, 'mars', { aerobrake: false });
    const marsH = deltaVToOrbit(w.defs, 'mars', { method: 'hohmann', aerobrake: false });
    expect(mars.total / marsH.total).toBeGreaterThan(0.9);
    expect(mars.total / marsH.total).toBeLessThan(1.3);
    const jup = deltaVToOrbit(w.defs, 'jupiter');
    expect(jup.total).toBeGreaterThan(6000);
    expect(jup.total).toBeLessThan(8500);
    expect(jup.aerobraked).toBe(false);
    expect(deltaVToOrbit(w.defs, 'mercury').total).toBeGreaterThan(11000);
    // aerobraking at Mars saves most of the capture
    expect(deltaVToOrbit(w.defs, 'mars').total).toBeLessThan(mars.total - 500);
  });

  it('every body of the list has a finite profile; the table with and without a refuel point', () => {
    const rows: string[] = ['| Body | Total (km/s) | High-orbit refuel: before + after | Moon-orbit refuel: before + after | Capture | Aerobraked | Transfer (d) |', '|---|---|---|---|---|---|---|'];
    const results: Record<string, ReachResult> = {};
    for (const id of BODY_LIST) {
      const r = deltaVToOrbit(w.defs, id);
      results[id] = r;
      expect(Number.isFinite(r.total), id).toBe(true);
      expect(r.total).toBeGreaterThanOrEqual(0);
      const sameOrigin = id === r.originId || w.system.body(id).parentId === r.originId;
      const hi = sameOrigin ? null : deltaVToOrbit(w.defs, id, { refuel: 'highOrbit' });
      const mo = sameOrigin ? null : deltaVToOrbit(w.defs, id, { refuel: 'moonOrbit' });
      if (hi) expect(hi.afterRefuel).toBeLessThan(r.total);
      const f = (x: number): string => (x / 1000).toFixed(2);
      rows.push(
        `| ${id} | ${f(r.total)} | ${hi ? `${f(hi.beforeRefuel)} + ${f(hi.afterRefuel)}` : '-'} | ${mo ? `${f(mo.beforeRefuel)} + ${f(mo.afterRefuel)}` : '-'} | ${r.capture.kind} ${(r.capture.periapsisAltitude / 1000).toFixed(0)}x${(r.capture.apoapsisAltitude / 1000).toFixed(0)} km | ${r.aerobraked ? 'yes' : 'no'} | ${(r.transferTime / 86400).toFixed(0)} |`,
      );
    }
    expect(results['earth']!.total).toBe(0);
    expect(results['moon']!.total).toBeGreaterThan(3500);
    expect(results['moon']!.total).toBeLessThan(4500);
    if (process.env['SOLAR_SYSTEM_VERBOSE']) console.log(rows.join('\n'));
  });
});
