/**
 * The landmark tests of every baked simple body, in vitest (the bake's verify.py runs the same tests on the
 * tiles at full resolution): heights through the real TerrainProvider (demHeight, craterDepth), albedo on the
 * tile set's low-res global map globals/albedo-lowres.png (albedoContrast, albedoCompare, albedoTexture; a
 * landmark too small for that map, under 3 of its pixels in radius, or 8 for a texture test, is left to
 * verify.py and named in the test title). Then the self-test: the same landmarks on the map mirrored east-west
 * and on the map shifted by 180 degrees must fail, at least one each, or the set could not catch the errors it
 * exists for. data/tiles is git-ignored: each body's block is skipped explicitly (describe.skipIf, keyed on
 * its manifest) where its tile set is absent, as in CI; with PLANET_BAKE_REQUIRE=1 nothing is skipped and a
 * missing tile set fails. The helpers' own tests need tracked files only and run everywhere.
 */
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { PNG } from 'pngjs';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { latLonToDir } from '../../../src/core/geo/cubeSphere';
import { DEG } from '../../../src/core/math/scalar';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider, type TerrainAuthority } from '../../../src/terrain/provider';
import { bodyDefFor, configs, manifestOf, referenceTerm, REPO_ROOT, TILES, type BodyConfig } from './shared';

interface Spot {
  latDeg: number;
  lonDegE: number;
  radiusKm: number;
}

interface FullLandmark {
  name: string;
  kind: 'demHeight' | 'albedoContrast' | 'albedoCompare' | 'albedoTexture' | 'craterDepth';
  latDeg?: number;
  lonDegE?: number;
  expectM?: number;
  toleranceM?: number;
  diameterKm?: number;
  minDepthM?: number;
  radiusKm?: number;
  sense?: 'brighter' | 'darker';
  minRatio?: number;
  brighter?: Spot;
  darker?: Spot;
}

type V3 = { x: number; y: number; z: number };
const cross = (a: V3, b: V3): V3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm = (a: V3): V3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};

/** Directions spread uniformly by area over a cap (or the ring inner..radius), as verify.cap_points. */
function capPoints(latDeg: number, lonDeg: number, radiusM: number, bodyR: number, n: number, innerM = 0): V3[] {
  const c = latLonToDir(latDeg * DEG, lonDeg * DEG);
  let e1 = cross({ x: 0, y: 0, z: 1 }, c);
  if (Math.hypot(e1.x, e1.y, e1.z) < 1e-9) e1 = { x: 1, y: 0, z: 0 };
  e1 = norm(e1);
  const e2 = cross(c, e1);
  const a1 = radiusM / bodyR;
  const a0 = innerM / bodyR;
  const out: V3[] = [];
  for (let i = 0; i < n; i++) {
    const k = i + 0.5;
    const ang = Math.acos(Math.cos(a0) - ((Math.cos(a0) - Math.cos(a1)) * k) / n);
    const th = k * Math.PI * (3 - Math.sqrt(5));
    const s = Math.sin(ang);
    out.push(norm({
      x: Math.cos(ang) * c.x + s * (Math.cos(th) * e1.x + Math.sin(th) * e2.x),
      y: Math.cos(ang) * c.y + s * (Math.cos(th) * e1.y + Math.sin(th) * e2.y),
      z: Math.cos(ang) * c.z + s * (Math.cos(th) * e1.z + Math.sin(th) * e2.z),
    }));
  }
  return out;
}

/** Luminance of the low-res global albedo (equirect, column 0 at 180 W, row 0 at the north pole), linear. */
class LowRes {
  readonly w: number;
  readonly h: number;
  private readonly lum: Float64Array;

  constructor(id: string) {
    const png = PNG.sync.read(readFileSync(path.join(TILES, id, 'globals', 'albedo-lowres.png')));
    this.w = png.width;
    this.h = png.height;
    this.lum = new Float64Array(png.width * png.height);
    const lin = (v: number): number => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
    for (let i = 0; i < this.lum.length; i++) {
      const r = lin(png.data[4 * i]! / 255);
      const g = lin(png.data[4 * i + 1]! / 255);
      const b = lin(png.data[4 * i + 2]! / 255);
      this.lum[i] = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    }
  }


  at(d: V3): number {
    const lat = Math.asin(Math.max(-1, Math.min(1, d.z))) / DEG;
    const lon = Math.atan2(d.y, d.x) / DEG;
    const x = Math.min(this.w - 1, Math.floor((((lon + 180) % 360) + 360) % 360 / 360 * this.w));
    const y = Math.min(this.h - 1, Math.floor(((90 - lat) / 180) * this.h));
    return this.lum[y * this.w + x]!;
  }

