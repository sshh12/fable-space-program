/**
 * Decoded-tile cache shared by every body of one provider instance.
 *
 *  - Byte-budgeted LRU. The budget counts resident AND in-flight tiles (their decoded size is known before
 *    loading), so every eviction decision is taken synchronously inside the call that needs room.
 *  - "Use" order is a call-sequence counter (`tick`), never wall-clock or completion order: eviction order
 *    therefore depends only on the sequence of calls, identically on the main thread and in a worker.
 *  - Pins: permanent tiles (the resident pyramid levels) and per-slot pins (`ensure(..., slot)`); a new
 *    request for a slot replaces that slot's previous pin set.
 *  - Lookups are synchronous; loading is asynchronous through a TileSource.
 */
import type { FaceId } from '../core/geo/cubeSphere';
import type { TileSource } from '../core/contracts/terrain';
import { decodeTileFile, HEIGHT_TILE_BORDER, HEIGHT_TILE_STORED, IMAGE_TILE_SIZE } from '../core/geo/tileCodec';
import type { LayerCoverage } from './coverage';
import { tileNumber } from './util';

/** Fixed bookkeeping cost per entry counted against the budget, bytes. */
const ENTRY_OVERHEAD = 256;

export type LayerKind = 'height' | 'u8';

/** One tile layer of one body. */
export class LayerRef {
  /** Changes whenever a tile of this layer becomes resident or is evicted. */
  generation = 0;
  readonly maps: Map<number, TileEntry>[] = [];
  readonly bytesPerTile: number;

  constructor(
    readonly tileset: string,
    readonly layer: string,
    readonly kind: LayerKind,
    readonly coverage: LayerCoverage,
    /** u8 layers: channels per texel. */
    readonly channels: number,
  ) {
    for (let l = 0; l <= coverage.maxLevel; l++) this.maps.push(new Map());
    this.bytesPerTile =
      ENTRY_OVERHEAD + (kind === 'height' ? HEIGHT_TILE_STORED * HEIGHT_TILE_STORED * 2 : IMAGE_TILE_SIZE * IMAGE_TILE_SIZE * channels);
  }
}

export class TileEntry {
  state: 'pending' | 'resident' = 'pending';
  /** Removed from the cache (evicted, or failed to load); a pending load then discards its result. */
  removed = false;
  /** height: int16 counts, value = offset + scale * q, row-major 259 x 259 (row = v). */
  q: Int16Array | null = null;
  scale = 1;
  offset = 0;
  hMin = 0;
  hMax = 0;
  /** u8: 256 x 256 x channels. */
  data: Uint8Array | null = null;
  lastUse = 0;
  pins = 0;
  permanent = false;
  promise: Promise<void> | null = null;

  constructor(
    readonly ref: LayerRef,
    readonly level: number,
    readonly face: number,
    readonly x: number,
    readonly y: number,
    readonly num: number,
    /** Insertion sequence number: deterministic tie-break between equal lastUse values. */
    readonly seq: number,
  ) {}
}

export interface TileRequest {
  ref: LayerRef;
  level: number;
  face: number;
  x: number;
  y: number;
}

export class TileStore {
  /** Call-sequence counter; the provider advances it once per public call. */
  tick = 0;
  /** Bytes of resident + in-flight tiles. */
  bytesUsed = 0;
  private seq = 0;
  private readonly slots = new Map<string, TileEntry[]>();
  private readonly all = new Set<TileEntry>();

  constructor(
    private readonly source: TileSource,
    readonly budgetBytes: number,
  ) {}

  /** Resident entry or undefined; marks the tile as used by the current call (also while pending). */
  get(ref: LayerRef, level: number, num: number): TileEntry | undefined {
    const e = ref.maps[level]?.get(num);
    if (!e) return undefined;
    e.lastUse = this.tick;
    return e.state === 'resident' ? e : undefined;
  }

  /** Like get() but without touching the use order (fallback probes must not perturb eviction). */
  peek(ref: LayerRef, level: number, num: number): TileEntry | undefined {
    const e = ref.maps[level]?.get(num);
    return e && e.state === 'resident' ? e : undefined;
  }

  /** Number of entries and their bytes (resident + pending). */
  stats(): { tiles: number; resident: number; pending: number; bytes: number; budget: number } {
    let resident = 0;
    let pending = 0;
    for (const e of this.all) {
      if (e.state === 'resident') resident++;
      else pending++;
    }
    return { tiles: this.all.size, resident, pending, bytes: this.bytesUsed, budget: this.budgetBytes };
  }

  /** Keys of all cached tiles in a canonical order (for determinism tests). */
  residentKeys(): string[] {
    const out: string[] = [];
    for (const e of this.all) out.push(`${e.ref.tileset}/${e.ref.layer}/${e.face}/${e.level}/${e.x}/${e.y}${e.state === 'pending' ? '*' : ''}`);
    return out.sort();
  }

