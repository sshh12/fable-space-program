/**
 * Synthetic tile sets for terrain-core tests and tools (Node only). Analytic height and land-cover functions
 * are sampled exactly like the bakes do (vertex-registered 259 x 259 heights with a 1-sample border,
 * cell-registered 256 x 256 u8), encoded with src/core/geo/tileCodec.ts and written into a temp directory.
 *
 * Two tile sets:
 *  - fixture-moon (R = 1,737,400 m): global height levels 0-2, sparse levels 3-5 in region A (face 0 centre)
 *    and levels 3-4 in region B, which straddles the edge between face 0 (+X) and face 2 (+Y). Each sparse
 *    level carries its own detail plus an offset of 10 m per level, so it disagrees with the global level by
 *    tens of metres (what the coverage blend has to hide).
 *  - fixture-earth (R = 6,371,000 m): heights and land cover, global 0-2, sparse 3-5 around the fixture pad
 *    at 19.1 N 155.5 W (face 1); an island with a coast, sand, lava and scrub classes.
 * In both, a third of the height tiles use twice their level's preferred scale (fixtureScaleFactor).
 * The set is generated once per FIXTURE_VERSION into os.tmpdir() and reused (atomic rename).
 */
import { existsSync, promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { BodyDef, DefLibrary, LaunchSiteDef, TerrainAmplificationDef } from '../../src/core/contracts/defs';
import type { TileManifest, TileRect } from '../../src/core/contracts/terrain';
import { layerHasTile, LANDCOVER_CLASS } from '../../src/core/contracts/terrain';
import { dirToTile, latLonToDir, tilePath, tileUvToDir, type FaceId, type TileKey } from '../../src/core/geo/cubeSphere';
import { deflateZlib, encodeFrt1Height, encodeFrt1U8, HEIGHT_TILE_STORED, IMAGE_TILE_SIZE } from '../../src/core/geo/tileCodec';
import { DEG } from '../../src/core/math/scalar';
import type { Vec3 } from '../../src/core/math/vec3';

export const FIXTURE_VERSION = 4;
export const MOON_R = 1737400;
export const EARTH_R = 6371000;
export const FIXTURE_PAD = { latDeg: 19.1, lonDeg: -155.5 };

interface Wave {
  n: Vec3;
  amp: number;
  wavelength: number;
  phase: number;
}

const unit = (x: number, y: number, z: number): Vec3 => {
  const l = Math.hypot(x, y, z);
  return { x: x / l, y: y / l, z: z / l };
};

function waves(dir: Vec3, R: number, list: readonly Wave[]): number {
  let h = 0;
  const px = dir.x * R;
  const py = dir.y * R;
  const pz = dir.z * R;
  for (const w of list) h += w.amp * Math.sin((2 * Math.PI * (px * w.n.x + py * w.n.y + pz * w.n.z)) / w.wavelength + w.phase);
  return h;
}

const MOON_BASE: Wave[] = [
  { n: unit(0.3, 0.8, 0.5), amp: 1200, wavelength: 300e3, phase: 0.3 },
  { n: unit(-0.7, 0.2, 0.68), amp: 600, wavelength: 90e3, phase: 1.1 },
  { n: unit(0.55, -0.6, 0.58), amp: 200, wavelength: 30e3, phase: 2.0 },
  { n: unit(0.1, 0.35, -0.93), amp: 60, wavelength: 12e3, phase: 0.7 },
];
const MOON_REGIONAL: Wave[] = [
  { n: unit(0.6, 0.6, 0.53), amp: 25, wavelength: 4000, phase: 0.2 },
  { n: unit(-0.2, 0.9, 0.39), amp: 15, wavelength: 1700, phase: 1.4 },
];

/** Moon fixture height at a direction for data level `level` (global levels: smooth base only). */
export function moonFixtureHeight(dir: Vec3, level: number): number {
  const base = waves(dir, MOON_R, MOON_BASE);
  if (level <= 2) return base;
  return base + waves(dir, MOON_R, MOON_REGIONAL) + 10 * (level - 2);
}

const padDir = latLonToDir(FIXTURE_PAD.latDeg * DEG, FIXTURE_PAD.lonDeg * DEG);
const islandCentre = latLonToDir((FIXTURE_PAD.latDeg + 0.25) * DEG, (FIXTURE_PAD.lonDeg + 0.2) * DEG);
const EARTH_DETAIL: Wave[] = [
  { n: unit(0.3, 0.9, 0.3), amp: 40, wavelength: 25e3, phase: 0.4 },
  { n: unit(-0.8, 0.3, 0.52), amp: 20, wavelength: 9e3, phase: 2.2 },
];
const EARTH_REGIONAL: Wave[] = [
  { n: unit(0.5, -0.5, 0.71), amp: 12, wavelength: 3000, phase: 0.9 },
  { n: unit(0.9, 0.1, 0.42), amp: 6, wavelength: 1300, phase: 0.1 },
];

/** Earth fixture height: ocean floor at -4000 m with an island whose shore lies beyond the pad. */
export function earthFixtureHeight(dir: Vec3, level: number): number {
  const c = dir.x * islandCentre.x + dir.y * islandCentre.y + dir.z * islandCentre.z;
  const d = EARTH_R * Math.acos(Math.max(-1, Math.min(1, c)));
  const island = 4500 * Math.exp(-((d / 150e3) ** 2));
  let h = -4000 + island + waves(dir, EARTH_R, EARTH_DETAIL);
  if (level > 2) h += waves(dir, EARTH_R, EARTH_REGIONAL) + 4 * (level - 2);
  return h;
}

/** Earth fixture land cover class at a direction. */
export function earthFixtureClass(dir: Vec3, level: number): number {
  const h = earthFixtureHeight(dir, level);
  if (h < 0) return LANDCOVER_CLASS.water;
  if (h < 25) return LANDCOVER_CLASS.sand;
  const p = Math.sin((dir.x * EARTH_R) / 2100) * Math.cos((dir.y * EARTH_R) / 1700 + dir.z * 3000);
  if (h > 2500) return LANDCOVER_CLASS.bareRock;
  return p > 0.2 ? LANDCOVER_CLASS.bareRock : p < -0.5 ? LANDCOVER_CLASS.grass : LANDCOVER_CLASS.sparseScrub;
}

function rectAround(dir: Vec3, level: number, half: number): TileRect {
  const t = dirToTile(dir, level);
  const n = 2 ** level;
  return { face: t.key.face, x0: Math.max(0, t.key.x - half), y0: Math.max(0, t.key.y - half), x1: Math.min(n - 1, t.key.x + half), y1: Math.min(n - 1, t.key.y + half) };
}

export function moonCoverage(): Record<string, TileRect[]> {
  return {
    '3': [
      { face: 0, x0: 3, y0: 3, x1: 5, y1: 5 },
      { face: 0, x0: 6, y0: 3, x1: 7, y1: 4 },
      { face: 2, x0: 0, y0: 3, x1: 1, y1: 4 },
    ],
    '4': [
      { face: 0, x0: 7, y0: 7, x1: 9, y1: 9 },
      { face: 0, x0: 13, y0: 7, x1: 15, y1: 8 },
      { face: 2, x0: 0, y0: 7, x1: 2, y1: 8 },
    ],
    '5': [{ face: 0, x0: 15, y0: 15, x1: 18, y1: 18 }],
  };
}

export function earthCoverage(): Record<string, TileRect[]> {
  return { '3': [rectAround(padDir, 3, 1)], '4': [rectAround(padDir, 4, 1)], '5': [rectAround(padDir, 5, 2)] };
}

async function writeFile(file: string, data: Uint8Array): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, data);
}