  mean(ds: V3[]): number {
    return ds.reduce((s, d) => s + this.at(d), 0) / ds.length;
  }

  std(ds: V3[]): number {
    const m = this.mean(ds);
    return Math.sqrt(ds.reduce((s, d) => s + (this.at(d) - m) ** 2, 0) / ds.length);
  }
}

/** The smallest radius (km) a landmark samples on the albedo map, or null for a height landmark. */
function albedoRadiusKm(l: FullLandmark): number | null {
  if (l.kind === 'albedoCompare') return Math.min(l.brighter!.radiusKm, l.darker!.radiusKm);
  if (l.kind === 'albedoContrast' || l.kind === 'albedoTexture') return l.radiusKm!;
  return null;
}

/** Rows of globals/albedo-lowres.png (1024 x 512, planet-bake's albedo.lowres; checked when the map is read). */
const LOWRES_H = 512;

function resolvable(l: FullLandmark, c: BodyConfig): boolean {
  const r = albedoRadiusKm(l);
  if (r === null) return true;
  const px = ((r * 1000) / c.radii.mean / DEG) * (LOWRES_H / 180);
  return px >= (l.kind === 'albedoTexture' ? 8 : 3);
}

function moved(l: FullLandmark, fn: (lon: number) => number): FullLandmark {
  const out: FullLandmark = { ...l };
  if (l.lonDegE !== undefined) out.lonDegE = fn(l.lonDegE);
  if (l.brighter) out.brighter = { ...l.brighter, lonDegE: fn(l.brighter.lonDegE) };
  if (l.darker) out.darker = { ...l.darker, lonDegE: fn(l.darker.lonDegE) };
  return out;
}

async function holds(l: FullLandmark, c: BodyConfig, tp: TerrainAuthority, map: LowRes): Promise<{ ok: boolean; detail: string }> {
  const R = c.radii.mean;
  const dataAt = async (ds: V3[]): Promise<number> => {
    let s = 0;
    for (const d of ds) {
      await tp.ensureLoaded(c.id, d, 1000, 'landmark');
      s += tp.heightParts(c.id, d, 1).data - referenceTerm(c, d);
    }
    return s / ds.length;
  };
  switch (l.kind) {
    case 'demHeight': {
      const h = await dataAt([latLonToDir(l.latDeg! * DEG, l.lonDegE! * DEG)]);
      return { ok: Math.abs(h - l.expectM!) <= l.toleranceM!, detail: `${h.toFixed(0)} m, expected ${l.expectM} +- ${l.toleranceM}` };
    }
    case 'craterDepth': {
      const rr = l.diameterKm! * 500;
      const hc = await dataAt(capPoints(l.latDeg!, l.lonDegE!, rr * 0.15, R, 50));
      const hm = await dataAt(capPoints(l.latDeg!, l.lonDegE!, rr * 1.05, R, 200, rr * 0.95));
      return { ok: hm - hc >= l.minDepthM!, detail: `depth ${(hm - hc).toFixed(0)} m >= ${l.minDepthM}` };
    }
    case 'albedoContrast': {
      const r = l.radiusKm! * 1000;
      const inner = map.mean(capPoints(l.latDeg!, l.lonDegE!, r, R, 600));
      const ring = map.mean(capPoints(l.latDeg!, l.lonDegE!, 2 * r, R, 600, r));
      const ratio = l.sense === 'brighter' ? inner / ring : ring / inner;
      return { ok: ratio >= l.minRatio!, detail: `ratio ${ratio.toFixed(3)} >= ${l.minRatio}` };
    }
    case 'albedoTexture': {
      const r = l.radiusKm! * 1000;
      const ratio = map.std(capPoints(l.latDeg!, l.lonDegE!, r, R, 1200)) / Math.max(1e-9, map.std(capPoints(l.latDeg!, l.lonDegE!, 2 * r, R, 1200, r)));
      return { ok: ratio >= l.minRatio!, detail: `texture ratio ${ratio.toFixed(3)} >= ${l.minRatio}` };
    }
    case 'albedoCompare': {
      const b = l.brighter!;
      const d = l.darker!;
      const ratio = map.mean(capPoints(b.latDeg, b.lonDegE, b.radiusKm * 1000, R, 600)) / map.mean(capPoints(d.latDeg, d.lonDegE, d.radiusKm * 1000, R, 600));
      return { ok: ratio >= l.minRatio!, detail: `ratio ${ratio.toFixed(3)} >= ${l.minRatio}` };
    }
  }
}

