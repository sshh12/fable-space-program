/**
 * Launch-pad flattening (flattenDisc derived from LaunchSiteDef): flat for physics and rendering, smooth
 * blend to natural terrain, 'terrain' elevation sampled from final data, numeric elevation respected.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { dirToTile } from '../../../src/core/geo/cubeSphere';
import type { TerrainAuthority } from '../../../src/terrain/provider';
import { buildFlattenDiscs, discWeight } from '../../../src/terrain/modifiers';
import { loadDefs } from '../../../src/core/defs/loader';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { padLocationOf, padsOf, SINGLE_PAD_ID } from '../../../src/core/defs/sites';
import type { LaunchSiteDef, PadDef } from '../../../src/core/contracts/defs';
import { latLonToDir } from '../../../src/core/geo/cubeSphere';
import { DEG } from '../../../src/core/math/scalar';
import { EARTH_R, FIXTURE_POINTS } from '../../../tools/terrain-core/fixtures';
import { fixtureProvider, offset, prng } from './helpers';

const pad = FIXTURE_POINTS.padDir;

describe('launch pad', () => {
  let tp: TerrainAuthority;
  let elevation: number;

  beforeAll(async () => {
    tp = (await fixtureProvider({ bodies: ['earth'] })).tp;
    await tp.ensureLoaded('earth', pad, 1500, 'pad');
    // 'terrain' = the natural data height at the centre (final data, no procedural detail).
    const natural = (await fixtureProvider({ bodies: ['earth'], model: 'none' })).tp;
    await natural.ensureLoaded('earth', pad, 10, 'pad');
    elevation = tp.heightAt('earth', pad, 1);
    expect(elevation).toBeCloseTo(natural.heightParts('earth', pad, 1e-3).data, 9);
    // The collision surface stores Float32 vertices (the baked mesh format).
    expect(Math.abs(tp.heightAt('earth', pad) - elevation)).toBeLessThan(1e-4);
  }, 120_000);

  it('is flat within 5 cm over flatRadius on the collision surface and at every band limit', () => {
    const rng = prng(21);
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const r = 445 * Math.sqrt(rng.next());
      const a = rng.range(0, 2 * Math.PI);
      const d = offset(pad, r * Math.cos(a), r * Math.sin(a), EARTH_R);
      for (const lam of [undefined, 0.3, 5, 300]) worst = Math.max(worst, Math.abs(tp.heightAt('earth', d, lam) - elevation));
    }
    console.log(`[pad] max deviation from the pad elevation (${elevation.toFixed(3)} m) inside 445 m: ${worst.toExponential(2)} m`);
    expect(worst).toBeLessThan(0.05);
  });

  it('the baked max-level geometry on the pad is flat too', async () => {
    const key = dirToTile(pad, 20).key;
    await tp.prepareTile('earth', key);
    const g = tp.bakeGeometry('earth', key);
    expect(g.hMax - g.hMin).toBeLessThan(0.05);
    expect(Math.abs(g.hMin - elevation)).toBeLessThan(0.05);
  });

  it('blends smoothly back to natural terrain between flatRadius and blendRadius', () => {
    const smooth = (x: number): number => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));
    for (const az of [0, 1.3, 2.9, 4.4]) {
      for (let r = 450; r <= 900; r += 7) {
        const d = offset(pad, r * Math.cos(az), r * Math.sin(az), EARTH_R);
        const p = tp.heightParts('earth', d, 1);
        // Great-circle distance of the sample from the pad centre.
        const c = d.x * pad.x + d.y * pad.y + d.z * pad.z;
        const dist = EARTH_R * Math.acos(Math.min(1, c));
        const w = 1 - smooth((dist - 450) / 450);
        const nat = p.data + p.amplification;
        expect(p.height).toBeCloseTo(nat + w * (elevation - nat), 4);
      }
      // Beyond blendRadius the surface is natural (amplification present again).
      const d = offset(pad, 960 * Math.cos(az), 960 * Math.sin(az), EARTH_R);
      const parts = tp.heightParts('earth', d, 0.3);
      expect(parts.height).toBeCloseTo(parts.data + parts.amplification, 9);
    }
  });

  it('a numeric pad elevation is used as given', async () => {
    const p = (await fixtureProvider({ bodies: ['earth'], padElevation: 123.5 })).tp;
    await p.ensureLoaded('earth', pad, 600, 'pad');
    expect(p.heightAt('earth', pad)).toBe(123.5);
    expect(p.heightAt('earth', offset(pad, 300, -200, EARTH_R), 2)).toBe(123.5);
  });
});

describe('launch pad with a shape (request terrain-render-6)', () => {
  // The hardstand core, one turned area, a quarter of the natural relief elsewhere inside 450 m.
  const shape = {
    coreRadius: 110,
    coreBlend: 40,
    reliefShare: 0.25,
    areas: [{ east: -250, north: 150, halfEast: 40, halfNorth: 25, headingDeg: 30, blend: 25 }],
    edgeNoise: { amplitude: 0.6, wavelength: 60 },
  };
  let tp: TerrainAuthority;
  let elevation: number;
  beforeAll(async () => {
    tp = (await fixtureProvider({ bodies: ['earth'], padShape: shape })).tp;
    await tp.ensureLoaded('earth', pad, 1500, 'pad');
    elevation = tp.heightAt('earth', pad, 1);
  }, 120_000);

  it('is exactly flat inside the core and on the areas, on the collision surface too', () => {
    const rng = prng(5);
    let worst = 0;
    for (let i = 0; i < 600; i++) {
      const r = 108 * Math.sqrt(rng.next());
      const a = rng.range(0, 2 * Math.PI);
      worst = Math.max(worst, Math.abs(tp.heightAt('earth', offset(pad, r * Math.cos(a), r * Math.sin(a), EARTH_R), 1) - elevation));
    }
    // The area, turned 30 deg clockwise: points inside its rectangle.
    const h = (30 * Math.PI) / 180;
    for (let i = 0; i < 300; i++) {
      const u = rng.range(-39, 39);
      const v = rng.range(-24, 24);
      // Local east axis (cos h, -sin h), local north axis (sin h, cos h) in (east, north).
      const e = -250 + u * Math.cos(h) + v * Math.sin(h);
      const n = 150 - u * Math.sin(h) + v * Math.cos(h);
      worst = Math.max(worst, Math.abs(tp.heightAt('earth', offset(pad, e, n, EARTH_R), 1) - elevation));
    }
    expect(worst).toBeLessThan(1e-6);
    expect(Math.abs(tp.heightAt('earth', offset(pad, 30, -40, EARTH_R)) - elevation)).toBeLessThan(1e-4);
  });

  it('keeps reliefShare of the natural relief on the rest of the disc, and is natural from blendRadius on', () => {
    const fixture = { flatRadius: 450, blendRadius: 900 };
    const rng = prng(9);
    const ratios: number[] = [];
    for (let i = 0; i < 400; i++) {
      const r = rng.range(200, 430);
      const a = rng.range(0, 2 * Math.PI);
      const e = r * Math.cos(a);
      const n = r * Math.sin(a);
      if (Math.hypot(e + 250, n - 150) < 120) continue; // clear of the area and its blend
      const d = offset(pad, e, n, EARTH_R);
      const p = tp.heightParts('earth', d, 1);
      const nat = p.data + p.amplification;
      if (Math.abs(nat - elevation) < 0.2) continue;
      ratios.push((p.height - elevation) / (nat - elevation));
    }
    expect(ratios.length).toBeGreaterThan(20);
    for (const q of ratios) expect(q).toBeCloseTo(0.25, 6);
    // Beyond blendRadius: natural.
    for (const az of [0, 1.7, 3.3, 5.0]) {
      const p = tp.heightParts('earth', offset(pad, (fixture.blendRadius + 5) * Math.cos(az), (fixture.blendRadius + 5) * Math.sin(az), EARTH_R), 0.3);
      expect(p.height).toBeCloseTo(p.data + p.amplification, 9);
    }
  });

  it('has ragged edges: the disc does not end on a circle', () => {
    // Along the ring 700 m out (in the disc's blend: a nominal weight of 0.75 x 0.43) the weight varies with
    // the azimuth, and stays between 0 and the floor.
    const weights: number[] = [];
    for (let k = 0; k < 72; k++) {
      const az = (k / 72) * 2 * Math.PI;
      const d = offset(pad, 700 * Math.cos(az), 700 * Math.sin(az), EARTH_R);
      const p = tp.heightParts('earth', d, 1);
      const nat = p.data + p.amplification;
      if (Math.abs(nat - elevation) < 0.2) continue;
      weights.push(1 - (p.height - elevation) / (nat - elevation));
    }
    expect(weights.length).toBeGreaterThan(10);
    const mean = weights.reduce((a, b) => a + b, 0) / weights.length;
    const sd = Math.sqrt(weights.reduce((a, b) => a + (b - mean) ** 2, 0) / weights.length);
    expect(sd).toBeGreaterThan(0.04);
    for (const w of weights) {
      expect(w).toBeGreaterThanOrEqual(-1e-9);
      expect(w).toBeLessThanOrEqual(0.75 + 1e-9);
    }
  });
});

describe("the repository's launch sites", () => {
  it('build their flatten shapes (validation) and level the core and every area exactly', async () => {
    const defs = await loadDefs(fsDefSource());
    for (const body of Object.values(defs.bodies)) {
      if (!body.terrain) continue;
      const sites = Object.values(defs.sites).filter((s) => s.bodyId === body.id);
      const discs = buildFlattenDiscs(body, sites);
      // One disc per pad of every site, and no other.
      expect(discs.length).toBe(body.terrain.modifiers.length + sites.reduce((n, s) => n + padsOf(s).length, 0));
      for (const s of sites) {
        for (const p of padsOf(s)) {
          const disc = discs.find((d) => d.source === `sites/${s.id}.json pad "${p.id}"`)!;
          const where = padLocationOf(s, p.id);
          const centre = latLonToDir(where.latDeg * DEG, where.lonDeg * DEG);
          expect({ x: disc.cx, y: disc.cy, z: disc.cz }).toEqual({ x: centre.x, y: centre.y, z: centre.z });
          expect(disc.flatRadius).toBe(p.flatRadius);
          expect(disc.blendRadius).toBe(p.blendRadius);
          const at = (east: number, north: number): number => {
            const d = offset(centre, east, north, body.radius);
            return discWeight(disc, d.x, d.y, d.z, body.radius);
          };
          expect(at(0, 0)).toBe(1);
          if (!p.shape) continue;
          expect(at(0.9 * p.shape.coreRadius, 0)).toBe(1);
          for (const a of p.shape.areas) expect(at(a.east, a.north)).toBe(1);
          expect(at(p.blendRadius + 1, 0)).toBe(0);
        }
      }
    }
  });
});

describe('flatten discs are derived from the pads of a site', () => {
  const body = { id: 'b', radius: 1_000_000, terrain: { modifiers: [] } } as unknown as Parameters<typeof buildFlattenDiscs>[0];
  const pad = (id: string, flatRadius: number, blendRadius: number): PadDef => ({
    id, name: id, offsetEnu: [0, 0], azimuthDeg: 90, class: 'light', maxLiftoffMass: 1, maxDiameter: 1, flatRadius, blendRadius, mountHeight: 2, structures: [],
  });
  const single: LaunchSiteDef = {
    id: 'one', name: 'One', bodyId: 'b', location: { latDeg: 10, lonDeg: 20, padElevation: 30 },
    padAzimuthDeg: 90, pad: { flatRadius: 100, blendRadius: 250, clampHeight: 3 }, structures: [], recoveryZones: [],
  };
  const many: LaunchSiteDef = {
    ...single,
    id: 'many',
    location: { latDeg: 10, lonDeg: 20, padElevation: 30, pads: { north: { latDeg: 10.2, lonDeg: 20.1, padElevation: 44 }, south: { latDeg: 9.7, lonDeg: 20, padElevation: 'terrain' } } },
    pads: [pad('first', 100, 250), pad('north', 60, 140), pad('south', 80, 200)],
  };

  it('one disc per pad at the pad location: the first at the reference point, the others at their resolved coordinates', () => {
    const discs = buildFlattenDiscs(body, [many]);
    expect(discs.map((d) => d.source)).toEqual(['sites/many.json pad "first"', 'sites/many.json pad "north"', 'sites/many.json pad "south"']);
    const dirOf = (latDeg: number, lonDeg: number) => { const d = latLonToDir(latDeg * DEG, lonDeg * DEG); return { cx: d.x, cy: d.y, cz: d.z }; };
    expect(discs[0]).toMatchObject({ ...dirOf(10, 20), flatRadius: 100, blendRadius: 250, elevation: 30, sample: false });
    expect(discs[1]).toMatchObject({ ...dirOf(10.2, 20.1), flatRadius: 60, blendRadius: 140, elevation: 44, sample: false });
    expect(discs[2]).toMatchObject({ ...dirOf(9.7, 20), flatRadius: 80, blendRadius: 200, sample: true });
    // Each disc levels its own pad and nothing at another pad (they are 20 km and more apart here).
    const centre = (i: number) => ({ x: discs[i]!.cx, y: discs[i]!.cy, z: discs[i]!.cz });
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        const c = centre(j);
        expect(discWeight(discs[i]!, c.x, c.y, c.z, body.radius)).toBe(i === j ? 1 : 0);
      }
    }
  });

  it('a site that states the single pad only has that one disc; sites in id order, pads in their order', () => {
    const discs = buildFlattenDiscs(body, [single, many]);
    expect(discs.map((d) => d.source)).toEqual([
      'sites/many.json pad "first"', 'sites/many.json pad "north"', 'sites/many.json pad "south"', `sites/one.json pad "${SINGLE_PAD_ID}"`,
    ]);
    expect(discs[3]).toMatchObject({ flatRadius: 100, blendRadius: 250, elevation: 30 });
  });

  it('a pad after the first without resolved coordinates is refused by name', () => {
    const unresolved: LaunchSiteDef = { ...many, location: { latDeg: 10, lonDeg: 20, padElevation: 30, pads: { north: { latDeg: 10.2, lonDeg: 20.1, padElevation: 44 } } } };
    expect(() => buildFlattenDiscs(body, [unresolved])).toThrow('sites/many.json: pad "south" has no resolved coordinates');
  });
});
