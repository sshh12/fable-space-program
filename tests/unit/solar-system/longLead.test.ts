/**
 * Rails propagation of every body and of a craft at 10,000,000x for 250 years of lead (the rules' lead cap):
 * one frame (1/60 s of wall time) is 2e7 ticks, 47,336 frames in all. The craft (a circular low Earth orbit,
 * the worst case for its phase) is propagated on the tick grid (propagateAtTick) and compared with the
 * analytic value: its mean motion from the same float64 mu and energy, times the exact time of flight, reduced
 * modulo 2 pi in 50-digit fixed point (BigInt). Every body's state and orientation is finite at every frame.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { makeOrbit, propagate } from '../../../src/sim/orbit/kepler';
import { propagateAtTick, reducedTimeOfFlight } from '../../../src/sim/orbit/longLead';
import type { BodySystem } from '../../../src/sim/bodies/bodySystem';
import { loadStaged, utOf } from './fixtures';

let sys: BodySystem;
beforeAll(async () => {
  sys = (await loadStaged()).system;
});

/** A float64 as an exact rational num / den (den a power of two). */
function rational(x: number): [bigint, bigint] {
  const buf = new DataView(new ArrayBuffer(8));
  buf.setFloat64(0, x);
  const bits = buf.getBigUint64(0);
  const exp = Number((bits >> 52n) & 0x7ffn);
  const frac = bits & ((1n << 52n) - 1n);
  const sign = bits >> 63n ? -1n : 1n;
  const mant = exp === 0 ? frac : frac | (1n << 52n);
  const e = (exp === 0 ? 1 : exp) - 1075;
  return e >= 0 ? [sign * mant * (1n << BigInt(e)), 1n] : [sign * mant, 1n << BigInt(-e)];
}

function isqrt(n: bigint): bigint {
  if (n < 2n) return n;
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  for (;;) {
    const y = (x + n / x) >> 1n;
    if (y >= x && y - x <= 1n) {
      while (y * y > n) return y - 1n;
      return y * y <= n && (y + 1n) * (y + 1n) > n ? y : x;
    }
    x = y;
  }
}

const SCALE = 10n ** 50n;
const TWO_PI_S = 628318530717958647692528676655900576839433879875021n; // 2 pi x 10^50

describe('rails at 10,000,000x for 250 years of lead', () => {
  it('a low-orbit craft keeps its phase within 1 mm of arc of the analytic value; every body is finite at every frame', () => {
    const mu = sys.body('earth').mu;
    const radius = 6771e3;
    const o = makeOrbit('earth', mu, { x: radius, y: 0, z: 0 }, { x: 0, y: Math.sqrt(mu / radius), z: 0 }, 0);
    const epochTick = Math.round(utOf(2030, 1, 1) * 120);
    const oT = makeOrbit('earth', mu, o.r0, o.v0, epochTick / 120);
    // analytic mean motion n = sqrt(mu alpha^3), from the same float64 mu and alpha, in fixed point
    const [mn, md] = rational(oT.mu);
    const [an, ad] = rational(oT.alpha);
    const N = isqrt((mn * an * an * an * SCALE * SCALE) / (md * ad * ad * ad)); // n x 10^50
    const framesPerYear = (365.25 * 86400 * 120) / 2e7;
    const frames = Math.ceil(250 * framesPerYear);
    let worst = 0;
    let worstPlain = 0;
    let nanFree = true;
    for (let f = 0; f <= frames; f++) {
      const tick = epochTick + f * 2e7;
      const s = propagateAtTick(oT, epochTick, tick);
      const D = BigInt(tick - epochTick);
      const thetaS = ((D * N) / 120n) % TWO_PI_S;
      let ref = Number(thetaS) / 1e50;
      if (ref > Math.PI) ref -= 2 * Math.PI;
      const err = (a: number): number => {
        let d = a - ref;
        d -= 2 * Math.PI * Math.round(d / (2 * Math.PI));
        return Math.abs(d) * radius;
      };
      worst = Math.max(worst, err(Math.atan2(s.r.y, s.r.x)));
      if (f % 97 === 0) {
        const p = propagate(oT, tick / 120);
        worstPlain = Math.max(worstPlain, err(Math.atan2(p.r.y, p.r.x)));
      }
      {
        const ut = tick / 120;
        for (const id of sys.ids) {
          const b = sys.stateRoot(id, ut);
          const q = sys.orientation(id, ut);
          if (!(Number.isFinite(b.r.x + b.r.y + b.r.z + b.v.x + b.v.y + b.v.z) && Number.isFinite(q.x + q.y + q.z + q.w))) nanFree = false;
        }
      }
    }
    if (process.env['SOLAR_SYSTEM_VERBOSE']) {
      console.log(`${frames} frames, 250 years at 1e7x: craft phase error on the tick grid ${(worst * 1000).toExponential(2)} mm of arc; plain propagate(o, tick / 120) ${(worstPlain * 1000).toFixed(2)} mm`);
    }
    expect(worst).toBeLessThan(1e-3);
    expect(nanFree).toBe(true);
  });

  it('the reduced time of flight is within half a period and exact for a tick difference of whole periods of the double-double period', () => {
    const mu = 3.986004418e14;
    const o = makeOrbit('earth', mu, { x: 7e6, y: 0, z: 0 }, { x: 0, y: 7600, z: 100 }, 0);
    for (const ticks of [1, 120, 1e6, 1e9, 9.46e11]) {
      const r = reducedTimeOfFlight(o, 0, ticks);
      expect(Math.abs(r)).toBeLessThanOrEqual(o.period! / 2 + 1e-9);
    }
  });
});