const REQUIRE = process.env['PLANET_BAKE_REQUIRE'] === '1';
const withLandmarks = configs().filter((c) => c.kind === 'solid' && (c.landmarks ?? []).length > 0);
const isBaked = (id: string): boolean => existsSync(path.join(TILES, id, 'manifest.json'));

let base: DefLibrary;
beforeAll(async () => {
  base = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data/defs')));
});

describe('planet-bake landmark helpers (tracked files only)', () => {
  it('cap points lie in the cap (or ring) and spread evenly by area', () => {
    const R = 1000e3;
    const c = latLonToDir(30 * DEG, 40 * DEG);
    const pts = capPoints(30, 40, 100e3, R, 2000, 50e3);
    const ang = pts.map((d) => Math.acos(Math.min(1, d.x * c.x + d.y * c.y + d.z * c.z)) * R);
    expect(Math.min(...ang)).toBeGreaterThanOrEqual(50e3 - 1);
    expect(Math.max(...ang)).toBeLessThanOrEqual(100e3 + 1);
    // equal area: half the points within the radius that halves the ring's area
    const rHalf = Math.acos(0.5 * (Math.cos(50e3 / R) + Math.cos(100e3 / R))) * R;
    expect(Math.abs(ang.filter((a) => a < rHalf).length / pts.length - 0.5)).toBeLessThan(0.01);
  });

  it('the mirrored and shifted landmarks move every longitude they name', () => {
    const l: FullLandmark = { name: 'x', kind: 'albedoCompare', minRatio: 1.1, brighter: { latDeg: 10, lonDegE: 30, radiusKm: 5 }, darker: { latDeg: -5, lonDegE: 300, radiusKm: 5 } };
    const m = moved(l, (lon) => -lon);
    expect([m.brighter!.lonDegE, m.darker!.lonDegE]).toEqual([-30, -300]);
    const p = moved({ name: 'y', kind: 'demHeight', latDeg: 1, lonDegE: 20, expectM: 0, toleranceM: 1 }, (lon) => lon + 180);
    expect(p.lonDegE).toBe(200);
    expect(p.latDeg).toBe(1);
  });

  it('every configured landmark is of a known kind', () => {
    const kinds = new Set(['demHeight', 'albedoContrast', 'albedoCompare', 'albedoTexture', 'craterDepth']);
    for (const c of withLandmarks) for (const l of c.landmarks!) expect(kinds.has(l.kind), `${c.id}: ${l.name}`).toBe(true);
  });
});

describe('planet-bake landmarks', () => {
  for (const c of withLandmarks) {
    const all = (c.landmarks ?? []) as FullLandmark[];
    const used = all.filter((l) => resolvable(l, c));
    const left = all.filter((l) => !resolvable(l, c)).map((l) => l.name);
    const suffix = left.length ? ` (left to verify.py, too small for the low-res map: ${left.join(', ')})` : '';

    describe.skipIf(!REQUIRE && !isBaked(c.id))(`${c.id} (baked tile set, data/tiles/${c.id})`, () => {
      let map: LowRes;
      const provider = async (): Promise<TerrainAuthority> => {
        const defs: DefLibrary = { ...base, bodies: { [c.id]: bodyDefFor(c, manifestOf(c.id)!) }, rootBodyId: c.id };
        return createTerrainProvider(defs, createFsTileSource(TILES), { bodies: [c.id] });
      };
      beforeAll(() => {
        expect(manifestOf(c.id), `data/tiles/${c.id}/manifest.json`).not.toBeNull();
        map = new LowRes(c.id);
        expect([map.w, map.h]).toEqual([2 * LOWRES_H, LOWRES_H]);
      });

      it(`${c.id}: the landmarks hold${suffix}`, { timeout: 300_000 }, async () => {
        const tp = await provider();
        for (const l of used) {
          const r = await holds(l, c, tp, map);
          expect(r.ok, `${l.name}: ${r.detail}`).toBe(true);
        }
      });

      it.skipIf(used.length === 0)(`${c.id}: the landmarks fail on the map mirrored east-west and on the map shifted by 180 degrees`, { timeout: 300_000 }, async () => {
        const tp = await provider();
        for (const [label, fn] of [['mirrored', (lon: number) => -lon], ['shifted by 180 deg', (lon: number) => lon + 180]] as const) {
          let fails = 0;
          for (const l of used) if (!(await holds(moved(l, fn), c, tp, map)).ok) fails++;
          expect(fails, `${c.id}: no landmark fails on the map ${label}`).toBeGreaterThan(0);
        }
      });
    });
  }
});
