/**
 * createTerrainProvider: THE height authority (src/core/contracts/terrain.ts TerrainProvider) plus the
 * RockField and the TerrainBaker the renderer's workers use. Headless and deterministic; the same code runs
 * on the main thread, in workers and in Node.
 */
import type { DefLibrary } from '../core/contracts/defs';
import type { RockField, RockInstance, SurfaceKind, TerrainProvider, TerrainResidency, TileSource } from '../core/contracts/terrain';
import type { TileKey } from '../core/geo/cubeSphere';
import type { Vec3 } from '../core/math/vec3';
import { TileBaker, type GeometryBake, type NormalMaterialBake } from './baker';
import { BodyTerrain } from './body';
import { CollisionSurface } from './collision';
import { tangentBasis } from './discTiles';
import { toInstance } from './rocks';
import { TileStore } from './tileStore';

export interface TerrainProviderOptions {
  /** Byte budget of the decoded-tile cache (resident pyramid + pins + LRU), default 384 MiB. */
  cacheBytes?: number;
  /** Capacity of the collision-vertex memo in max-level tiles (17 KB each), default 1024. */
  collisionCacheTiles?: number;
  /** Bodies to serve (default: every body with a terrain definition). */
  bodies?: readonly string[];
  /**
   * Pyramid levels 0..residentLevel of every layer are loaded at creation and pinned forever (default:
   * manifest.residentHeightLevel). Workers may pass a lower level to save memory.
   */
  residentLevel?: number;
}

/** Products and preparation for the renderer's tile workers. */
export interface TerrainBaker {
  /**
   * Load (and pin under `slot`, default "bake", replacing that slot's previous pin) every data tile that
   * bakeGeometry / bakeNormalMaterial / bakeTile / tileBounds read for render tile `key`.
   */
  prepareTile(bodyId: string, key: TileKey, slot?: string): Promise<void>;
  /** 65 x 65 vertex heights at band limit tileSize/32; at maxRenderLevel exactly the collision vertices. */
  bakeGeometry(bodyId: string, key: TileKey): GeometryBake;
  /** 256 x 256 normal/material map at band limit tileSize/128 (see baker.ts for the channel encoding). */
  bakeNormalMaterial(bodyId: string, key: TileKey): NormalMaterialBake;
  /** Both, sharing the coarse evaluation (cheaper than calling the two separately). */
  bakeTile(bodyId: string, key: TileKey): { geometry: GeometryBake; normalMaterial: NormalMaterialBake };
  /** Conservative height range of render tile `key` from resident data, without baking it. */
  tileBounds(bodyId: string, key: TileKey): { hMin: number; hMax: number };
}

export interface TerrainDiagnostics {
  /** Collision vertices evaluated so far, per body. */
  vertexEvaluations: Record<string, number>;
  /** Collision memo tiles held, per body. */
  collisionTiles: Record<string, number>;
  cache: { tiles: number; resident: number; pending: number; bytes: number; budget: number };
}

export interface HeightParts {
  /** Data height D at the band limit, amplification (before modifiers) and the final height. */
  data: number;
  amplification: number;
  height: number;
  /** True when every tile the evaluation read was resident. */
  complete: boolean;
}

export type TerrainAuthority = TerrainProvider &
  RockField &
  TerrainBaker & {
    /** Counters and cache state (instrumentation for tests and the HUD). */
    diagnostics(): TerrainDiagnostics;
    /** Sorted list of cached tiles ("tileset/layer/face/level/x/y", '*' = in flight) for determinism checks. */
    cachedTiles(): string[];
    /** Analytic height split into its parts (tests, tools). */
    heightParts(bodyId: string, dir: Vec3, lambdaMin: number): HeightParts;
    /** Ids of the bodies served. */
    readonly bodyIds: readonly string[];
  };

const DEFAULT_CACHE_BYTES = 384 * 1024 * 1024;
const DEFAULT_COLLISION_TILES = 1024;

interface BodyRuntime {
  terrain: BodyTerrain;
  collision: CollisionSurface;
  baker: TileBaker;
  /** Extra radius (m) loaded around ensureLoaded discs: rock and land-cover reach. */
  loadMargin: number;
}

