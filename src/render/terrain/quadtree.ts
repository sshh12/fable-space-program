/**
 * Cube-sphere quadtree of one body and the per-frame LOD selection (CDLOD with per-child ranges, frustum
 * and horizon culling, ancestor fallback by quadrant, fade-in bookkeeping, shadow-caster walks).
 * Float64, no GPU: the streaming layer supplies tile data and reads `wanted`; the feature turns `items`
 * into instance records.
 */
import type { FaceId, TileKey } from '@/core/geo/cubeSphere';
import type { Vec3 } from '@/core/math';
import { capMaxLevel, levelRange, type MorphWindow, type ReliefFloor } from './lod';
import { frameDir, shellBoundSphere, tileFrame, tileId, type BoundSphere, type TileFrame } from './tileMath';

export const TILE_EMPTY = 0;
export const TILE_QUEUED = 1;
export const TILE_LOADING = 2;
export const TILE_UPLOADING = 3;
export const TILE_READY = 4;
export type TileState = typeof TILE_EMPTY | typeof TILE_QUEUED | typeof TILE_LOADING | typeof TILE_UPLOADING | typeof TILE_READY;

/** Layer value of a tile whose night-light image is completely dark (no layer is spent on it). */
export const NIGHT_DARK = -2;

export class TileNode {
  readonly id: number;
  readonly frame: TileFrame;
  children: [TileNode, TileNode, TileNode, TileNode] | null = null;
  /** Height range of the vertices this tile can produce (own level and the morph towards the parent), m. */
  hMin: number;
  hMax: number;
  sphere: BoundSphere;
  /**
   * Bound for visibility tests. On a body with a sea the far water sheet is drawn from the same tile at sea
   * level: over deep water that is kilometres above the tile's own shell, and in view when the sea bed
   * under it is not (a low camera looks over the sea, not into it).
   */
  cull: BoundSphere;
  /** Largest height (m) of anything drawn from the tile: its terrain or the sea surface over it. */
  cullTop: number;
  /** Largest angle between the tile's centre direction and a point of its footprint, rad. */
  readonly angularRadius: number;

  state: TileState = TILE_EMPTY;
  /** Layers in the shared pools (-1 = none). `imageLayer` indexes the albedo and the aux array alike. */
  heightLayer = -1;
  normalLayer = -1;
  imageLayer = -1;
  nightLayer = -1;
  /** Nodes whose image layers this tile samples (itself or the ancestor at the deepest data level). */
  imageOwner: TileNode | null = null;
  nightOwner: TileNode | null = null;
  slopeScale = 1;
  /** Exact vertex height range of the bake. */
  bakeMin = 0;
  bakeMax = 0;
  /** Height of the tile origin above the reference radius and the origin in the body-fixed frame. */
  h0 = 0;
  origin: Vec3 = { x: 0, y: 0, z: 0 };
  /** Per-tile shader constants computed once when the tile becomes ready (see records.ts). */
  constants: Float32Array | null = null;
  /** Number of children in state READY or with ready descendants (a tile with ready children is pinned). */
  readyChildren = 0;
  /** Pinned forever (always-resident levels). */
  pinned = false;
  /** A worker failed on this tile: it is not requested again (the error has been reported). */
  failed = false;
  /** Requested by a preload of coarse levels: pinned only until it has been uploaded. */
  preload = false;

  /** Frame bookkeeping. */
  lastTouched = -1;
  lastCovered = -2;
  activatedAt = -1e9;
  fadeSeconds = 0;
  /** Index of this tile's record in the frame's record buffer, valid when recordFrame is the current frame. */
  recordIndex = -1;
  recordFrame = -1;
  /** Frame in which the camera selection emitted this node (whole or by quadrants) and its slice of `items`. */
  selectedFrame = -1;
  itemStart = 0;
  itemCount = 0;
  /** Request priority of the current frame (streaming). */
  priority = 0;
  wantedFrame = -1;
  /**
   * Warp cap under which the tile is drawn (the largest cap of the observers within the range of its level)
   * and the frame of the camera selection that set it: the tile's morph floor is capMorph(level, cap).
   */
  cap = 0;
  capFrame = -1;
  /** Frame in which a counted selection pass last used the tile (drawn, a parent of something drawn, or wanted): the pools' live demand. */
  neededFrame = -1;
  /** The tile found no room in a full pool and was given up: it is not requested again before this frame. */
  deferUntil = -1;
  /** Frame in which the tile's request entered the queue. */
  queuedAt = -1;

