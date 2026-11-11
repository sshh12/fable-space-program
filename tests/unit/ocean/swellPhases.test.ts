/**
 * The float64 phase preparation of the shared swell: the GPU evaluation (emulated operation by operation in
 * float32) equals oceanSwellHeight anywhere on the planet, at any mission time, for points out to fadeEnd
 * from the reference point - and a naive float32 evaluation of the same formula does not.
 */
import { describe, expect, it } from 'vitest';
import { fsDefSource } from '@/core/defs/fsSource';
import { loadDefs } from '@/core/defs/loader';
import { oceanSwellHeight, type SwellComponent } from '@/core/geo/oceanSwell';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { DEG, Prng, v3 } from '@/core/math';
import { anchorChart, chartCoords, chartReference, sphereOffset } from '@/render/ocean/nearField';
import { oceanTunables } from '@/render/ocean/params';
import { prepareSwell, swellHeightF32 } from '@/render/ocean/swell';

const defs = await loadDefs(fsDefSource());
const earth = Object.values(defs.bodies).find((b) => b.ocean !== null)!;
const t = oceanTunables(earth)!;

function naiveF32(swell: readonly SwellComponent[], g: number, R: number, n: { x: number; y: number; z: number }, time: number): number {
  const f = Math.fround;
  let eta = 0;
  for (const c of swell) {
    const dn = f(f(f(c.dir[0] * n.x) + f(c.dir[1] * n.y)) + f(c.dir[2] * n.z));
    const k = f((2 * Math.PI) / c.wavelength);
    const ph = f(f(f(k * f(R)) * dn) - f(f(Math.sqrt(g * k)) * f(time)) + f(c.phase));
    const sinAng = Math.sqrt(Math.max(0, 1 - dn * dn));
    const x = Math.min(1, Math.max(0, (sinAng - 0.15) / 0.35));
    eta = f(eta + f(c.amplitude * x * x * (3 - 2 * x) * Math.cos(ph)));
  }
  return eta;
}

describe('ocean swell phase preparation (float64 on the CPU, float32 on the GPU)', () => {
  it('reproduces oceanSwellHeight within 1 mm at 2000 points anywhere on Earth, out to 30 km, at mission times', () => {
    const rng = new Prng(11);
    let worst = 0;
    let worstNaive = 0;
    for (let s = 0; s < 40; s++) {
      const lat = (rng.next() * 2 - 1) * 80;
      const lon = (rng.next() * 2 - 1) * 180;
      const nadir = latLonToDir(lat * DEG, lon * DEG);
      const chart = anchorChart(nadir, t.seaRadius);
      const ref = chartReference(chart, nadir);
      const time = 9.38e8 + rng.next() * 1.2e6;
      const prep = prepareSwell(t.swell, t.gravity, t.seaRadius, ref.cHat, time);
      for (let k = 0; k < 50; k++) {
        const r = Math.sqrt(rng.next()) * t.fadeEnd;
        const a = rng.next() * 2 * Math.PI;
        const u = r * Math.cos(a);
        const v = r * Math.sin(a);
        const delta = sphereOffset(chart, ref, u, v);
        const n = v3.normalize(v3.add(ref.cHat, v3.scale(delta, 1 / t.seaRadius)));
        const exact = oceanSwellHeight(t.swell, t.gravity, t.seaRadius, n, time);
        const gpu = swellHeightF32(prep, t.seaRadius, delta);
        worst = Math.max(worst, Math.abs(gpu - exact));
        worstNaive = Math.max(worstNaive, Math.abs(naiveF32(t.swell, t.gravity, t.seaRadius, n, time) - exact));
      }
    }
    expect(worst).toBeLessThan(1e-3);
    // The naive float32 phase (k R (d.n) ~ 1e6 rad, omega t ~ 1e9 rad) is meaningless: errors of the order of the amplitude.
    expect(worstNaive).toBeGreaterThan(0.1);
  });

  it('reduces the phase exactly: the prepared phase lies in [0, 2 pi) and equals the float64 phase modulo 2 pi', () => {
    const nadir = latLonToDir(19 * DEG, -155.6 * DEG);
    const time = 938240818.84;
    const p = prepareSwell(t.swell, t.gravity, t.seaRadius, nadir, time);
    t.swell.forEach((c, i) => {
      const k = (2 * Math.PI) / c.wavelength;
      const dc = c.dir[0] * nadir.x + c.dir[1] * nadir.y + c.dir[2] * nadir.z;
      const full = k * t.seaRadius * dc - Math.sqrt(t.gravity * k) * time + c.phase;
      const ph = p.ampPhase[i * 4 + 1]!;
      expect(ph).toBeGreaterThanOrEqual(0);
      expect(ph).toBeLessThan(2 * Math.PI + 1e-6);
      expect(Math.abs(Math.cos(ph) - Math.cos(full))).toBeLessThan(1e-6);
    });
  });

  it('sphere offsets from the chart are cancellation-free (float64 against the direct difference)', () => {
    const nadir = latLonToDir(8 * DEG, -146 * DEG);
    const chart = anchorChart(nadir, t.seaRadius);
    const ref = chartReference(chart, nadir);
    for (const [u, v] of [
      [0.01, 0],
      [3, -4],
      [1200, 800],
      [-21000, 21000],
    ] as const) {
      const d = sphereOffset(chart, ref, u, v);
      const xy = chartCoords(chart, v3.normalize(v3.add(ref.cHat, v3.scale(d, 1 / t.seaRadius))))!;
      expect(Math.abs(xy.x - ref.x - u)).toBeLessThan(1e-6 * Math.max(1, Math.hypot(u, v)));
      expect(Math.abs(xy.y - ref.y - v)).toBeLessThan(1e-6 * Math.max(1, Math.hypot(u, v)));
      // The gnomonic chart is isometric only at its anchor: the scale error grows as (distance / R)^2.
      const fromAnchor = Math.hypot(ref.x, ref.y) + Math.hypot(u, v);
      expect(Math.abs(v3.len(d) - Math.hypot(u, v))).toBeLessThan(((fromAnchor / t.seaRadius) ** 2 * 1.5 + 1e-7) * Math.hypot(u, v));
    }
  });
});
