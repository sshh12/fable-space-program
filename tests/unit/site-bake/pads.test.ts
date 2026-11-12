/**
 * site-bake: the resolved pads of both launch sites (data/staged/sites/<site>.pads.json, written by
 * `python -I tools/bake/earth/bake.py pads`, tools/bake/earth/padresolve.py).
 *
 *  - Sixteen pads per site: 4 heavy, 6 medium, 6 light (ARCHITECTURE 9.3); LC-1 stays where it is.
 *  - Spacing: heavy pads at least 2.5 km apart, medium 1.5 km, light 1 km; pads of two classes at least the mean
 *    of their class spacings apart (each pad owns a disc of half its spacing; the discs do not overlap).
 *  - Every resolved pad meets the rule's slope, relief, dryness and distance gates as recorded by the resolver.
 *  - Where the earth tile set is baked on this machine and its manifest covers the pad, the same rule measured
 *    independently with the game's height authority (the real TerrainProvider, band-limited at 100 m: the data
 *    surface): the height at the centre within 2 m of padElevation, the slope of the plane through the 500 m disc
 *    below the limit, and no sea (height below 0 m) within the minimum shore distance. CI has no tiles: that part
 *    is skipped there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeAll, describe, expect, it } from 'vitest';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import type { TerrainProvider } from '../../../src/core/contracts/terrain';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { dirToTile } from '../../../src/core/geo/cubeSphere';
import { loadDefs } from '../../../src/core/defs/loader';
import type { Vec3 } from '../../../src/core/math/vec3';
import { createFsTileSource } from '../../../src/terrain/fsTileSource';
import { createTerrainProvider } from '../../../src/terrain/provider';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const STAGED = path.join(REPO, 'data', 'staged', 'sites');
const TILES = path.join(REPO, 'data', 'tiles');
const R_EARTH = 6_371_000;
const DEG = Math.PI / 180;

type PadClass = 'heavy' | 'medium' | 'light';
interface StagedPad {
  id: string;
  class: PadClass;
  latDeg: number;
  lonDeg: number;
  padElevation: number;
  azimuthDeg: number;
  offsetEnu: [number, number];
  fixed: boolean;
  report: {
    naturalHeightM: number;
    slopeDeg: number;
    reliefM: number;
    roughness10M: number;
    shoreDistanceM: number;
    dryFraction: number;
    bareFraction: number;
    seaDistanceM: number | null;
    builtUpM: number | null;
    builtUpWindowM: number;
    builtUpRadiusM: number;
    oceanRays: { ok: boolean };
    passes: boolean;
    failures: string[];
  };
}
interface StagedSite {
  site: string;
  region: string;
  tileset: string;
  bodyId: string;
  referencePad: string;
  tilesetContentHash: string;
  corridors: { id: string; clearAzimuthDeg: [number, number] | null }[];
  rule: {
    strict: boolean;
    oceanReachKm: number;
    padRadii: Record<PadClass, { flat: number; blend: number; keepOut: number }>;
    builtUpMarginM: number;
    corridor: { azimuthDeg: [number, number]; reachKm: number };
    dry: 'bareGround' | 'anyLand';
    discRadiusM: number;
    maxSlopeDeg: number;
    maxReliefM: number;
    minShoreDistanceM: number;
    minHeightM: number;
    minAllowedFraction: number;
    classes: Record<PadClass, { count: number; spacingM: number }>;
  };
  pads: StagedPad[];
}

/** ARCHITECTURE 9.3. */
const SPEC: Record<PadClass, { count: number; spacingM: number }> = {
  heavy: { count: 4, spacingM: 2500 },
  medium: { count: 6, spacingM: 1500 },
  light: { count: 6, spacingM: 1000 },
};
/** Keep-out radius by class (UniverseRules.pads.keepOutRadius defaults, ARCHITECTURE 9.4), m. */
const KEEP_OUT: Record<PadClass, number> = { light: 300, medium: 450, heavy: 600 };
/** The launch sector every pad must keep clear (azimuths, deg) and its reach, m (the lead's decision of 2026-11-12). */
const CORRIDOR = { az: [60, 130] as const, reachM: 12_000 };
/** The full rule that placed LC-1 (open ocean to the east gated) applies at Madrakah. */
const STRICT: Record<string, boolean> = { 'ka-lae': false, madrakah: true };
/** LC-1 as resolved by bake-earth (docs/handoff/bake-earth.md section 2): it stays where it is. */
const LC1 = { latDeg: 18.987556, lonDeg: -155.603239, padElevation: 21.62 };