  constructor(
    readonly key: TileKey,
    readonly parent: TileNode | null,
    radius: number,
    hMin: number,
    hMax: number,
    sheet: number | null = null,
  ) {
    this.id = tileId(key.face, key.level, key.x, key.y);
    this.frame = tileFrame(key);
    this.hMin = hMin;
    this.hMax = hMax;
    this.sphere = shellBoundSphere(this.frame, radius + hMin, radius + hMax);
    this.cullTop = sheet !== null && hMax < sheet ? sheet : hMax;
    this.cull = this.cullTop === hMax ? this.sphere : shellBoundSphere(this.frame, radius + hMin, radius + this.cullTop);
    let cosMin = 1;
    for (const c of this.frame.corners) cosMin = Math.min(cosMin, c.x * this.frame.cHat.x + c.y * this.frame.cHat.y + c.z * this.frame.cHat.z);
    this.angularRadius = Math.acos(Math.min(1, cosMin));
  }

  get level(): number {
    return this.key.level;
  }

  /** `sheet` = height of the sea surface on a body with an ocean, else null. */
  setBounds(radius: number, hMin: number, hMax: number, sheet: number | null = null): void {
    this.hMin = hMin;
    this.hMax = hMax;
    this.sphere = shellBoundSphere(this.frame, radius + hMin, radius + hMax);
    this.cullTop = sheet !== null && hMax < sheet ? sheet : hMax;
    this.cull = this.cullTop === hMax ? this.sphere : shellBoundSphere(this.frame, radius + hMin, radius + this.cullTop);
  }
}

export interface LodObserverFixed {
  /** Position in the body-fixed frame (m), its length and unit direction. */
  pos: Vec3;
  r: number;
  dir: Vec3;
  /** Metres subtracted from distances (LodObserver.radiusBias). */
  bias: number;
  /** True for vessel observers (their surroundings are requested with priority). */
  vessel: boolean;
  /**
   * Fractional warp cap (lod.ts) of the ground this observer moves over; absent: SelectParams.cap. Each
   * observer brings its own cap to the tiles within its ranges: a far camera that sweeps the body at
   * kilometres per second (the map view over a turning planet, a warp pass) does not coarsen the ground under
   * a vessel that stands still.
   */
  cap?: number;
}

export interface ViewFrustum {
  /** Eye in the body-fixed frame. */
  eye: Vec3;
  /** Inward unit normals of the four side planes through the eye, body-fixed axes. */
  planes: [Vec3, Vec3, Vec3, Vec3];
}

export interface SelectParams {
  frameIndex: number;
  /** Seconds (wall clock of the frame) for fade-in bookkeeping. */
  time: number;
  observers: readonly LodObserverFixed[];
  K: number;
  window: MorphWindow;
  /** Fractional warp cap (lod.ts) and the hard maximum render level of the body. */
  cap: number;
  maxLevel: number;
  /** null: no culling (prefetch passes and tests). */
  frustum: ViewFrustum | null;
  /** Floor under the level ranges (lod.ts), or none. */
  relief?: ReliefFloor | null;
  /** Radius of the sphere that occludes terrain beyond the horizon (0 = no horizon culling). */
  occluderRadius: number;
  /** Fade-in duration given to tiles activated in this frame (0 right at a camera cut). */
  fadeSeconds: number;
  /** Request-only pass (prefetch): nothing is emitted or activated; priorities are scaled by this. */
  prefetch: number;
  /**
   * The tiles this pass uses count as live demand on the pools (TileNode.neededFrame). Default: camera
   * selections do, request-only passes do not.
   */
  counted?: boolean;
  /**
   * Ask for the tiles under the view EAGER_LEVELS levels at a time: where a wanted tile is not resident, its
   * children and theirs are wanted as well, judged by the bounds they inherit (a little wider than their own
   * will be). After a cut and at the start the workers then stay busy and a view streams in a third of the
   * round trips (request app-integration-11). Deeper than that the inherited bounds are too wide to ask by:
   * the whole chain at once asked for twice the tiles of the pad view.
   */
  eager?: boolean;
}