function allKeys(globalMaxLevel: number, coverage: Record<string, TileRect[]>): TileKey[] {
  const out: TileKey[] = [];
  for (let level = 0; level <= globalMaxLevel; level++) {
    const n = 2 ** level;
    for (let face = 0; face < 6; face++) for (let x = 0; x < n; x++) for (let y = 0; y < n; y++) out.push({ face: face as FaceId, level, x, y });
  }
  for (const [k, rects] of Object.entries(coverage)) {
    for (const r of rects) for (let x = r.x0; x <= r.x1; x++) for (let y = r.y0; y <= r.y1; y++) out.push({ face: r.face, level: Number(k), x, y });
  }
  return out;
}

/**
 * Scale factor of a fixture height tile over its level's preferred scale. The contract lets a tile use a
 * coarser power of two; a deterministic third of the tiles at every level does, so same-face, diagonal and
 * cross-face neighbours with different quantisation exist everywhere (their shared samples differ by up to
 * half a coarse count until terrain-core reconciles the seams).
 */
export function fixtureScaleFactor(key: TileKey): number {
  return (key.x + 2 * key.y + 3 * key.face) % 3 === 0 ? 2 : 1;
}

async function writeHeightLayer(root: string, tileset: string, keys: TileKey[], scales: number[], h: (dir: Vec3, level: number) => number): Promise<void> {
  const S = HEIGHT_TILE_STORED;
  const buf = new Float64Array(S * S);
  for (const key of keys) {
    for (let j = 0; j < S; j++) for (let i = 0; i < S; i++) buf[j * S + i] = h(tileUvToDir(key, (i - 1) / 256, (j - 1) / 256), key.level);
    const raw = encodeFrt1Height(buf, S, S, scales[key.level]! * fixtureScaleFactor(key));
    await writeFile(path.join(root, tilePath(tileset, 'height', key, 'hgt')), await deflateZlib(raw));
  }
}