const SITES = ['ka-lae', 'madrakah'];
/**
 * Band limit of the height queries, m: the data surface (bicubic of the tiles) without the procedural
 * amplification, whose metre-scale relief below the data resolution the pad's flatten disc removes anyway.
 */
const LAMBDA_MIN = 100;

function gcDistance(a: { latDeg: number; lonDeg: number }, b: { latDeg: number; lonDeg: number }): number {
  const p1 = a.latDeg * DEG;
  const p2 = b.latDeg * DEG;
  const c = Math.sin(p1) * Math.sin(p2) + Math.cos(p1) * Math.cos(p2) * Math.cos((b.lonDeg - a.lonDeg) * DEG);
  return Math.acos(Math.min(1, Math.max(-1, c))) * R_EARTH;
}

const dirOf = (latDeg: number, lonDeg: number): Vec3 => ({
  x: Math.cos(latDeg * DEG) * Math.cos(lonDeg * DEG),
  y: Math.cos(latDeg * DEG) * Math.sin(lonDeg * DEG),
  z: Math.sin(latDeg * DEG),
});

/** Direction at (east, north) metres from a point: azimuthal equidistant, as the resolver's site.destination. */
function destination(latDeg: number, lonDeg: number, east: number, north: number): Vec3 {
  const lat1 = latDeg * DEG;
  const rho = Math.hypot(east, north) / R_EARTH;
  const az = Math.atan2(east, north);
  const sl = Math.sin(lat1) * Math.cos(rho) + Math.cos(lat1) * Math.sin(rho) * Math.cos(az);
  const lat2 = Math.asin(Math.min(1, Math.max(-1, sl)));
  const lon2 = lonDeg * DEG + Math.atan2(Math.sin(az) * Math.sin(rho) * Math.cos(lat1), Math.cos(rho) - Math.sin(lat1) * sl);
  return dirOf(lat2 / DEG, lon2 / DEG);
}

function bearing(a: { latDeg: number; lonDeg: number }, b: { latDeg: number; lonDeg: number }): number {
  const p1 = a.latDeg * DEG;
  const p2 = b.latDeg * DEG;
  const dl = (b.lonDeg - a.lonDeg) * DEG;
  const t = Math.atan2(Math.sin(dl) * Math.cos(p2), Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl));
  return ((t / DEG) + 360) % 360;
}

/** Does pad q's keep-out disc reach into pad p's launch sector (CORRIDOR) within its reach? */
function inCorridor(p: StagedPad, q: StagedPad): boolean {
  const d = gcDistance(p, q);
  const r = KEEP_OUT[q.class];
  if (d <= r) return true;
  if (d - r > CORRIDOR.reachM) return false;
  const half = Math.asin(Math.min(1, r / d)) / DEG;
  const mid = 0.5 * (CORRIDOR.az[0] + CORRIDOR.az[1]);
  const off = Math.abs(((bearing(p, q) - mid + 540) % 360) - 180);
  return off <= 0.5 * (CORRIDOR.az[1] - CORRIDOR.az[0]) + half;
}

/**
 * The layouts under test: a site's resolved file `data/staged/sites/<site>.pads.json`, or, where the lead has a
 * decision to take (Ka Lae, 2026-11-12: under every gate only 9 pads fit), the candidate layouts in
 * `data/staged/sites/candidates/` (complete or not; never read by fleet-data).
 */
interface Layout {
  key: string;
  site: string;
  doc: StagedSite & { candidate?: boolean; unplaced?: Partial<Record<PadClass, number>> };
  complete: boolean;
}

function readJson(p: string): (StagedSite & { candidate?: boolean; unplaced?: Partial<Record<PadClass, number>> }) | null {
  return fs.existsSync(p) ? (JSON.parse(fs.readFileSync(p, 'utf8')) as StagedSite) : null;
}

