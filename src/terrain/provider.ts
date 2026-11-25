/**
 * createTerrainProvider: THE height authority (src/core/contracts/terrain.ts TerrainProvider) plus the
 * RockField and the TerrainBaker the renderer's workers use. Headless and deterministic; the same code runs
 * on the main thread, in workers and in Node.
 *
 * LAZY PER-BODY RESIDENCY (ARCHITECTURE 10.2, 10.5; MIGRATION_V2 4.1c). A served body is either PRELOADED (its
 * manifest read and its resident pyramid pinned at creation and held for the provider's life: v1's behaviour)
 * or LAZY: nothing of it is read at creation; it is loaded (manifest, resident pyramid, sampled flatten discs)
 * by the first `ensureLoaded`, `prepareTile` or `loadBody` that names it, and RELEASED (every tile of it dropped,
 * its collision memo with it) when no slot holds it any more. A slot holds the body its latest request named:
 * a request of the same slot for another body, or `release(slot)`, lets go of it. Synchronous queries never
 * start a load (a load whose completion no step awaits would make the simulation depend on I/O timing): on a
 * body that is not loaded they answer from the datum surface (height 0, the radial normal) and `residency`
 * reports no level resident and the data incomplete, exactly as a query outside the resident tiles of a loaded
 * body reports it; `diagnostics().unloadedQueries` counts them.
 *
 * Which bodies are preloaded is `TerrainProviderOptions.preload`: 'all' (the default, v1's behaviour for every
 * caller that exists), 'launchSystems' (the planet systems of the library's launch sites: Earth and the Moon in
 * the Sun-rooted library; every served body when the library has no site), or a list of body ids.
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
import type { SharedTileStore } from './sharedStore';
import { TileStore, type LayerRef } from './tileStore';

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
  /**
   * Bodies loaded at creation and held for the provider's life; every other served body is lazy (the module
   * comment). Default 'all'.
   */
  preload?: 'all' | 'launchSystems' | readonly string[];
  /**
   * The shard-wide decoded-tile store to take every tile from instead of decoding from the tile source
   * (src/terrain/sharedStore.ts; ARCHITECTURE 10.5). Manifests still come from the tile source.
   */
  sharedStore?: SharedTileStore;
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
  /** Bytes of the collision memo slab, per body (0 until ensureLoaded, prewarmCollision or a query allocates it). */
  collisionMemoBytes: Record<string, number>;
  /** prewarmCollision bookkeeping work units so far (vertex slots scanned/sorted, tiles visited), per body. */
  prewarmWork: Record<string, number>;
  /** Current prewarm job per body: its radius (m) and whether the request was clamped to the memo capacity. */
  prewarm: Record<string, { radius: number; clamped: boolean } | null>;
  /** Shared height samples rewritten by seam reconciliation (tiles quantised with different scales), per body. */
  seamWrites: Record<string, number>;
  cache: { tiles: number; resident: number; pending: number; bytes: number; budget: number };
  /** Per served body: 'preloaded', 'loaded' (lazy, held), 'loading' or 'unloaded', and the slots holding a lazy one. */
  residency: Record<string, { state: 'preloaded' | 'loaded' | 'loading' | 'unloaded'; holders: string[] }>;
  /** Synchronous queries answered from the datum because their body was not loaded, per body. */
  unloadedQueries: Record<string, number>;
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
    /**
     * The finest wavelength the PINNED pyramid resolves everywhere on a body, m: the data wavelength of its resident
     * level R, lambda0 2^-R (request island-core-3). A band-limited query at or above it reads levels 0..R only
     * (the data chain's weight of level R + 1 is zero there, and the amplification's data scale is capped at R),
     * so its answer does not depend on which finer tiles other requests left in the cache.
     */
    pinnedBand(bodyId: string): number;
    /**
     * The band-limited height a READ-OUT takes (radar altitude above the terrain regime, the events of a conic, the
     * impact marker): `heightAt(bodyId, dir, max(lambdaMin, pinnedBand(bodyId)))`, a function of the body, the
     * direction and the band alone once the body's resident pyramid is in (always for a preloaded body; a lazy body
     * not loaded yet answers the datum, as heightAt does, and counts in `unloadedQueries`).
     */
    stableHeightAt(bodyId: string, dir: Vec3, lambdaMin: number): number;
    /** Ids of the bodies served. */
    readonly bodyIds: readonly string[];
    /** Ids of the bodies preloaded at creation (held for the provider's life). */
    readonly preloadedIds: readonly string[];
    /** Ids of the served bodies loaded now (preloaded, and lazy ones some slot holds), sorted. */
    loadedBodies(): string[];
    /**
     * Load a lazy body (manifest, resident pyramid, flatten discs) and hold it under `slot` (default
     * 'body:<id>'): resolves when its resident pyramid is in. A preloaded body is loaded already.
     */
    loadBody(bodyId: string, slot?: string): Promise<void>;
    /** Let go of a slot: its pinned tiles become evictable, and a lazy body no slot holds any more is released. */
    release(slot: string): void;
  };