async function writeClassLayer(root: string, tileset: string, keys: TileKey[], cls: (dir: Vec3, level: number) => number): Promise<void> {
  const N = IMAGE_TILE_SIZE;
  const buf = new Uint8Array(N * N);
  for (const key of keys) {
    for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) buf[j * N + i] = cls(tileUvToDir(key, (i + 0.5) / N, (j + 0.5) / N), key.level);
    await writeFile(path.join(root, tilePath(tileset, 'landcover', key, 'u8')), await deflateZlib(encodeFrt1U8(buf, N, N, 1)));
  }
}

function manifestFor(tileset: string, radius: number, coverage: Record<string, TileRect[]>, withLandcover: boolean): TileManifest {
  const heightScales = [0.5, 0.5, 0.5, 0.125, 0.125, 0.125];
  const m: TileManifest = {
    formatVersion: 1,
    tileset,
    radius,
    mapping: 'gnomonic-cube',
    layers: {
      height: { encoding: 'frt1-height', ext: 'hgt', globalMaxLevel: 2, coverage, heightScales, sources: ['terrain-core synthetic fixture'] },
    },
    globals: {},
    residentHeightLevel: 1,
    attribution: ['synthetic'],
    contentHash: `fixture-v${FIXTURE_VERSION}`,
  };
  if (withLandcover) {
    m.layers['landcover'] = { encoding: 'frt1-u8', ext: 'u8', globalMaxLevel: 2, coverage, classes: { ...LANDCOVER_CLASS }, sources: ['terrain-core synthetic fixture'] };
  }
  return m;
}

/** Check the pyramid-completeness rule of TileManifest (every tile's parent exists). */
export function checkPyramid(m: TileManifest): void {
  for (const [name, layer] of Object.entries(m.layers)) {
    for (const [k, rects] of Object.entries(layer.coverage)) {
      for (const r of rects) {
        for (let x = r.x0; x <= r.x1; x++)
          for (let y = r.y0; y <= r.y1; y++)
            if (!layerHasTile(layer, { face: r.face, level: Number(k) - 1, x: x >> 1, y: y >> 1 })) throw new Error(`${name}: L${k} tile ${r.face}/${x}/${y} has no parent`);
      }
    }
  }
}

async function generate(root: string): Promise<void> {
  const moonCov = moonCoverage();
  const moon = manifestFor('fixture-moon', MOON_R, moonCov, false);
  checkPyramid(moon);
  await writeHeightLayer(root, 'fixture-moon', allKeys(2, moonCov), moon.layers['height']!.heightScales!, moonFixtureHeight);
  await writeFile(path.join(root, 'fixture-moon', 'manifest.json'), new TextEncoder().encode(JSON.stringify(moon, null, 1)));
  const earthCov = earthCoverage();
  const earth = manifestFor('fixture-earth', EARTH_R, earthCov, true);
  checkPyramid(earth);
  const keys = allKeys(2, earthCov);
  await writeHeightLayer(root, 'fixture-earth', keys, earth.layers['height']!.heightScales!, earthFixtureHeight);
  await writeClassLayer(root, 'fixture-earth', keys, earthFixtureClass);
  await writeFile(path.join(root, 'fixture-earth', 'manifest.json'), new TextEncoder().encode(JSON.stringify(earth, null, 1)));
}

/** Tile root holding fixture-moon and fixture-earth (generated on first use, then reused). */
export async function syntheticTileRoot(): Promise<string> {
  const final = path.join(os.tmpdir(), `fable-terrain-core-fixtures-v${FIXTURE_VERSION}`);
  if (existsSync(path.join(final, 'COMPLETE'))) return final;
  const tmp = `${final}.tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`;
  await fs.rm(tmp, { recursive: true, force: true });
  await generate(tmp);
  await fs.writeFile(path.join(tmp, 'COMPLETE'), 'ok');
  try {
    await fs.rename(tmp, final);
  } catch {
    // Another process won the race; its copy is identical.
    await fs.rm(tmp, { recursive: true, force: true });
    if (!existsSync(path.join(final, 'COMPLETE'))) throw new Error(`fixture directory ${final} is incomplete; delete it and re-run`);
  }
  return final;
}

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, 'utf8')) as unknown;
}

