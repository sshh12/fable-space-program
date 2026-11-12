/**
 * Shared helpers of the planet-bake tests: the bake configs (tools/bake/planet/bodies/*.json), the resolved
 * amplification definition of a body (the model's parameter file plus the config's overrides, exactly what
 * tools/bake/planet/procedural.py bakes with), and a BodyDef for a baked tile set built from its config and
 * manifest, so the real TerrainProvider can load a simple body before bodies-activation stages its definition.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { BodyDef, TerrainAmplificationDef } from '../../../src/core/contracts/defs';
import type { TileManifest } from '../../../src/core/contracts/terrain';

export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
export const BODIES_DIR = path.join(REPO_ROOT, 'tools/bake/planet/bodies');
export const TILES = path.join(REPO_ROOT, 'data/tiles');

/** ARCHITECTURE 8.5 / the brief: the solid bodies other than Earth and the Moon, by name. */
export const SOLID_BODIES = [
  'Mercury', 'Venus', 'Mars', 'Phobos', 'Deimos', 'Io', 'Europa', 'Ganymede', 'Callisto', 'Mimas', 'Enceladus', 'Tethys',
  'Dione', 'Rhea', 'Titan', 'Iapetus', 'Miranda', 'Ariel', 'Umbriel', 'Titania', 'Oberon', 'Triton', 'Ceres', 'Pluto', 'Charon',
] as const;
/** The bodies without a surface: global maps only. */
export const GIANTS = ['Jupiter', 'Saturn', 'Uranus', 'Neptune'] as const;

export interface Landmark {
  name: string;
  kind: 'demHeight' | 'albedoContrast' | 'albedoCompare' | 'craterDepth';
  latDeg?: number;
  lonDegE?: number;
  expectM?: number;
  toleranceM?: number;
  diameterKm?: number;
  minDepthM?: number;
}

export interface BodyConfig {
  id: string;
  name: string;
  kind: 'solid' | 'giant';
  radii: { mean: number; a: number; b: number; c: number; source: string };
  credits: string[];
  sources: Record<string, { url: string; credit: string; bytes: number; md5: string | null; sha256: string | null }>;
  amplification?: { model: string; seed: number; params: Record<string, number> };
  height?: { maxLevel: number; residentLevel: number; reference: 'ellipsoid' | { sphere: number }; dem: unknown; craters: { maxDiameterRadii: number; named: unknown[] } | null };
  albedo?: { maxLevel: number; procedural: unknown };
  landmarks?: Landmark[];
  globals?: { name: string; kind: string; width: number; height: number }[];
}

export function readJson<T>(file: string): T {
  return JSON.parse(readFileSync(file, 'utf8')) as T;
}

export function configs(): BodyConfig[] {
  return readdirSync(BODIES_DIR)
    .filter((f) => f.endsWith('.json'))
    .sort()
    .map((f) => readJson<BodyConfig>(path.join(BODIES_DIR, f)));
}

export function resolvedAmplification(c: BodyConfig): TerrainAmplificationDef {
  const a = c.amplification!;
  const base = readJson<TerrainAmplificationDef>(path.join(REPO_ROOT, 'data/defs/terrain', `${a.model}.amplification.json`));
  return { model: a.model, seed: a.seed, params: { ...base.params, ...a.params } };
}

export function manifestOf(id: string): TileManifest | null {
  const p = path.join(TILES, id, 'manifest.json');
  return existsSync(p) ? readJson<TileManifest>(p) : null;
}

/** Height of the reference surface above the mean radius along a unit direction (the bake's reference term). */
export function referenceTerm(c: BodyConfig, d: { x: number; y: number; z: number }): number {
  const ref = c.height!.reference;
  if (ref === 'ellipsoid') {
    const { a, b, c: cc } = c.radii;
    return 1 / Math.sqrt((d.x / a) ** 2 + (d.y / b) ** 2 + (d.z / cc) ** 2) - c.radii.mean;
  }
  return ref.sphere - c.radii.mean;
}

/**
 * A body definition for a baked simple body (terrain section from the config and the manifest). The orbit,
 * rotation and render fields are not read by the terrain provider; they hold neutral values here.
 */
export function bodyDefFor(c: BodyConfig, m: TileManifest): BodyDef {
  const elev = (m.layers['height'] as unknown as { elevation: { min: number; max: number } }).elevation;
  // Deepest render level: about 10 m tiles (the collision surface's quads are then about 16 cm).
  const maxRenderLevel = Math.ceil(Math.log2((Math.PI * c.radii.mean) / 2 / 10));
  return {
    id: c.id,
    name: c.name,
    parent: null,
    mu: 1,
    radius: c.radii.mean,
    soiRadius: null,
    orbit: null,
    rotation: { mode: 'none' },
    gravityRole: 'attractor',
    emission: null,
    atmosphere: null,
    ocean: null,
    terrain: {
      tileset: c.id,
      maxElevation: elev.max + 2000,
      minElevation: elev.min - 2000,
      maxRenderLevel,
      modifiers: [],
      surfaceFriction: 0.7,
      amplification: resolvedAmplification(c),
    },
    warpAltitudeLimits: [0, 0, 0, 0, 0, 0, 0],
    navballSwitchAltitude: 0,
    render: { meanColor: [0.1, 0.1, 0.1], geometricAlbedo: 0.1, surface: null, atmosphere: null, clouds: null, ocean: null },
  };
}