const DEFAULT_CACHE_BYTES = 384 * 1024 * 1024;
const DEFAULT_COLLISION_TILES = 1024;

interface BodyRuntime {
  terrain: BodyTerrain;
  collision: CollisionSurface;
  baker: TileBaker;
}

/**
 * The planet systems of the library's launch sites: every body whose system (the highest ancestor that is not
 * the star and whose parent is the star or nothing) is that of a site's body. Null when the library has no site.
 */
function launchSystemBodies(defs: DefLibrary): Set<string> | null {
  const siteBodies = Object.values(defs.sites).map((s) => s.bodyId);
  if (!siteBodies.length) return null;
  const isStar = (id: string): boolean => (defs.bodies[id]?.emission ?? null) !== null;
  const systemOf = (id: string): string => {
    let cur = id;
    for (;;) {
      const p = defs.bodies[cur]?.parent ?? null;
      if (p === null || isStar(p)) return cur;
      cur = p;
    }
  };
  const systems = new Set(siteBodies.map(systemOf));
  return new Set(Object.keys(defs.bodies).filter((id) => !isStar(id) && systems.has(systemOf(id))));
}

interface LazyBody {
  /** Bumped at every release, so a load that a release overtook does not install its runtime. */
  generation: number;
  loading: Promise<void> | null;
  holders: Set<string>;
  refs: LayerRef[];
}

