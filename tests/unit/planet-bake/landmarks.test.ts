/**
 * The landmark tests of every baked simple body, in vitest (the bake's verify.py runs the same tests on the
 * tiles at full resolution): heights through the real TerrainProvider (demHeight, craterDepth), albedo on the
 * tile set's low-res global map globals/albedo-lowres.png (albedoContrast, albedoCompare, albedoTexture; a
 * landmark too small for that map, under 3 of its pixels in radius, or 8 for a texture test, is left to
 * verify.py and named in the test title). Then the self-test: the same landmarks on the map mirrored east-west
 * and on the map shifted by 180 degrees must fail, at least one each, or the set could not catch the errors it
 * exists for. Runs for the tile sets present under data/tiles (git-ignored data).
 */
import { readFileSync } from 'node:fs';
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

  /** Pixels per degree of latitude. */
  get pxPerDeg(): number {
    return this.h / 180;
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

function resolvable(l: FullLandmark, c: BodyConfig, map: LowRes): boolean {
  const r = albedoRadiusKm(l);
  if (r === null) return true;
  const px = ((r * 1000) / c.radii.mean / DEG) * map.pxPerDeg;
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

const baked = configs().filter((c) => c.kind === 'solid' && manifestOf(c.id) !== null && (c.landmarks ?? []).length > 0);

let base: DefLibrary;
beforeAll(async () => {
  base = await loadDefs(fsDefSource(path.join(REPO_ROOT, 'data/defs')));
});

describe('planet-bake landmarks', () => {
  for (const c of baked) {
    const map = new LowRes(c.id);
    const all = (c.landmarks ?? []) as FullLandmark[];
    const used = all.filter((l) => resolvable(l, c, map));
    const left = all.filter((l) => !resolvable(l, c, map)).map((l) => l.name);
    const provider = async (): Promise<TerrainAuthority> => {
      const defs: DefLibrary = { ...base, bodies: { [c.id]: bodyDefFor(c, manifestOf(c.id)!) }, rootBodyId: c.id };
      return createTerrainProvider(defs, createFsTileSource(TILES), { bodies: [c.id] });
    };
    const suffix = left.length ? ` (left to verify.py, too small for the low-res map: ${left.join(', ')})` : '';

    it(`${c.id}: the landmarks hold${suffix}`, { timeout: 300_000 }, async () => {
      const tp = await provider();
      for (const l of used) {
        const r = await holds(l, c, tp, map);
        expect(r.ok, `${l.name}: ${r.detail}`).toBe(true);
      }
    });

    it.runIf(used.length > 0)(`${c.id}: the landmarks fail on the map mirrored east-west and on the map shifted by 180 degrees`, { timeout: 300_000 }, async () => {
      const tp = await provider();
      for (const [label, fn] of [['mirrored', (lon: number) => -lon], ['shifted by 180 deg', (lon: number) => lon + 180]] as const) {
        let fails = 0;
        for (const l of used) if (!(await holds(moved(l, fn), c, tp, map)).ok) fails++;
        expect(fails, `${c.id}: no landmark fails on the map ${label}`).toBeGreaterThan(0);
      }
    });
  }
});