/** Amplification definitions from data/defs/terrain (the real tunables). */
export async function amplificationDefs(repoRoot: string): Promise<{ moon: TerrainAmplificationDef; earth: TerrainAmplificationDef }> {
  return {
    moon: (await readJson(path.join(repoRoot, 'data/defs/terrain/moon.amplification.json'))) as TerrainAmplificationDef,
    earth: (await readJson(path.join(repoRoot, 'data/defs/terrain/earth.amplification.json'))) as TerrainAmplificationDef,
  };
}

function bodyDef(id: string, radius: number, tileset: string, amp: TerrainAmplificationDef, ocean: boolean, maxRenderLevel: number, range: [number, number]): BodyDef {
  return {
    id,
    name: id,
    parent: null,
    mu: 1,
    radius,
    soiRadius: null,
    orbit: null,
    rotation: { mode: 'none' },
    gravityRole: 'attractor',
    emission: null,
    atmosphere: null,
    ocean: ocean ? { density: 1025, seaLevel: 0, swell: [] } : null,
    terrain: { tileset, minElevation: range[0], maxElevation: range[1], maxRenderLevel, modifiers: [], surfaceFriction: 0.8, amplification: amp },
    warpAltitudeLimits: [],
    navballSwitchAltitude: 0,
    render: { meanColor: [0, 0, 0], geometricAlbedo: 0, surface: null, atmosphere: null, clouds: null, ocean: null },
  };
}

export interface FixtureDefOptions {
  /** Override the amplification model of both bodies (e.g. 'none'). */
  model?: string;
  /** Launch-pad elevation of the fixture site ('terrain' = natural height). */
  padElevation?: number | 'terrain';
  /** Override the Earth/Moon tile set names (used by tests that rewrite a manifest). */
  moonTileset?: string;
  earthTileset?: string;
}

/**
 * A DefLibrary with the two fixture bodies ("moon" on fixture-moon, "earth" on fixture-earth, real radii,
 * real maxRenderLevel and the real amplification tunables) and one launch site on the fixture Earth.
 */
export async function fixtureDefs(repoRoot: string, o: FixtureDefOptions = {}): Promise<DefLibrary> {
  const amp = await amplificationDefs(repoRoot);
  const moonAmp = o.model ? { model: o.model, seed: amp.moon.seed, params: amp.moon.params } : amp.moon;
  const earthAmp = o.model ? { model: o.model, seed: amp.earth.seed, params: amp.earth.params } : amp.earth;
  const site: LaunchSiteDef = {
    id: 'fixture-pad',
    name: 'Fixture pad',
    bodyId: 'earth',
    location: { latDeg: FIXTURE_PAD.latDeg, lonDeg: FIXTURE_PAD.lonDeg, padElevation: o.padElevation ?? 'terrain' },
    padAzimuthDeg: 90,
    pad: { flatRadius: 450, blendRadius: 900, clampHeight: 18 },
    structures: [],
    recoveryZones: [],
  };
  return {
    bodies: {
      moon: bodyDef('moon', MOON_R, o.moonTileset ?? 'fixture-moon', moonAmp, false, 18, [-9130, 10790]),
      earth: bodyDef('earth', EARTH_R, o.earthTileset ?? 'fixture-earth', earthAmp, true, 20, [-10930, 8850]),
    },
    rootBodyId: 'earth',
    sites: { 'fixture-pad': site },
    resources: {},
    parts: {},
    vehicles: {},
    scenarios: {},
    sections: {},
  };
}

/** Points of the fixture used across tests. */
export const FIXTURE_POINTS = {
  /** Inside region A at level 5 (face 0, L5 tile 16/16 centre). */
  moonDeep: tileUvToDir({ face: 0, level: 5, x: 16, y: 16 }, 0.5, 0.5),
  /** Global-only lunar area far from any region. */
  moonGlobal: latLonToDir(-35 * DEG, 160 * DEG),
  /** On the face 0 / face 2 cube edge inside region B. */
  moonCubeEdge: tileUvToDir({ face: 0, level: 4, x: 15, y: 7 }, 1, 0.7),
  padDir,
};