export async function createTerrainProvider(defs: DefLibrary, tileSource: TileSource, opts: TerrainProviderOptions = {}): Promise<TerrainAuthority> {
  const store = new TileStore(tileSource, opts.cacheBytes ?? DEFAULT_CACHE_BYTES, opts.sharedStore ?? null);
  const sites = Object.values(defs.sites);
  const ids = (opts.bodies ?? Object.keys(defs.bodies).filter((id) => defs.bodies[id]!.terrain !== null)).slice().sort();
  for (const id of ids) {
    const def = defs.bodies[id];
    if (!def) throw new Error(`createTerrainProvider: unknown body "${id}"`);
    if (!def.terrain) throw new Error(`createTerrainProvider: body "${id}" has no terrain definition`);
  }
  const pre = opts.preload ?? 'all';
  const launch = pre === 'launchSystems' ? launchSystemBodies(defs) : null;
  if (typeof pre !== 'string') for (const id of pre) if (!ids.includes(id)) throw new Error(`createTerrainProvider: preload names "${id}", which this provider does not serve (served: ${ids.join(', ')})`);
  const preloaded = ids.filter((id) => (pre === 'all' ? true : pre === 'launchSystems' ? launch === null || launch.has(id) : pre.includes(id)));
  const bodies = new Map<string, BodyRuntime>();
  const makeRuntime = (id: string, manifest: Awaited<ReturnType<TileSource['manifest']>>): BodyRuntime => {
    const terrain = new BodyTerrain(defs.bodies[id]!, manifest, store, sites, opts.residentLevel);
    return { terrain, collision: new CollisionSurface(terrain, opts.collisionCacheTiles ?? DEFAULT_COLLISION_TILES), baker: new TileBaker(terrain) };
  };
  /** Resolve the 'sample' flatten-disc elevations of a body from final data at the disc centres. */
  const sampleDiscs = async (b: BodyRuntime, slot: string): Promise<void> => {
    const t = b.terrain;
    for (const disc of t.discs) {
      if (!disc.sample) continue;
      const centre = { x: disc.cx, y: disc.cy, z: disc.cz };
      await store.ensure(t.discRequests(centre, 1), slot);
      t.main.setDir(centre.x, centre.y, centre.z);
      t.main.incomplete = false;
      const h = t.main.naturalDataHeight();
      if (t.main.incomplete) throw new Error(`${disc.source}: data at the disc centre did not load`);
      disc.elevation = h;
    }
    await store.ensure([], slot);
  };
  // The preloaded bodies: v1's sequence exactly (every manifest, then every pyramid pinned forever, then the discs).
  for (const id of preloaded) bodies.set(id, makeRuntime(id, await tileSource.manifest(defs.bodies[id]!.terrain!.tileset)));
  for (const id of preloaded) {
    const b = bodies.get(id)!;
    await store.ensure(b.terrain.pyramidRequests(b.terrain.residentLevel), null, true);
  }
  for (const id of preloaded) await sampleDiscs(bodies.get(id)!, '__disc-elevation');

  // Lazy bodies (the module comment).
  const lazy = new Map<string, LazyBody>();
  for (const id of ids) if (!preloaded.includes(id)) lazy.set(id, { generation: 0, loading: null, holders: new Set(), refs: [] });
  /** The body each slot holds (its latest request named it). */
  const slotBody = new Map<string, string>();
  const unloadedQueries: Record<string, number> = {};

  const releaseBody = (id: string): void => {
    const l = lazy.get(id)!;
    l.generation++;
    l.loading = null;
    if (bodies.has(id)) {
      store.releaseSlot(`__resident:${id}`);
      store.dropLayers(l.refs);
      bodies.delete(id);
    }
  };
  /** Point `slot` at `bodyId`; the lazy body it held before is released when nothing else holds it. */
  const holdWith = (slot: string, bodyId: string): void => {
    const prev = slotBody.get(slot);
    if (prev === bodyId) return;
    slotBody.set(slot, bodyId);
    lazy.get(bodyId)?.holders.add(slot);
    if (prev !== undefined) {
      const l = lazy.get(prev);
      if (l) {
        l.holders.delete(slot);
        if (l.holders.size === 0) releaseBody(prev);
      }
    }
  };
  const load = (id: string): Promise<void> => {
    const l = lazy.get(id);
    if (!l || (bodies.has(id) && l.loading === null)) return Promise.resolve();
    if (l.loading) return l.loading;
    const gen = l.generation;
    const job = (async (): Promise<void> => {
      const manifest = await tileSource.manifest(defs.bodies[id]!.terrain!.tileset);
      if (l.generation !== gen) return;
      const b = makeRuntime(id, manifest);
      l.refs = b.terrain.lcRef ? [b.terrain.heightRef, b.terrain.lcRef] : [b.terrain.heightRef];
      bodies.set(id, b);
      await store.ensure(b.terrain.pyramidRequests(b.terrain.residentLevel), `__resident:${id}`);
      if (l.generation !== gen) return;
      await sampleDiscs(b, `__disc-elevation:${id}`);
    })();
    l.loading = job.then(() => {
      if (l.generation === gen) l.loading = null;
    });
    return l.loading;
  };

  const get = (bodyId: string): BodyRuntime => {
    const b = bodies.get(bodyId);
    if (!b) {
      if (lazy.has(bodyId)) throw new Error(`terrain: body "${bodyId}" is not loaded (lazy residency): await ensureLoaded, prepareTile or loadBody first`);
      throw new Error(`terrain: body "${bodyId}" is not served by this provider (served: ${ids.join(', ')})`);
    }
    return b;
  };
  /** The runtime of a served body, or null when it is lazy and not loaded (the query is counted). */
  const loaded = (bodyId: string): BodyRuntime | null => {
    const b = bodies.get(bodyId);
    const l = lazy.get(bodyId);
    if (b && (!l || l.loading === null)) return b;
    if (!b && !l) throw new Error(`terrain: body "${bodyId}" is not served by this provider (served: ${ids.join(', ')})`);
    unloadedQueries[bodyId] = (unloadedQueries[bodyId] ?? 0) + 1;
    return null;
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
    const b = loaded(bodyId);
    // a lazy body that is not loaded: the datum surface (the module comment)
    if (!b) return 0;
    const d = unit(dir);
    if (lambdaMin === undefined) return b.collision.heightAt(d);
    const ev = b.terrain.main;
    ev.setDir(d.x, d.y, d.z);
    ev.incomplete = false;
    return ev.height(log2Band(lambdaMin));
  };

  const pinnedBand = (bodyId: string): number => {
    if (!ids.includes(bodyId)) throw new Error(`terrain: body "${bodyId}" is not served by this provider (served: ${ids.join(', ')})`);
    const b = bodies.get(bodyId);
    // a lazy body not loaded yet: its runtime (and so lambda0) is not built; heightAt answers the datum for it
    return b ? 2 ** (b.terrain.log2Lambda0 - b.terrain.residentLevel) : Infinity;
  };

  const authority: TerrainAuthority = {
    pinnedBand,
    stableHeightAt(bodyId: string, dir: Vec3, lambdaMin: number): number {
      const band = pinnedBand(bodyId);
      return heightAt(bodyId, dir, Number.isFinite(band) ? Math.max(lambdaMin, band) : lambdaMin);
    },
    bodyIds: ids,
    preloadedIds: preloaded,

    loadedBodies(): string[] {
      return [...bodies.keys()].filter((id) => lazy.get(id)?.loading == null).sort();
    },

    loadBody(bodyId: string, slot?: string): Promise<void> {
      if (!ids.includes(bodyId)) throw new Error(`terrain: body "${bodyId}" is not served by this provider (served: ${ids.join(', ')})`);
      holdWith(slot ?? `body:${bodyId}`, bodyId);
      return load(bodyId);
    },

    release(slot: string): void {
      store.releaseSlot(slot);
      const prev = slotBody.get(slot);
      if (prev === undefined) return;
      slotBody.delete(slot);
      const l = lazy.get(prev);
      if (l) {
        l.holders.delete(slot);
        if (l.holders.size === 0) releaseBody(prev);
      }
    },

    heightAt,

    normalAt(bodyId: string, dir: Vec3, baseline: number): Vec3 {
      store.tick++;
      const b = loaded(bodyId);
      const d = unit(dir);
      if (!b) return d;
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
      const b = loaded(bodyId);
      const ocean = defs.bodies[bodyId]!.ocean;
      if (!ocean) return 'land';
      return (b ? b.collision.heightAt(unit(dir)) : 0) < ocean.seaLevel ? 'water' : 'land';
    },

    ensureLoaded(bodyId: string, dir: Vec3, radius: number, slot?: string): Promise<void> {
      store.tick++;
      const name = slot ?? 'default';
      const pinDisc = (): Promise<void> => {
        const b = get(bodyId);
        // The collision memo is allocated here (async context) rather than inside the first contact query.
        b.collision.allocate();
        return store.ensure(b.terrain.discRequests(unit(dir), Math.max(0, radius)), name);
      };
      if (!lazy.has(bodyId)) {
        if (!bodies.has(bodyId)) get(bodyId);
        const p = pinDisc();
        holdWith(name, bodyId);
        return p;
      }
      holdWith(name, bodyId);
      const l = lazy.get(bodyId)!;
      if (bodies.has(bodyId) && l.loading === null) return pinDisc();
      const gen = l.generation;
      return load(bodyId).then(() => {
        // a release in between (the slot moved on): nothing to pin
        if (l.generation !== gen || slotBody.get(name) !== bodyId) return;
        return pinDisc();
      });
    },

    /** On a lazy body that is not loaded this throws: the protocol warms an area only after ensureLoaded resolved. */
    prewarmCollision(bodyId: string, dir: Vec3, radius: number, maxVertices: number): number {
      store.tick++;
      return get(bodyId).collision.prewarm(unit(dir), Math.max(0, radius), maxVertices);
    },

    residency(bodyId: string, dir: Vec3): TerrainResidency {
      store.tick++;
      const b = loaded(bodyId);
      if (!b) return { residentLevel: -1, availableLevel: -1, effectiveLevel: 0, complete: false };
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
      if (!ids.includes(bodyId)) get(bodyId);
      const t = defs.bodies[bodyId]!.terrain!;
      return { min: t.minElevation, max: t.maxElevation };
    },

    rocksNear(bodyId: string, dir: Vec3, radius: number, minRadius: number): RockInstance[] {
      store.tick++;
      const b = loaded(bodyId);
      if (!b) return [];
      const model = b.terrain.model;
      if (!model.rocks) return [];
      const d = unit(dir);
      const r = Math.max(0, radius);
      const list = model.rocks.rocksIn(d, r, Math.max(0, minRadius), model.rockAbundance, model.rockAbundanceBound);
      const ev = b.terrain.main;
      return list.map((c) => {
        const inst = toInstance(c, 0);
        ev.setDir(inst.dir.x, inst.dir.y, inst.dir.z);
        inst.baseHeight = ev.height(b.terrain.collisionLog2Lambda, false);
        return inst;
      });
    },

    prepareTile(bodyId: string, key: TileKey, slot?: string): Promise<void> {
      store.tick++;
      const name = slot ?? 'bake';
      const pinTile = (): Promise<void> => store.ensure(get(bodyId).terrain.tileRequests(key.face, key.level, key.x, key.y), name);
      if (!lazy.has(bodyId)) {
        const p = pinTile();
        holdWith(name, bodyId);
        return p;
      }
      holdWith(name, bodyId);
      const l = lazy.get(bodyId)!;
      if (bodies.has(bodyId) && l.loading === null) return pinTile();
      const gen = l.generation;
      return load(bodyId).then(() => {
        if (l.generation !== gen || slotBody.get(name) !== bodyId) return;
        return pinTile();
      });
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
      const collisionMemoBytes: Record<string, number> = {};
      const prewarmWork: Record<string, number> = {};
      const prewarm: Record<string, { radius: number; clamped: boolean } | null> = {};
      const seamWrites: Record<string, number> = {};
      for (const [id, b] of bodies) {
        vertexEvaluations[id] = b.collision.vertexEvaluations;
        collisionTiles[id] = b.collision.tileCount;
        collisionMemoBytes[id] = b.collision.memoBytes;
        prewarmWork[id] = b.collision.prewarmWork;
        prewarm[id] = b.collision.prewarmState;
        seamWrites[id] = b.terrain.seams.writes;
      }
      const residency: TerrainDiagnostics['residency'] = {};
      for (const id of ids) {
        const l = lazy.get(id);
        residency[id] = !l
          ? { state: 'preloaded', holders: [] }
          : { state: l.loading !== null ? 'loading' : bodies.has(id) ? 'loaded' : 'unloaded', holders: [...l.holders].sort() };
      }
      return { vertexEvaluations, collisionTiles, collisionMemoBytes, prewarmWork, prewarm, seamWrites, cache: store.stats(), residency, unloadedQueries: { ...unloadedQueries } };
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