  /**
   * Make every requested tile resident. `slot`: pin the set under this name, replacing the slot's previous
   * pins; null = no pin (subject to LRU). `permanent`: pin forever (resident pyramid levels).
   * Rejects when the pinned set cannot fit the budget or a tile fails to load.
   */
  ensure(requests: readonly TileRequest[], slot: string | null, permanent = false): Promise<void> {
    // Resolve requests to entries (deduplicated, in request order).
    const wanted: TileEntry[] = [];
    const fresh: TileEntry[] = [];
    const freshByKey = new Map<LayerRef, Map<string, TileEntry>>();
    const seen = new Set<TileEntry>();
    for (const r of requests) {
      const num = tileNumber(r.level, r.face, r.x, r.y);
      let e = r.ref.maps[r.level]?.get(num);
      if (!e) {
        let m = freshByKey.get(r.ref);
        if (!m) freshByKey.set(r.ref, (m = new Map()));
        const k = `${r.level}/${num}`;
        e = m.get(k);
        if (!e) {
          e = new TileEntry(r.ref, r.level, r.face, r.x, r.y, num, this.seq++);
          m.set(k, e);
          fresh.push(e);
        }
      }
      if (!seen.has(e)) {
        seen.add(e);
        wanted.push(e);
      }
    }
    // Pin the new set before releasing the old one so shared tiles never become evictable in between.
    const previous = slot !== null ? (this.slots.get(slot) ?? []) : [];
    if (slot !== null) {
      for (const e of wanted) e.pins++;
      for (const e of previous) e.pins--;
      this.slots.set(slot, wanted);
    }
    if (permanent) for (const e of wanted) e.permanent = true;
    for (const e of wanted) e.lastUse = this.tick;

    // Make room for the new entries (synchronously, in call order).
    let need = 0;
    for (const e of fresh) need += e.ref.bytesPerTile;
    if (this.bytesUsed + need > this.budgetBytes) {
      const victims: TileEntry[] = [];
      for (const e of this.all) if (e.pins === 0 && !e.permanent && !seen.has(e)) victims.push(e);
      victims.sort((a, b) => a.lastUse - b.lastUse || a.seq - b.seq);
      let freed = 0;
      let k = 0;
      while (this.bytesUsed - freed + need > this.budgetBytes && k < victims.length) freed += victims[k++]!.ref.bytesPerTile;
      if (this.bytesUsed - freed + need > this.budgetBytes) {
        // Undo the pin change and refuse: the caller asked for more than the budget can hold.
        if (slot !== null) {
          for (const e of previous) e.pins++;
          for (const e of wanted) e.pins--;
          if (previous.length > 0) this.slots.set(slot, previous);
          else this.slots.delete(slot);
        }
        return Promise.reject(
          new Error(
            `terrain tile cache: ${need} bytes of new tiles do not fit the budget of ${this.budgetBytes} bytes (${this.bytesUsed} in use, ${freed} evictable); raise opts.cacheBytes or request a smaller radius`,
          ),
        );
      }
      for (let i = 0; i < k; i++) this.remove(victims[i]!);
    }
    for (const e of fresh) {
      e.ref.maps[e.level]!.set(e.num, e);
      this.all.add(e);
      this.bytesUsed += e.ref.bytesPerTile;
      e.promise = this.load(e);
    }
    return Promise.all(wanted.map((e) => e.promise!)).then(() => undefined);
  }

  private remove(e: TileEntry): void {
    if (e.removed) return;
    e.removed = true;
    e.ref.maps[e.level]?.delete(e.num);
    this.all.delete(e);
    this.bytesUsed -= e.ref.bytesPerTile;
    if (e.state === 'resident') e.ref.generation++;
    e.q = null;
    e.data = null;
  }

  private async load(e: TileEntry): Promise<void> {
    const key = { face: e.face as FaceId, level: e.level, x: e.x, y: e.y };
    try {
      const bytes = await this.source.tile(e.ref.tileset, e.ref.layer, key);
      if (bytes === null) throw new Error(`tile ${e.ref.tileset}/${e.ref.layer}/${e.face}/${e.level}/${e.x}/${e.y}: the tile source returned no data for a tile the manifest promises`);
      const raster = await decodeTileFile(bytes);
      if (e.removed) return;
      if (e.ref.kind === 'height') {
        if (raster.kind !== 'height' || raster.width !== HEIGHT_TILE_STORED || raster.height !== HEIGHT_TILE_STORED || raster.border !== HEIGHT_TILE_BORDER)
          throw new Error(`tile ${e.ref.tileset}/${e.ref.layer}/${e.face}/${e.level}/${e.x}/${e.y}: expected a ${HEIGHT_TILE_STORED}x${HEIGHT_TILE_STORED} FRT1 height tile with a 1-sample border`);
        const n = raster.heights.length;
        const q = new Int16Array(n);
        const inv = 1 / raster.scale;
        for (let i = 0; i < n; i++) q[i] = Math.round((raster.heights[i]! - raster.offset) * inv);
        e.q = q;
        e.scale = raster.scale;
        e.offset = raster.offset;
        e.hMin = raster.hMin;
        e.hMax = raster.hMax;
      } else {
        if (raster.kind !== 'u8' || raster.width !== IMAGE_TILE_SIZE || raster.height !== IMAGE_TILE_SIZE || raster.channels !== e.ref.channels)
          throw new Error(`tile ${e.ref.tileset}/${e.ref.layer}/${e.face}/${e.level}/${e.x}/${e.y}: expected a ${IMAGE_TILE_SIZE}x${IMAGE_TILE_SIZE}x${e.ref.channels} FRT1 u8 tile`);
        e.data = raster.data;
      }
      e.state = 'resident';
      e.ref.generation++;
    } catch (err) {
      this.remove(e);
      throw err;
    }
  }
}