export async function createTerrainProvider(defs: DefLibrary, tileSource: TileSource, opts: TerrainProviderOptions = {}): Promise<TerrainAuthority> {
  const store = new TileStore(tileSource, opts.cacheBytes ?? DEFAULT_CACHE_BYTES);
  const sites = Object.values(defs.sites);
  const ids = (opts.bodies ?? Object.keys(defs.bodies).filter((id) => defs.bodies[id]!.terrain !== null)).slice().sort();
  const bodies = new Map<string, BodyRuntime>();
  for (const id of ids) {
    const def = defs.bodies[id];
    if (!def) throw new Error(`createTerrainProvider: unknown body "${id}"`);
    if (!def.terrain) throw new Error(`createTerrainProvider: body "${id}" has no terrain definition`);
    const manifest = await tileSource.manifest(def.terrain.tileset);
    const terrain = new BodyTerrain(def, manifest, store, sites, opts.residentLevel);
    const rocks = terrain.model.rocks;
    bodies.set(id, {
      terrain,
      collision: new CollisionSurface(terrain, opts.collisionCacheTiles ?? DEFAULT_COLLISION_TILES),
      baker: new TileBaker(terrain),
      loadMargin: (rocks ? rocks.p.maxDiameter : 0) + 4,
    });
  }
  // Resident pyramid (pinned forever).
  for (const b of bodies.values()) await store.ensure(b.terrain.pyramidRequests(b.terrain.residentLevel), null, true);
  // Resolve 'sample' flatten-disc elevations from final data at the disc centres.
  for (const b of bodies.values()) {
    const t = b.terrain;
    for (const disc of t.discs) {
      if (!disc.sample) continue;
      const centre = { x: disc.cx, y: disc.cy, z: disc.cz };
      await store.ensure(t.discRequests(centre, 1, b.loadMargin), '__disc-elevation');
      t.main.setDir(centre.x, centre.y, centre.z);
      t.main.incomplete = false;
      const h = t.main.naturalDataHeight();
      if (t.main.incomplete) throw new Error(`${disc.source}: data at the disc centre did not load`);
      disc.elevation = h;
    }
    await store.ensure([], '__disc-elevation');
  }

  const get = (bodyId: string): BodyRuntime => {
    const b = bodies.get(bodyId);
    if (!b) throw new Error(`terrain: body "${bodyId}" is not served by this provider (served: ${ids.join(', ')})`);
    return b;
  };
  const unit = (d: Vec3): Vec3 => {
    const l2 = d.x * d.x + d.y * d.y + d.z * d.z;
    if (Math.abs(l2 - 1) <= 1e-12) return d;
    const l = Math.sqrt(l2);
    return { x: d.x / l, y: d.y / l, z: d.z / l };
  };
  const log2Band = (lambdaMin: number): number => {
    if (Number.isNaN(lambdaMin)) throw new TypeError('terrain: lambdaMin is NaN');
    return lambdaMin > 0 ? Math.log2(lambdaMin) : -Infinity;
  };

  const heightAt = (bodyId: string, dir: Vec3, lambdaMin?: number): number => {
    store.tick++;
    const b = get(bodyId);
    const d = unit(dir);
    if (lambdaMin === undefined) return b.collision.heightAt(d);
    const ev = b.terrain.main;
    ev.setDir(d.x, d.y, d.z);
    ev.incomplete = false;
    return ev.height(log2Band(lambdaMin));
  };

  const authority: TerrainAuthority = {
    bodyIds: ids,

    heightAt,

    normalAt(bodyId: string, dir: Vec3, baseline: number): Vec3 {
      store.tick++;
      const b = get(bodyId);
      const d = unit(dir);
      const R = b.terrain.radius;
      const half = Math.max(1e-3, baseline) / 2;
      const { ex, ey } = tangentBasis(d);
      const pt = (sx: number, sy: number): Vec3 => {
        const x = d.x + (ex.x * sx + ey.x * sy) / R;
        const y = d.y + (ex.y * sx + ey.y * sy) / R;
        const z = d.z + (ex.z * sx + ey.z * sy) / R;
        const l = Math.sqrt(x * x + y * y + z * z);
        const u = { x: x / l, y: y / l, z: z / l };
        const r = R + b.collision.heightAt(u);
        return { x: u.x * r, y: u.y * r, z: u.z * r };
      };
      const a1 = pt(half, 0);
      const a0 = pt(-half, 0);
      const b1 = pt(0, half);
      const b0 = pt(0, -half);
      const tx = { x: a1.x - a0.x, y: a1.y - a0.y, z: a1.z - a0.z };
      const ty = { x: b1.x - b0.x, y: b1.y - b0.y, z: b1.z - b0.z };
      let nx = tx.y * ty.z - tx.z * ty.y;
      let ny = tx.z * ty.x - tx.x * ty.z;
      let nz = tx.x * ty.y - tx.y * ty.x;
      if (nx * d.x + ny * d.y + nz * d.z < 0) {
        nx = -nx;
        ny = -ny;
        nz = -nz;
      }
      const l = Math.sqrt(nx * nx + ny * ny + nz * nz);
      return l > 0 ? { x: nx / l, y: ny / l, z: nz / l } : d;
    },

    surfaceKind(bodyId: string, dir: Vec3): SurfaceKind {
      store.tick++;
      const b = get(bodyId);
      const ocean = b.terrain.def.ocean;
      if (!ocean) return 'land';
      return b.collision.heightAt(unit(dir)) < ocean.seaLevel ? 'water' : 'land';
    },

    ensureLoaded(bodyId: string, dir: Vec3, radius: number, slot?: string): Promise<void> {
      store.tick++;
      const b = get(bodyId);
      return store.ensure(b.terrain.discRequests(unit(dir), Math.max(0, radius), b.loadMargin), slot ?? 'default');
    },

    prewarmCollision(bodyId: string, dir: Vec3, radius: number, maxVertices: number): number {
      store.tick++;
      return get(bodyId).collision.prewarm(unit(dir), Math.max(0, radius), maxVertices);
    },

    residency(bodyId: string, dir: Vec3): TerrainResidency {
      store.tick++;
      const b = get(bodyId);
      const d = unit(dir);
      const ev = b.terrain.main;
      ev.setDir(d.x, d.y, d.z);
      return {
        residentLevel: ev.residentLevel(),
        availableLevel: ev.availableLevel(),
        effectiveLevel: ev.effectiveLevel(),
        complete: ev.heightComplete() && ev.landcoverComplete(),
      };
    },

    elevationRange(bodyId: string): { min: number; max: number } {
      const t = get(bodyId).terrain.def.terrain!;
      return { min: t.minElevation, max: t.maxElevation };
    },

    rocksNear(bodyId: string, dir: Vec3, radius: number, minRadius: number): RockInstance[] {
      store.tick++;
      const b = get(bodyId);
      const model = b.terrain.model;
      if (!model.rocks) return [];
      const list = model.rocks.rocksIn(unit(dir), Math.max(0, radius), Math.max(0, minRadius), model.rockAbundance);
      const ev = b.terrain.main;
      return list.map(({ c }) => {
        const inst = toInstance(c, 0);
        ev.setDir(inst.dir.x, inst.dir.y, inst.dir.z);
        inst.baseHeight = ev.height(b.terrain.collisionLog2Lambda, false);
        return inst;
      });
    },

    prepareTile(bodyId: string, key: TileKey, slot?: string): Promise<void> {
      store.tick++;
      const b = get(bodyId);
      const margin = Math.max(0.04, b.loadMargin / b.terrain.tileSize(key.level));
      return store.ensure(b.terrain.tileRequests(key.face, key.level, key.x, key.y, margin), slot ?? 'bake');
    },

    bakeGeometry(bodyId: string, key: TileKey): GeometryBake {
      store.tick++;
      return get(bodyId).baker.bakeGeometry(key);
    },

    bakeNormalMaterial(bodyId: string, key: TileKey): NormalMaterialBake {
      store.tick++;
      return get(bodyId).baker.bakeNormalMaterial(key);
    },

    bakeTile(bodyId: string, key: TileKey): { geometry: GeometryBake; normalMaterial: NormalMaterialBake } {
      store.tick++;
      return get(bodyId).baker.bakeTile(key);
    },

    tileBounds(bodyId: string, key: TileKey): { hMin: number; hMax: number } {
      store.tick++;
      return get(bodyId).baker.tileBounds(key);
    },

    diagnostics(): TerrainDiagnostics {
      const vertexEvaluations: Record<string, number> = {};
      const collisionTiles: Record<string, number> = {};
      for (const [id, b] of bodies) {
        vertexEvaluations[id] = b.collision.vertexEvaluations;
        collisionTiles[id] = b.collision.tileCount;
      }
      return { vertexEvaluations, collisionTiles, cache: store.stats() };
    },

    cachedTiles(): string[] {
      return store.residentKeys();
    },

    heightParts(bodyId: string, dir: Vec3, lambdaMin: number): HeightParts {
      store.tick++;
      const b = get(bodyId);
      const d = unit(dir);
      const ev = b.terrain.main;
      ev.setDir(d.x, d.y, d.z);
      ev.incomplete = false;
      const lam = new Float64Array([log2Band(lambdaMin)]);
      const out = new Float64Array(1);
      const data = new Float64Array(1);
      const amp = new Float64Array(1);
      ev.heights(lam, 1, out, Infinity, data, amp);
      return { data: data[0]!, amplification: amp[0]!, height: out[0]!, complete: !ev.incomplete };
    },
  };
  return authority;
}