export interface DrawItem {
  node: TileNode;
  /** -1 = the whole tile, 0..3 = one quadrant (x + 2 y). */
  quadrant: number;
  /** Inside the true view frustum and above the horizon. */
  visible: boolean;
}

/** Tiles kept around every observer regardless of the frustum, in tile sizes of their level. */
const NEAR_KEEP_TILES = 1.25;
/** Guard band of the frustum for selection and requests, in tile sizes of the level. */
const GUARD_TILES = 1.0;
/** Levels below the resident tiles that an eager pass asks for at once (SelectParams.eager). */
export const EAGER_LEVELS = 3;

export class BodyQuadtree {
  readonly roots: TileNode[] = [];
  readonly faceSize: number;
  /** Items of the last camera selection. */
  readonly items: DrawItem[] = [];
  /** Tiles the last selection passes want but that are not ready, with `priority` set. */
  readonly wanted: TileNode[] = [];
  /** Tiles still fading in after the last camera selection. */
  fading = 0;
  private readonly nodes = new Map<number, TileNode>();
  private p!: SelectParams;

  constructor(
    readonly radius: number,
    readonly elevMin: number,
    readonly elevMax: number,
    /** Height of the sea surface (m above the reference radius) on a body with an ocean, else null. */
    readonly seaLevel: number | null = null,
  ) {
    this.faceSize = (Math.PI * radius) / 2;
    for (let face = 0; face < 6; face++) {
      const n = new TileNode({ face: face as FaceId, level: 0, x: 0, y: 0 }, null, radius, elevMin, elevMax, seaLevel);
      this.nodes.set(n.id, n);
      this.roots.push(n);
    }
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  node(key: TileKey): TileNode | undefined {
    return this.nodes.get(tileId(key.face, key.level, key.x, key.y));
  }

  /** The node of `key`, creating it and its ancestors as needed. */
  ensureNode(key: TileKey): TileNode {
    const have = this.node(key);
    if (have) return have;
    const parent = this.ensureNode({ face: key.face, level: key.level - 1, x: key.x >> 1, y: key.y >> 1 });
    return this.childrenOf(parent)[(key.x & 1) + 2 * (key.y & 1)]!;
  }

  childrenOf(n: TileNode): [TileNode, TileNode, TileNode, TileNode] {
    if (n.children) return n.children;
    const k = n.key;
    const d = this.heightSlack(k.level + 1);
    const mk = (q: number): TileNode => {
      const c = new TileNode({ face: k.face, level: k.level + 1, x: 2 * k.x + (q & 1), y: 2 * k.y + (q >> 1) }, n, this.radius, n.hMin - d, n.hMax + d, this.seaLevel);
      this.nodes.set(c.id, c);
      return c;
    };
    n.children = [mk(0), mk(1), mk(2), mk(3)];
    return n.children;
  }

  /** Bound on how far the surface of a level-`level` tile leaves the height range of its parent tile, m. */
  heightSlack(level: number): number {
    return 0.015 * (this.faceSize / 2 ** level) + 0.25;
  }

  /** Bounds of a baked tile: its own vertices plus the morph towards the parent's surface. */
  applyBake(n: TileNode, hMin: number, hMax: number): void {
    n.bakeMin = hMin;
    n.bakeMax = hMax;
    const d = this.heightSlack(n.level);
    const p = n.parent;
    const lo = p ? Math.min(hMin, Math.max(p.hMin, hMin - d)) : hMin;
    const hi = p ? Math.max(hMax, Math.min(p.hMax, hMax + d)) : hMax;
    n.setBounds(this.radius, lo, hi, this.seaLevel);
  }

  /** Drop the subtree below `n` from the node table (the caller has released their GPU layers). */
  dropChildren(n: TileNode): void {
    if (!n.children) return;
    for (const c of n.children) {
      this.dropChildren(c);
      this.nodes.delete(c.id);
    }
    n.children = null;
  }

  /**
   * Smallest distance (m, after the observers' bias) from any observer to the tile; a true lower bound of
   * vertex distances. `limit` = the range of the tile's own level (the distance beyond which it does not
   * matter). Also sets `capDraw` and `capSplit`: the largest warp cap of the observers within `limit` (under
   * which the tile is drawn) and within the range of its children (under which it may be refined).
   */
  distance(n: TileNode, limit: number): number {
    let best = Infinity;
    const s = n.sphere;
    const fr = n.frame;
    const r1 = this.radius + n.hMin;
    const r2 = this.radius + n.hMax;
    const p = this.p;
    const observers = p.observers;
    if (!this.mixedCaps) {
      for (let i = 0; i < observers.length; i++) {
        const o = observers[i]!;
        const ox = s.cx - o.pos.x;
        const oy = s.cy - o.pos.y;
        const oz = s.cz - o.pos.z;
        const dc = Math.sqrt(ox * ox + oy * oy + oz * oz);
        const lower = dc - s.r - o.bias;
        if (lower >= best || lower >= limit) {
          // Cannot beat the best so far, or is beyond the range that matters: the sphere bound is enough.
          if (lower < best) best = lower;
          continue;
        }
        const d = shellDistanceRaw(fr, o.dir, o.r, r1, r2) - o.bias;
        if (d < best) best = d;
      }
      this.capDraw = this.capSplit = this.commonCap;
      return best > 0 ? best : 0;
    }
    // Observers with different caps: every one within the limit is measured exactly, for its cap.
    const split = levelRange(n.level + 1, p.K, this.faceSize, p.relief);
    let capDraw = -1;
    let capSplit = -1;
    for (let i = 0; i < observers.length; i++) {
      const o = observers[i]!;
      const ox = s.cx - o.pos.x;
      const oy = s.cy - o.pos.y;
      const oz = s.cz - o.pos.z;
      const dc = Math.sqrt(ox * ox + oy * oy + oz * oz);
      const lower = dc - s.r - o.bias;
      if (lower >= limit) {
        if (lower < best) best = lower;
        continue;
      }
      const d = shellDistanceRaw(fr, o.dir, o.r, r1, r2) - o.bias;
      if (d < best) best = d;
      const cap = o.cap ?? p.cap;
      if (d < limit && cap > capDraw) capDraw = cap;
      if (d < split && cap > capSplit) capSplit = cap;
    }
    // Nobody within range: the tile is a coarse stand-in, held to the slowest observer's cap.
    this.capDraw = capDraw >= 0 ? capDraw : this.commonCap;
    this.capSplit = capSplit >= 0 ? capSplit : this.capDraw;
    return best > 0 ? best : 0;
  }

  /** Results of the last distance() besides the distance (see there). */
  private capDraw = 0;
  private capSplit = 0;
  /** Do the observers of the pass have different caps, and the cap they share (else the largest of them). */
  private mixedCaps = false;
  private commonCap = 0;

  private nearVessel(n: TileNode): boolean {
    const s = n.sphere;
    for (const o of this.p.observers) {
      if (!o.vessel) continue;
      const ox = s.cx - o.pos.x;
      const oy = s.cy - o.pos.y;
      const oz = s.cz - o.pos.z;
      if (Math.sqrt(ox * ox + oy * oy + oz * oz) - s.r < 2000) return true;
    }
    return false;
  }

  /** 0 = inside the frustum, 1 = inside the guard band only, 2 = outside. */
  private frustumClass(n: TileNode, d: number): 0 | 1 | 2 {
    const f = this.p.frustum;
    if (!f) return 0;
    const s = n.cull;
    const x = s.cx - f.eye.x;
    const y = s.cy - f.eye.y;
    const z = s.cz - f.eye.z;
    const size = this.faceSize / 2 ** n.level;
    const guard = GUARD_TILES * size;
    let cls: 0 | 1 | 2 = 0;
    for (let i = 0; i < 4; i++) {
      const pl = f.planes[i]!;
      const dist = pl.x * x + pl.y * y + pl.z * z;
      if (dist < -s.r) {
        if (dist < -(s.r + guard) && d > NEAR_KEEP_TILES * size) return 2;
        cls = 1;
      }
    }
    return cls;
  }

  /**
   * Is the whole tile hidden behind the occluder sphere? A point at radius r and angle a from the eye's
   * direction is visible iff a <= acos(Ro / rEye) + acos(Ro / r); every point of the tile is at least
   * (angle to the tile centre - angular radius) away and at most at radius R + cullTop (the terrain, or the
   * sea surface over it). Conservative and a handful of operations per tile.
   */
  private belowHorizon(n: TileNode, _d: number): boolean {
    if (this.horizonEye <= 0 || n.level < 2) return false;
    const c = n.frame.cHat;
    const e = this.eyeDir;
    const cos = c.x * e.x + c.y * e.y + c.z * e.z;
    const angle = Math.acos(cos > 1 ? 1 : cos < -1 ? -1 : cos) - n.angularRadius;
    if (angle <= this.horizonEye) return false;
    const ratio = this.p.occluderRadius / (this.radius + n.cullTop);
    return angle > this.horizonEye + (ratio >= 1 ? 0 : Math.acos(ratio));
  }

  /** Angle from the eye's direction to its horizon on the occluder sphere (0 = no horizon culling) and that direction. */
  private horizonEye = 0;
  private eyeDir: Vec3 = { x: 0, y: 0, z: 1 };

  /**
   * Camera selection. Fills `items` and appends to `wanted`. Only READY tiles are drawn; a missing or
   * not-yet-usable child leaves its quadrant to the parent.
   */
  select(params: SelectParams): void {
    this.p = params;
    this.horizonEye = 0;
    if (params.frustum && params.occluderRadius > 0) {
      const eye = params.frustum.eye;
      const r = Math.sqrt(eye.x * eye.x + eye.y * eye.y + eye.z * eye.z);
      if (r > params.occluderRadius) {
        this.horizonEye = Math.acos(params.occluderRadius / r);
        this.eyeDir = { x: eye.x / r, y: eye.y / r, z: eye.z / r };
      }
    }
    if (params.prefetch === 0) {
      this.items.length = 0;
      this.fading = 0;
    }
    this.counted = params.counted ?? params.prefetch === 0;
    let lo = Infinity;
    let hi = -Infinity;
    for (const o of params.observers) {
      const c = o.cap ?? params.cap;
      if (c < lo) lo = c;
      if (c > hi) hi = c;
    }
    this.mixedCaps = hi > lo;
    this.commonCap = params.observers.length > 0 ? hi : params.cap;
    for (const root of this.roots) {
      if (root.state !== TILE_READY) {
        this.want(root, 1e9, 0);
        continue;
      }
      const d = this.distance(root, Infinity);
      this.visit(root, d, params.frustum ? this.frustumClass(root, Infinity) : 0, this.capDraw, this.capSplit);
    }
  }

  private counted = false;

  private want(n: TileNode, priority: number, frustumClass: number, counted = this.counted): void {
    const p = this.p;
    // Given up for want of room (streamer.ts): its parent stands in until the retry time.
    if (n.deferUntil > p.frameIndex) return;
    if (counted) n.neededFrame = p.frameIndex;
    let pr = priority * (frustumClass === 0 ? 1 : 0.25);
    if (p.prefetch > 0) pr *= p.prefetch;
    if (n.wantedFrame !== p.frameIndex) {
      n.wantedFrame = p.frameIndex;
      n.priority = pr;
      this.wanted.push(n);
    } else if (pr > n.priority) {
      n.priority = pr;
    }
    n.lastTouched = p.frameIndex;
  }

  private visit(n: TileNode, d: number, cls: number, capDraw: number, capSplit: number): void {
    const p = this.p;
    const emitting = p.prefetch === 0;
    n.lastTouched = p.frameIndex;
    if (this.counted) n.neededFrame = p.frameIndex;
    let settled = true;
    if (emitting) {
      n.cap = capDraw;
      n.capFrame = p.frameIndex;
      if (n.lastCovered !== p.frameIndex - 1 && n.lastCovered !== p.frameIndex) {
        n.activatedAt = p.time;
        n.fadeSeconds = n.level === 0 ? 0 : p.fadeSeconds;
      }
      n.lastCovered = p.frameIndex;
      settled = p.time - n.activatedAt >= n.fadeSeconds;
      if (!settled) this.fading++;
    }
    const level = n.level;
    const childRange = levelRange(level + 1, p.K, this.faceSize, p.relief);
    if (level >= capMaxLevel(capSplit, p.maxLevel) || d >= childRange) {
      if (emitting) this.emit(n, -1, cls === 0);
      return;
    }
    const children = this.childrenOf(n);
    // Quadrants the node draws itself (child beyond its range, not ready, or culled), and which of those
    // can be seen (a quadrant whose child is outside the frustum or below the horizon cannot).
    let mask = 0;
    let seen = 0;
    for (let q = 0; q < 4; q++) {
      const c = children[q]!;
      const dc = this.distance(c, childRange);
      let visible = cls === 0;
      if (dc < childRange) {
        const ccls = this.frustumClass(c, dc);
        const hidden = this.belowHorizon(c, dc);
        if (ccls !== 2 && !hidden) {
          if (c.state === TILE_READY) {
            if (settled) {
              this.visit(c, dc, ccls, this.capDraw, this.capSplit);
              continue;
            }
            c.lastTouched = p.frameIndex;
            if (this.counted) c.neededFrame = p.frameIndex;
          } else {
            const size = this.faceSize / 2 ** c.level;
            this.want(c, (childRange / Math.max(dc, 0.05 * size)) * (this.nearVessel(c) ? 4 : 1), ccls);
            if (p.eager && c.deferUntil <= p.frameIndex) this.descend(c, dc, this.capSplit, 1);
          }
        }
        if (ccls !== 0 || hidden) visible = false;
      } else if (visible && emitting && p.frustum) {
        // Beyond the children's range: the quadrant is drawn at this level; cull it by its own bounds.
        visible = this.frustumClass(c, 0) === 0 && !this.belowHorizon(c, dc);
      }
      mask |= 1 << q;
      if (visible) seen |= 1 << q;
    }
    if (!emitting || mask === 0) return;
    if (mask === 15 && (seen === 15 || seen === 0)) this.emit(n, -1, seen === 15);
    else {
      for (let q = 0; q < 4; q++) if ((mask & (1 << q)) !== 0) this.emit(n, q, (seen & (1 << q)) !== 0);
    }
  }

  /**
   * Eager requests below a tile that is not resident yet (SelectParams.eager): its children within their
   * range, and theirs, EAGER_LEVELS levels in all. Nothing is drawn or activated; coarser tiles keep the higher priority (a fine tile is
   * of no use before its parents); and they are not counted as demand on the pools (the inherited bounds ask
   * for more than the view will use, and the fit of the ranges must not answer to that).
   */
  private descend(n: TileNode, d: number, capSplit: number, depth: number): void {
    const p = this.p;
    const level = n.level;
    const childRange = levelRange(level + 1, p.K, this.faceSize, p.relief);
    if (depth >= EAGER_LEVELS || level >= capMaxLevel(capSplit, p.maxLevel) || d >= childRange) return;
    const children = this.childrenOf(n);
    for (let q = 0; q < 4; q++) {
      const c = children[q]!;
      const dc = this.distance(c, childRange);
      if (dc >= childRange) continue;
      const cap = this.capSplit;
      const ccls = this.frustumClass(c, dc);
      if (ccls === 2 || this.belowHorizon(c, dc)) continue;
      if (c.state !== TILE_READY) {
        const size = this.faceSize / 2 ** c.level;
        this.want(c, 0.5 * (childRange / Math.max(dc, 0.05 * size)) * (this.nearVessel(c) ? 4 : 1), ccls, false);
      } else {
        c.lastTouched = p.frameIndex;
      }
      if (c.deferUntil <= p.frameIndex) this.descend(c, dc, cap, depth + 1);
    }
  }

  private emit(n: TileNode, quadrant: number, visible: boolean): void {
    if (n.selectedFrame !== this.p.frameIndex) {
      n.selectedFrame = this.p.frameIndex;
      n.itemStart = this.items.length;
      n.itemCount = 0;
    }
    n.itemCount++;
    this.items.push({ node: n, quadrant, visible });
  }

  /**
   * Casters for a shadow cascade: walk the READY tiles inside the cascade's clip rectangle down to
   * `targetLevel` (the level whose quads match the cascade's texels), never below a tile of the current
   * camera selection (so casters that are also receivers have the receivers' geometry), and never to a
   * tile that is not resident. `inside` tests a bounding sphere against the cascade.
   */
  selectCasters(frameIndex: number, targetLevel: number, inside: (s: BoundSphere) => boolean, out: DrawItem[]): void {
    const walk = (n: TileNode): void => {
      if (!inside(n.sphere)) return;
      if (n.selectedFrame === frameIndex) {
        // Emit exactly what the camera selection drew of this tile, then continue into refined quadrants.
        for (let i = 0; i < n.itemCount; i++) out.push(this.items[n.itemStart + i]!);
        if (n.children) for (const c of n.children) if (c.lastCovered === frameIndex) walk(c);
        return;
      }
      if (n.level < targetLevel && n.children && n.children.every((c) => c.state === TILE_READY)) {
        for (const c of n.children) walk(c);
        return;
      }
      n.lastTouched = Math.max(n.lastTouched, frameIndex - 1);
      out.push({ node: n, quadrant: -1, visible: true });
    };
    for (const root of this.roots) if (root.state === TILE_READY) walk(root);
  }

  /** Every node (diagnostics, eviction scans). */
  allNodes(): IterableIterator<TileNode> {
    return this.nodes.values();
  }
}

/** shellDistance of tileMath.ts without allocations (the selection's inner loop). */
function shellDistanceRaw(fr: TileFrame, p: Vec3, rEye: number, r1: number, r2: number): number {
  const m = fr.edgeNormals;
  const c = fr.corners;
  let inside = p.x * fr.cHat.x + p.y * fr.cHat.y + p.z * fr.cHat.z > 0;
  let best = Math.PI;
  for (let i = 0; i < 4; i++) {
    const mi = m[i]!;
    const s = p.x * mi.x + p.y * mi.y + p.z * mi.z;
    if (s >= 0) continue;
    inside = false;
    const A = c[i]!;
    const B = c[(i + 1) & 3]!;
    let qx = p.x - s * mi.x;
    let qy = p.y - s * mi.y;
    let qz = p.z - s * mi.z;
    const ql = Math.sqrt(qx * qx + qy * qy + qz * qz);
    let ang = -1;
    if (ql > 1e-12) {
      qx /= ql;
      qy /= ql;
      qz /= ql;
      // (A x q) . m >= 0 and (q x B) . m >= 0: the foot lies on the arc.
      const t1 = (A.y * qz - A.z * qy) * mi.x + (A.z * qx - A.x * qz) * mi.y + (A.x * qy - A.y * qx) * mi.z;
      const t2 = (qy * B.z - qz * B.y) * mi.x + (qz * B.x - qx * B.z) * mi.y + (qx * B.y - qy * B.x) * mi.z;
      if (t1 >= 0 && t2 >= 0) ang = Math.asin(Math.min(1, -s));
    }
    if (ang < 0) {
      const ca = Math.sqrt((p.x - A.x) * (p.x - A.x) + (p.y - A.y) * (p.y - A.y) + (p.z - A.z) * (p.z - A.z));
      const cb = Math.sqrt((p.x - B.x) * (p.x - B.x) + (p.y - B.y) * (p.y - B.y) + (p.z - B.z) * (p.z - B.z));
      const ch = Math.min(ca, cb);
      ang = ch >= 2 ? Math.PI : 2 * Math.asin(ch / 2);
    }
    if (ang < best) best = ang;
  }
  if (inside) return Math.max(0, rEye - r2, r1 - rEye);
  const rs = Math.min(r2, Math.max(r1, rEye * Math.cos(best)));
  const sh = Math.sin(best / 2);
  const dr = rEye - rs;
  return Math.sqrt(dr * dr + 4 * rEye * rs * sh * sh);
}

/** Direction (body-fixed) of a tile-local point, for callers that only hold a node. */
export function nodeDir(n: TileNode, u: number, v: number): Vec3 {
  return frameDir(n.frame, u, v);
}