function layouts(): Layout[] {
  const out: Layout[] = [];
  for (const site of SITES) {
    const d = readJson(path.join(STAGED, `${site}.pads.json`));
    if (d) {
      out.push({ key: site, site, doc: d, complete: true });
      continue;
    }
    const dir = path.join(STAGED, 'candidates');
    for (const f of fs.existsSync(dir) ? fs.readdirSync(dir).filter((n) => n.startsWith(`${site}.`) && n.endsWith('.json')).sort() : []) {
      const c = readJson(path.join(dir, f))!;
      out.push({ key: `${site} candidate ${f}`, site, doc: c, complete: !c.unplaced || Object.keys(c.unplaced).length === 0 });
    }
  }
  return out;
}

const LAYOUTS = layouts();

describe('site-bake: resolved pads', () => {
  it('Madrakah is resolved; Ka Lae is resolved or its candidate layouts await the lead (no stale layout)', () => {
    expect(LAYOUTS.some((l) => l.key === 'madrakah')).toBe(true);
    const kalae = LAYOUTS.filter((l) => l.site === 'ka-lae');
    expect(kalae.length).toBeGreaterThan(0);
    if (!kalae.some((l) => l.key === 'ka-lae')) {
      for (const l of kalae) expect(l.doc.candidate, l.key).toBe(true);
      expect(kalae.some((l) => l.complete), 'at least one complete candidate').toBe(true);
    }
  });

  for (const L of LAYOUTS) {
    describe(L.key, () => {
      it('class counts (4 heavy, 6 medium, 6 light, or what fitted and what did not), unique ids, offsets about the reference pad', () => {
        const d = L.doc;
        expect(new Set(d.pads.map((p) => p.id)).size).toBe(d.pads.length);
        for (const cls of Object.keys(SPEC) as PadClass[]) {
          const placed = d.pads.filter((p) => p.class === cls).length;
          expect(placed + (L.complete ? 0 : d.unplaced?.[cls] ?? 0), cls).toBe(SPEC[cls].count);
          expect(d.rule.classes[cls]).toEqual(SPEC[cls]);
        }
        if (L.complete) expect(d.pads).toHaveLength(16);
        expect(d.pads[0]!.id).toBe(d.referencePad);
        expect(d.pads[0]!.offsetEnu).toEqual([0, 0]);
        for (const p of d.pads) {
          expect(Number.isFinite(p.azimuthDeg)).toBe(true);
          expect(Math.abs(Math.hypot(...p.offsetEnu) - gcDistance(d.pads[0]!, p))).toBeLessThan(1);
        }
      });

      it('spacing: same class at least the class spacing apart, two classes at least the mean of their spacings', () => {
        const d = L.doc;
        const problems: string[] = [];
        for (let i = 0; i < d.pads.length; i++) {
          for (let j = i + 1; j < d.pads.length; j++) {
            const a = d.pads[i]!;
            const b = d.pads[j]!;
            const need = 0.5 * (SPEC[a.class].spacingM + SPEC[b.class].spacingM);
            const dist = gcDistance(a, b);
            if (dist < need) problems.push(`${a.id} (${a.class}) - ${b.id} (${b.class}): ${dist.toFixed(0)} m < ${need} m`);
            if (a.class === b.class && dist < SPEC[a.class].spacingM) problems.push(`${a.id} - ${b.id}: same class ${dist.toFixed(0)} m`);
          }
        }
        expect(problems).toEqual([]);
      });

      it('every resolved pad meets the slope, relief, dry (bare ground), height, shore, coast and built-up rules (as recorded)', () => {
        const d = L.doc;
        const r = d.rule;
        expect(r.strict, 'the full rule that placed LC-1 (open ocean east) at Madrakah only').toBe(STRICT[L.site]);
        expect(r.corridor).toEqual({ azimuthDeg: [...CORRIDOR.az], reachKm: CORRIDOR.reachM / 1000 });
        if (!d.candidate) expect(r.dry, 'a resolved layout keeps the bare-ground rule').toBe('bareGround');
        for (const p of d.pads.filter((q) => !q.fixed)) {
          expect(p.report.passes, p.id).toBe(true);
          expect(p.report.failures, p.id).toEqual([]);
          expect(p.report.slopeDeg, p.id).toBeLessThan(r.maxSlopeDeg);
          expect(p.report.reliefM, p.id).toBeLessThanOrEqual(r.maxReliefM);
          expect(p.report.shoreDistanceM, p.id).toBeGreaterThanOrEqual(r.minShoreDistanceM);
          expect(p.report.naturalHeightM, p.id).toBeGreaterThanOrEqual(r.minHeightM);
          // the dry gate is bare ground (WorldCover bare / sparse vegetation), not merely "not water"
          if (r.dry === 'bareGround') expect(p.report.bareFraction, p.id).toBeGreaterThanOrEqual(r.minAllowedFraction);
          else expect(p.report.dryFraction, p.id).toBeGreaterThanOrEqual(r.minAllowedFraction);
          expect(p.report.seaDistanceM, p.id).not.toBeNull();
          expect(p.report.seaDistanceM!, p.id).toBeLessThanOrEqual(r.oceanReachKm * 1000);
          // no built-up land within max(blend, keep-out) + margin of the pad's class
          const need = Math.max(r.padRadii[p.class].blend, r.padRadii[p.class].keepOut) + r.builtUpMarginM;
          expect(p.report.builtUpRadiusM, p.id).toBe(need);
          if (p.report.builtUpM === null) expect(p.report.builtUpWindowM, p.id).toBeGreaterThanOrEqual(need);
          else expect(p.report.builtUpM, p.id).toBeGreaterThanOrEqual(need);
          if (STRICT[L.site]) expect(p.report.oceanRays.ok, `${p.id}: open ocean east`).toBe(true);
          expect(Math.abs(p.padElevation - p.report.naturalHeightM), p.id).toBeLessThan(0.01);
        }
      });

      it('launch corridors: no keep-out disc of a pad lies in the 60-130 deg sector of another within 12 km', () => {
        const d = L.doc;
        const problems: string[] = [];
        for (const p of d.pads) {
          for (const q of d.pads) {
            if (p.id !== q.id && inCorridor(p, q)) problems.push(`${q.id} in the corridor of ${p.id} (${(gcDistance(p, q) / 1000).toFixed(2)} km, ${bearing(p, q).toFixed(0)} deg)`);
          }
        }
        expect(problems).toEqual([]);
        expect(d.corridors.map((c) => c.id).sort()).toEqual(d.pads.map((p) => p.id).sort());
        // the whole sector clear of built-up land and keep-out discs for every resolved pad (a fixed pad, LC-1, stays
        // where it is: its corridor is reported, built-up land 0.5 km away blocks it)
        const fixed = new Set(d.pads.filter((p) => p.fixed).map((p) => p.id));
        for (const c of d.corridors.filter((q) => !fixed.has(q.id))) {
          expect(c.clearAzimuthDeg, c.id).not.toBeNull();
          expect(c.clearAzimuthDeg![0], c.id).toBeLessThanOrEqual(CORRIDOR.az[0]);
          expect(c.clearAzimuthDeg![1], c.id).toBeGreaterThanOrEqual(CORRIDOR.az[1]);
        }
      });

      if (L.site === 'ka-lae') {
        it('LC-1 stays where it is (a heavy pad at its v1 coordinates and elevation)', () => {
          const lc1 = L.doc.pads.find((p) => p.id === 'lc-1')!;
          expect(lc1.fixed).toBe(true);
          expect(lc1.class).toBe('heavy');
          expect([lc1.latDeg, lc1.lonDeg, lc1.padElevation]).toEqual([LC1.latDeg, LC1.lonDeg, LC1.padElevation]);
        });
      }
    });
  }

  describe('measured again with the height authority on the baked tiles (skipped where they are not baked)', () => {
    let defs: DefLibrary | null = null;
    let terrain: TerrainProvider | null = null;
    let coverage: Record<string, { face: number; x0: number; y0: number; x1: number; y1: number }[]> = {};
    let contentHash = '';

    beforeAll(async () => {
      const manifest = path.join(TILES, 'earth', 'manifest.json');
      if (!fs.existsSync(manifest)) return;
      const m = JSON.parse(fs.readFileSync(manifest, 'utf8')) as { contentHash: string; layers: { height: { coverage: typeof coverage } } };
      coverage = m.layers.height.coverage;
      contentHash = m.contentHash;
      defs = await loadDefs(fsDefSource(path.join(REPO, 'data', 'defs')));
      terrain = await createTerrainProvider(defs, createFsTileSource(TILES));
    }, 120_000);

    for (const L of LAYOUTS) {
      it(`${L.key}: resolved on the live tile set; height at the centre, slope over the disc and no sea within the shore distance`, async () => {
        if (!terrain) {
          console.log('[site-bake] the earth tile set is not baked on this machine: skipped');
          return;
        }
        const d = L.doc;
        expect(d.tilesetContentHash, 'the pads record the tile set they were resolved on: the live one').toBe(contentHash);
        const finest = Math.max(...Object.keys(coverage).map(Number));
        const covered = d.pads.filter((p) => {
          const k = tileOf(dirOf(p.latDeg, p.lonDeg), finest);
          return coverage[String(finest)]!.some((r) => k.face === r.face && k.x >= r.x0 && k.x <= r.x1 && k.y >= r.y0 && k.y <= r.y1);
        });
        expect(covered).toHaveLength(d.pads.length);
        const r = d.rule;
        const problems: string[] = [];
        let worstHeight = 0;
        let worstSlope = 0;
        for (const p of d.pads) {
          await terrain.ensureLoaded('earth', dirOf(p.latDeg, p.lonDeg), r.minShoreDistanceM + 100, 'site-bake-test');
          const h0 = terrain.heightAt('earth', dirOf(p.latDeg, p.lonDeg), LAMBDA_MIN);
          worstHeight = Math.max(worstHeight, Math.abs(h0 - p.padElevation));
          if (Math.abs(h0 - p.padElevation) > 2) problems.push(`${p.id}: height ${h0.toFixed(2)} vs padElevation ${p.padElevation}`);
          // plane through the disc (20 m grid)
          let n = 0, se = 0, sn = 0, sh = 0, see = 0, snn = 0, seh = 0, snh = 0;
          let sea = 0;
          for (let e = -r.minShoreDistanceM; e <= r.minShoreDistanceM; e += 20) {
            for (let nn = -r.minShoreDistanceM; nn <= r.minShoreDistanceM; nn += 20) {
              const rr = Math.hypot(e, nn);
              if (rr > r.minShoreDistanceM) continue;
              const h = terrain.heightAt('earth', destination(p.latDeg, p.lonDeg, e, nn), LAMBDA_MIN);
              if (h < 0) sea++;
              if (rr > r.discRadiusM) continue;
              n++; se += e; sn += nn; sh += h; see += e * e; snn += nn * nn; seh += e * h; snh += nn * h;
            }
          }
          // least squares h = c + a e + b n (the grid is symmetric)
          const a = (seh - (se * sh) / n) / (see - (se * se) / n);
          const b = (snh - (sn * sh) / n) / (snn - (sn * sn) / n);
          const slope = Math.atan(Math.hypot(a, b)) / DEG;
          if (!p.fixed) worstSlope = Math.max(worstSlope, slope);
          // the resolver gates the plane of the bilinear collision surface on a 10 m grid; the authority's band-limited
          // surface on a 20 m grid may differ by a few hundredths of a degree at the bound
          if (!p.fixed && slope >= r.maxSlopeDeg + 0.05) problems.push(`${p.id}: slope ${slope.toFixed(2)} deg`);
          if (!p.fixed && sea > 0) problems.push(`${p.id}: ${sea} points below sea level within ${r.minShoreDistanceM} m`);
        }
        console.log(`[site-bake] ${L.key}: height authority vs padElevation within ${worstHeight.toFixed(2)} m, steepest disc ${worstSlope.toFixed(2)} deg`);
        expect(problems).toEqual([]);
      }, 600_000);
    }
  });
});

/** Tile of a direction at a level (the cube mapping of src/core/geo/cubeSphere.ts). */
function tileOf(dir: Vec3, level: number): { face: number; x: number; y: number } {
  const t = dirToTile(dir, level);
  return { face: t.key.face, x: t.key.x, y: t.key.y };
}
