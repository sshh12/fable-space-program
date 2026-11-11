/**
 * Builds the projected map geometry for one (snapshot, camera, viewport): sampled polylines of every
 * trajectory and reference orbit, markers, nodes, bodies, vessels and surface targets, all positioned in
 * float64 and projected by one Projector. Both the GPU draw list and hit-testing read this structure, so
 * the pointer is always tested against exactly what is drawn.
 *
 * The builder runs every frame the camera or the snapshot changes. It keeps its scratch storage (vertex
 * arrays, sampler, curve objects) between frames, and caches what depends on the snapshot alone (orbits of
 * other vessels, node locations, label text) for as long as its inputs are unchanged.
 */
import type { CameraState } from '@/core/contracts/render';
import type { DefLibrary } from '@/core/contracts/defs';
import type { ManeuverNode, Marker, MarkerKind, Patch, SimSnapshot, SurfaceTarget, VesselSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { conicFromState, conicMaxTrueAnomaly, conicPosition, conicRadiusCrossing, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { isFullRevolution } from './anomalyTime';
import { ViewConic } from './conicCurve';
import {
  AFTER_NODE_DIM,
  BODY_ICON_MAX_RADIUS_PX,
  CHORD_TOLERANCE_PX,
  CLIP_DEPTH_REL,
  COINCIDENT_PX,
  COLORS,
  DASH_PERIOD_PX,
  DEBRIS_CHORD_TOLERANCE_PX,
  FAINT_CHORD_TOLERANCE_PX,
  FAINT_LINE_WIDTH_PX,
  HOVER_ORBIT_WIDTH_PX,
  LIMB_DAY_FACTOR,
  LIMB_WIDTH_PX,
  LINE_WIDTH_PX,
  MAX_POINTS_PER_CURVE,
  OCCLUSION_FADE_PX,
  ORBIT_MIN_SPAN_PX,
  SMALL_OBJECT_PX,
  SURFACE_SLACK_MARGIN,
  TARGET_MIN_BODY_PX,
  VISIBLE_LIMB_OPTICAL_DEPTH,
  ZONE_LINE_WIDTH_PX,
  type Rgba,
} from './constants';
import { locateNode, type NodeLocation, type PatchKey, type PatchList } from './nodes';
import { occlusionWeight, visibleAtmosphereHeight, type Occluder } from './occlusion';
import { Projector, type Viewport } from './projection';
import { FAINT_MAX_TURN, Sampler, type SampledCurve } from './sampler';

const TWO_PI = 2 * Math.PI;
/** Time tolerance (s) when matching a planned patch to the current patch it continues. */
const UT_EPS = 1e-3;

/**
 * Breakpoints of a sampled line, kept from build to build under the line's id. While the conic keeps its
 * shape (a coasting vessel, a body orbit, an SOI circle) only the view changes between frames, so the next
 * build evaluates the curve at the same parameters and verifies the exact chord error of every piece
 * (`Sampler.resample`) instead of refining from scratch: one evaluation and one error per vertex, no
 * trigonometry, no heap. A piece over the tolerance, a changed shape or a range the breakpoints do not
 * cover falls back to a fresh sampling, so the drawn line is within the tolerance on every frame.
 */
interface BreakpointCache {
  kind: ViewConic['kind'];
  e: number;
  /** Tolerance (device px) the line is drawn to. */
  tolerance: number;
  /** The range was one whole revolution of an ellipse: the breakpoints serve any start parameter. */
  closed: boolean;
  n: number;
  u: Float64Array;
  c: Float64Array;
  s: Float64Array;
  /** Vertices of the fresh sampling's initial partition and its greatest piece error. */
  initial: number;
  maxError: number;
  /** Set when the view has zoomed out since the fresh sampling: the next build samples afresh. */
  stale: boolean;
  /** Build counter of the last use (unused entries are dropped). */
  used: number;
}
/**
 * A fresh sampling that will be re-used refines to this fraction of the tolerance, so a slowly turning or
 * zooming view does not push a piece over the tolerance in the next frames (about 12 % more vertices).
 */
const REUSE_HEADROOM = 0.8;
/** Breakpoints are dropped when the greatest error has fallen to this fraction of the fresh sampling's. */
const REUSE_OVER_REFINED = 0.5;
/** Largest change of eccentricity, as a fraction of |1 - e^2|, for which the breakpoints still apply. */
const REUSE_SHAPE_TOLERANCE = 1e-3;
/** Breakpoints closer than this to an end of the range (rad) are left out. */
const REUSE_PARAM_EPS = 1e-9;
/** Unused entries are swept every this many builds. */
const REUSE_SWEEP_BUILDS = 256;

export type LineKind = 'current' | 'planned' | 'vesselOrbit' | 'debrisOrbit' | 'bodyOrbit' | 'soi' | 'recoveryZone' | 'ghostBody' | 'limb';

export interface LineRecord {
  kind: LineKind;
  id: string;
  /** Vertex range in MapScene.verts. */
  start: number;
  count: number;
  color: Rgba;
  /** Device pixels. */
  width: number;
  dashed: boolean;
  /**
   * The sampled curve (for parameter -> anomaly on hit-testing); null for a radial (straight) patch. Curve
   * objects are reused by the next build: read it only while this scene is the current one.
   */
  curve: ViewConic | null;
  /** Set for trajectories of the active vessel. */
  patchKey?: PatchKey;
  patch?: Patch;
  /**
   * Trailing vertices that only close the seam of a whole ellipse (VertexArrays.appendLine): the ring itself
   * ends at `start + count - 1 - seam`, on its first vertex.
   */
  seam: number;
  /** Vertices on screen and in front of the eye (for tests and the lab statistics). */
  visibleVertices: number;
  /** Larger side of the screen bounding box of the vertices in front of the eye, device px. */
  span: number;
  capped: boolean;
  /** Curve evaluations the sampler spent on this line this frame. */
  evaluations: number;
  /**
   * Radial depth (m) below a body surface that still counts as on it in the occlusion test: non-zero for
   * lines lying on a body (recovery zones), whose chords dip below the sphere between vertices. The line is
   * tested against the sphere shrunk by this much, so the allowance does not grow toward the limb.
   */
  occlusionSlack: number;
  /** Drawn with the dark casing (every line except the body silhouettes, which lie on a bright limb). */
  casing: boolean;
}

/** A line sampled from a conic (every line except a radial patch). */
export type PatchCurveLine = LineRecord & { curve: ViewConic };

export type MarkerShape =
  | 'apoapsis'
  | 'periapsis'
  | 'inclination'
  | 'soiEnter'
  | 'soiExit'
  | 'impact'
  | 'entry'
  | 'closest'
  | 'node'
  | 'surfacePoint'
  | 'pin'
  | 'pad'
  | 'zone';

export interface PointItem {
  id: string;
  /** Screen position (device px) and whether it is drawable at all (in front of the eye). */
  x: number;
  y: number;
  front: boolean;
  /** Occlusion weight 0 (visible) .. 1 (hidden behind a body). */
  hidden: number;
  /** View-space position (float64). */
  view: Vec3;
}

export interface MarkerItem extends PointItem {
  /** A trajectory marker, the ground point of an impact / entry, or the first point of a patch in a new frame. */
  kind: MarkerKind | 'impactSurface' | 'entrySurface' | 'patchStart';
  marker: Marker;
  patchKey: PatchKey;
  shape: MarkerShape;
  color: Rgba;
  /** Short label (first line bright, rest dim) and the hover details. */
  label: string[];
  details: string[];
  priority: number;
  /** For a ground point (impactSurface / entrySurface): the trajectory marker it belongs to. */
  parent?: MarkerItem;
}

export interface NodeItem extends PointItem {
  loc: NodeLocation;
  /** Screen-space lines of the node frame: unit axis -> projected direction and foreshortening (0..1). */
  axes: { prograde: AxisScreen; normal: AxisScreen; radial: AxisScreen };
  /** ROOT position of the node (float64). */
  root: Vec3;
}

export interface AxisScreen {
  dx: number;
  dy: number;
  /** sin of the angle between the axis and the view ray: 1 = in the screen plane, 0 = along the ray. */
  extent: number;
}

export interface BodyItem extends PointItem {
  bodyId: string;
  name: string;
  /** Projected radius in device px. */
  radiusPx: number;
  small: boolean;
  ghost: boolean;
  label: string;
  /** Unit direction to the sun in view space (x right, y up, z toward the eye); 0, 0, 0 for the star itself. */
  sunX: number;
  sunY: number;
  sunZ: number;
  /** Display colour of the lit disc (the body's mean albedo colour, brightened), for its icon. */
  tint: Rgba;
  /** The body emits its own light (a star): its icon is not shaded. */
  star: boolean;
}

export interface VesselItem extends PointItem {
  vesselId: string;
  bodyId: string;
  name: string;
  active: boolean;
  debris: boolean;
  /** Screen direction of the velocity relative to the vessel's body (unit; 0, 0 when it points at the eye). */
  dirX: number;
  dirY: number;
}

export interface TargetItem extends PointItem {
  target: SurfaceTarget;
  shape: MarkerShape;
  color: Rgba;
}

/** An encounter body drawn where it was at the intercept (at-intercept drawing). */
export interface GhostBody {
  /** `<body>@intercept`, then `<body>@intercept#2`, ... for further encounters with the same body. */
  id: string;
  bodyId: string;
  /** ROOT position the encounter's patches are drawn around. */
  pos: Vec3;
  /** True when only the planned trajectory meets the body there. */
  plannedOnly: boolean;
}

/** Struct-of-arrays vertex storage of all polylines (float64). */
export class VertexArrays {
  capacity = 0;
  n = 0;
  vx = new Float64Array(0);
  vy = new Float64Array(0);
  vz = new Float64Array(0);
  sx = new Float64Array(0);
  sy = new Float64Array(0);
  u = new Float64Array(0);
  /** UT at the vertex (NaN when not meaningful). */
  t = new Float64Array(0);
  /** Cumulative screen length along the polyline over its drawn segments, device px; for a dashed patch the arc length in metres from the node (SceneBuilder.dashAlongPath). */
  len = new Float64Array(0);
  /** Dashed patches: the dash octave of the segment from this vertex (log2 of the world dash period, metres). */
  oct = new Float64Array(0);
  /** Per-vertex alpha multiplier (dimming after the first node). */
  alpha = new Float64Array(0);
  /** Fade with time ahead, 0 (now) .. 1 (far future): lowers alpha toward FADE_FLOOR and tints toward white. */
  fade = new Float64Array(0);
  /** 1 when the vertex lies in front of the eye (CLIP_DEPTH_REL); sx / sy are NaN otherwise. */
  front = new Uint8Array(0);
  /** 1 when the segment from this vertex to the next one is drawn (both ends in front, not the line's end). */
  seg = new Uint8Array(0);
  /**
   * 1 when the segment to the next vertex is not drawn but is the neighbour of a drawn one (the seam of a closed
   * ring): the GPU joins the drawn segments there instead of capping them.
   */
  join = new Uint8Array(0);
  /**
   * 1 when the segment to the next vertex lies on a higher-priority line and is not drawn (SceneBuilder.
   * suppressCoincident). It stays a segment for hit-testing and node sliding (`seg` is unchanged).
   */
  cover = new Uint8Array(0);

  reserve(extra: number): void {
    const need = this.n + extra;
    if (need <= this.capacity) return;
    const cap = Math.max(need, Math.ceil(this.capacity * 1.5), 4096);
    const grow = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const b = new Float64Array(cap);
      b.set(a.subarray(0, this.n));
      return b;
    };
    const grow8 = (a: Uint8Array): Uint8Array<ArrayBuffer> => {
      const b = new Uint8Array(cap);
      b.set(a.subarray(0, this.n));
      return b;
    };
    this.vx = grow(this.vx);
    this.vy = grow(this.vy);
    this.vz = grow(this.vz);
    this.sx = grow(this.sx);
    this.sy = grow(this.sy);
    this.u = grow(this.u);
    this.t = grow(this.t);
    this.len = grow(this.len);
    this.oct = grow(this.oct);
    this.alpha = grow(this.alpha);
    this.fade = grow(this.fade);
    this.front = grow8(this.front);
    this.seg = grow8(this.seg);
    this.join = grow8(this.join);
    this.cover = grow8(this.cover);
    this.capacity = cap;
  }

  /**
   * Append a line of `count` view-space vertices in one pass, cutting it where it passes behind the eye: a
   * vertex is in front when its depth exceeds CLIP_DEPTH_REL of its distance (and twice the near plane); where
   * consecutive vertices lie on different sides, a vertex is inserted at that depth on the chord between them,
   * in float64. Also fills the drawn-segment flags, the cumulative screen length along drawn segments (the dash
   * phase, from the line's first vertex: the node end of a planned patch), and `out` with the line's vertex
   * range, its visible vertex count and the larger side of its screen bounding box.
   *
   * A `closed` line (a whole ellipse, its last vertex on its first) is written with its second and third
   * vertices once more at the end; the first and the last segment then only serve as join neighbours, so every
   * drawn segment, the ones at the seam included, has a neighbour on both sides (no end caps there).
   */
  appendLine(proj: Projector, count: number, xs: ArrayLike<number>, ys: ArrayLike<number>, zs: ArrayLike<number>, us: ArrayLike<number>, out: LineSpan, closed = false): void {
    const wrap = closed && count >= 4;
    const total = wrap ? count + 2 : count;
    const turn = wrap ? us[count - 1]! - us[0]! : 0;
    this.reserve(2 * total);
    const vx = this.vx;
    const vy = this.vy;
    const vz = this.vz;
    const sx = this.sx;
    const sy = this.sy;
    const uu = this.u;
    const front = this.front;
    const seg = this.seg;
    const len = this.len;
    const near2 = 2 * proj.near;
    const focal = proj.focal;
    const cx = proj.cx;
    const cy = proj.cy;
    const W = proj.width;
    const H = proj.height;
    const start = this.n;
    let j = start;
    let L = 0;
    let visible = 0;
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    let prevFront = false;
    let ringEnd = start;
    for (let i = 0; i < total; i++) {
      // after the ring's last vertex: its 2nd and 3rd vertex again, one turn on in the parameter
      const src = i < count ? i : i - count + 1;
      const x = xs[src]!;
      const y = ys[src]!;
      const z = zs[src]!;
      const u = us[src]! + (i < count ? 0 : turn);
      const depth = -z;
      // |x| + |y| + |z| bounds the distance from above: most vertices pass without a square root
      const f = depth > near2 && (depth > CLIP_DEPTH_REL * (Math.abs(x) + Math.abs(y) + depth) || depth > CLIP_DEPTH_REL * Math.sqrt(x * x + y * y + z * z));
      if (i > 0 && f !== prevFront) {
        // the cut vertex: on the chord, at the clip depth (float64), in front
        const k = j - 1;
        const px = vx[k]!;
        const py = vy[k]!;
        const pz = vz[k]!;
        const rp = Math.sqrt(px * px + py * py + pz * pz);
        const cut = Math.max(near2, CLIP_DEPTH_REL * Math.max(Math.sqrt(x * x + y * y + z * z), rp));
        const s = Math.min(1, Math.max(0, (-pz - cut) / (-pz - depth)));
        const qx = px + (x - px) * s;
        const qy = py + (y - py) * s;
        const qz = pz + (z - pz) * s;
        vx[j] = qx;
        vy[j] = qy;
        vz[j] = qz;
        uu[j] = uu[k]! + (u - uu[k]!) * s;
        const m = focal / -qz;
        sx[j] = cx + qx * m;
        sy[j] = cy - qy * m;
        front[j] = 1;
        j++;
      }
      vx[j] = x;
      vy[j] = y;
      vz[j] = z;
      uu[j] = u;
      front[j] = f ? 1 : 0;
      if (f) {
        const m = focal / -z;
        sx[j] = cx + x * m;
        sy[j] = cy - y * m;
      } else {
        sx[j] = NaN;
        sy[j] = NaN;
      }
      j++;
      prevFront = f;
      if (i === count - 1) ringEnd = j - 1;
    }
    // links, dash length, statistics (one pass over what was written)
    const tt = this.t;
    const alpha = this.alpha;
    const fade = this.fade;
    const join = this.join;
    const cover = this.cover;
    for (let q = start; q < j; q++) {
      tt[q] = NaN;
      alpha[q] = 1;
      fade[q] = 0;
      seg[q] = 0;
      join[q] = 0;
      cover[q] = 0;
      if (front[q] !== 1) {
        len[q] = L;
        continue;
      }
      const px = sx[q]!;
      const py = sy[q]!;
      if (q > start && front[q - 1] === 1) {
        seg[q - 1] = 1;
        const dx = px - sx[q - 1]!;
        const dy = py - sy[q - 1]!;
        L += Math.sqrt(dx * dx + dy * dy);
      }
      len[q] = L;
      if (px >= 0 && py >= 0 && px <= W && py <= H) visible++;
      if (px < x0) x0 = px;
      if (px > x1) x1 = px;
      if (py < y0) y0 = py;
      if (py > y1) y1 = py;
    }
    if (wrap) {
      // the first and the last segment repeat the seam's pieces: join neighbours only
      if (seg[start] === 1) {
        seg[start] = 0;
        join[start] = 1;
      }
      if (seg[j - 2] === 1) {
        seg[j - 2] = 0;
        join[j - 2] = 1;
      }
    }
    this.n = j;
    out.start = start;
    out.count = j - start;
    out.visible = visible;
    out.seam = j - 1 - ringEnd;
    out.span = x1 >= x0 ? Math.max(x1 - x0, y1 - y0) : 0;
  }
}

/** Vertex range and screen statistics of a line appended by VertexArrays.appendLine. */
export interface LineSpan {
  start: number;
  count: number;
  /** Vertices after the ring's last one (seam of a closed line). */
  seam: number;
  visible: number;
  span: number;
}

export interface SceneOptions {
  /**
   * Draw each encounter's patches around their body's position at that encounter's intercept (derived from
   * the preceding patch's Patch.bodyPosAtEnd) instead of the body's current position.
   */
  atIntercept: boolean;
  /** Draw the orbits of all debris (default off: debris are dots, their orbit shows on hover). */
  debrisOrbits: boolean;
  /** A vessel whose orbit is drawn even when it is debris (the hovered one), or null. */
  highlightVesselId: string | null;
}

export interface MapScene {
  snapshot: SimSnapshot;
  camera: CameraState;
  proj: Projector;
  options: SceneOptions;
  verts: VertexArrays;
  lines: LineRecord[];
  markers: MarkerItem[];
  nodes: NodeItem[];
  bodies: BodyItem[];
  vessels: VesselItem[];
  targets: TargetItem[];
  occluders: Occluder[];
  /** At-intercept ghosts (empty when drawing at current positions). */
  ghosts: GhostBody[];
  /** ROOT position of each ghost by ghost id (`<body>@intercept`, `<body>@intercept#2`, ...). */
  ghostAnchors: Map<string, Vec3>;
}

interface BodyInfo {
  id: string;
  name: string;
  radius: number;
  /** Radius of the visible limb (the top of the atmosphere glow), m. */
  vis: number;
  pos: Vec3;
  q: SimSnapshot['bodies'][number]['qFixedToRoot'];
  soi: number | null;
  orbit: ConicElements | null;
  parent: string | null;
  attractor: boolean;
  star: boolean;
  sunDir: Vec3;
  tint: Rgba;
}

const MARKER_STYLE: Record<MarkerKind, { shape: MarkerShape; color: Rgba; priority: number }> = {
  apoapsis: { shape: 'apoapsis', color: COLORS.apsis, priority: 6 },
  periapsis: { shape: 'periapsis', color: COLORS.apsis, priority: 6 },
  ascendingNode: { shape: 'inclination', color: COLORS.inclination, priority: 3 },
  descendingNode: { shape: 'inclination', color: COLORS.inclination, priority: 3 },
  soiEnter: { shape: 'soiEnter', color: COLORS.soiMarker, priority: 5 },
  soiExit: { shape: 'soiExit', color: COLORS.soiMarker, priority: 5 },
  impact: { shape: 'impact', color: COLORS.impact, priority: 8 },
  atmosphereEntry: { shape: 'entry', color: COLORS.entry, priority: 8 },
  closestApproach: { shape: 'closest', color: COLORS.closest, priority: 4 },
  maneuverNode: { shape: 'node', color: COLORS.node, priority: 9 },
};

const NO_TEXT: string[] = [];

export interface LabelSource {
  markerLabel(item: Omit<MarkerItem, 'label' | 'details'>, scene: { snapshot: SimSnapshot; defs: DefLibrary }): { label: string[]; details: string[] };
}

/** Orbit of another vessel, kept while its state is unchanged. */
interface VesselOrbitCache {
  rx: number;
  ry: number;
  rz: number;
  vx: number;
  vy: number;
  vz: number;
  ut: number;
  conic: ConicElements;
  nuNow: number;
}

/** Node location, kept while the node and the predicted patches are the same objects. */
interface NodeCache {
  node: ManeuverNode;
  current: Patch[];
  planned: Patch[];
  loc: NodeLocation | null;
}

export class SceneBuilder {
  private readonly sampler = new Sampler();
  private readonly verts = new VertexArrays();
  private readonly span: LineSpan = { start: 0, count: 0, seam: 0, visible: 0, span: 0 };
  private readonly tmpV: Vec3 = { x: 0, y: 0, z: 0 };
  /** Curve objects, reused by index every build. */
  private readonly curves: ViewConic[] = [];
  private curvesUsed = 0;
  /** Label text per marker object, reused while its inputs are unchanged (camera-only frames). */
  private readonly labelCache = new WeakMap<Marker, Map<string, { ut: number; target: string | null; landingId: string | null; miss: number; text: { label: string[]; details: string[] } }>>();
  private readonly vesselOrbits = new Map<string, VesselOrbitCache>();
  private readonly nodeLocations = new Map<string, NodeCache>();
  /** Breakpoints per line id, and scratch for the list handed to the sampler. */
  private readonly breakpoints = new Map<string, BreakpointCache>();
  private bu = new Float64Array(64);
  private bc = new Float64Array(64);
  private bs = new Float64Array(64);
  private builds = 0;
  /** Per body: visible-limb radius and icon colour (from the definitions; computed once). */
  private readonly bodyStyles = new Map<string, { radius: number; vis: number; tint: Rgba }>();
  /** Occupancy bitmap of the coincidence test (suppressCoincident), reused; the cells marked in the last build. */
  private occ = new Uint8Array(0);
  private marked = new Int32Array(4096);
  private nMarked = 0;
  private readonly clipT = new Float64Array(2);
  private readonly dash = new Float64Array(5);
  /** Arc length from the node at each vertex parameter of a dashed line, by line id (dashAlongPath). */
  private readonly arcCache = new Map<string, { conic: ConicElements | null; u0: number; n: number; u: Float64Array; arc: Float64Array; u2: Float64Array; arc2: Float64Array }>();
  /** Lines of the last build that re-used breakpoints / were sampled afresh (lab statistics and tests). */
  reuse = { resampled: 0, fresh: 0 };

  constructor(
    private readonly defs: DefLibrary,
    private readonly labels: LabelSource,
  ) {}

  build(snapshot: SimSnapshot, camera: CameraState, viewport: Viewport, options: SceneOptions): MapScene {
    const proj = new Projector(camera, viewport);
    const verts = this.verts;
    verts.n = 0;
    this.curvesUsed = 0;
    this.builds++;
    this.reuse.resampled = 0;
    this.reuse.fresh = 0;
    if (this.builds % REUSE_SWEEP_BUILDS === 0) {
      for (const [id, entry] of this.breakpoints) if (entry.used < this.builds - 1) this.breakpoints.delete(id);
    }
    const scene: MapScene = {
      snapshot,
      camera,
      proj,
      options,
      verts,
      lines: [],
      markers: [],
      nodes: [],
      bodies: [],
      vessels: [],
      targets: [],
      occluders: [],
      ghosts: [],
      ghostAnchors: new Map(),
    };
    const bodies = this.bodyInfo(snapshot);
    const anchors = options.atIntercept ? this.encounterAnchors(snapshot, bodies, scene) : null;

    // Occluders: every body at its current position (its visible limb includes the atmosphere glow), plus
    // ghosts at their anchors (outlines of the solid sphere).
    for (const b of bodies.values()) {
      if (!(b.radius > 0)) continue;
      const c = proj.toView(b.pos);
      scene.occluders.push({ x: c.x, y: c.y, z: c.z, radius: b.radius, vis: b.vis });
    }
    for (const g of scene.ghosts) {
      const b = bodies.get(g.bodyId);
      if (!b || !(b.radius > 0)) continue;
      const c = proj.toView(g.pos);
      scene.occluders.push({ x: c.x, y: c.y, z: c.z, radius: b.radius, vis: b.radius });
    }

    const patchOrigin = (p: Patch): Vec3 => anchors?.get(p) ?? bodies.get(p.bodyId)?.pos ?? ORIGIN;

    // ------------------------------------------------------------------------- reference geometry
    for (const b of bodies.values()) {
      if (!b.orbit || !b.parent || !b.attractor) continue;
      const parent = bodies.get(b.parent);
      if (!parent) continue;
      this.addConicLine(scene, `orbit:${b.id}`, 'bodyOrbit', b.orbit, parent.pos, 0, TWO_PI, COLORS.bodyOrbit, FAINT_LINE_WIDTH_PX, false);
    }
    for (const b of bodies.values()) {
      if (!(b.soi && b.soi > 0)) continue;
      this.addSoiLine(scene, b);
    }
    for (const b of bodies.values()) if (b.attractor && b.radius > 0) this.addLimbLine(scene, b);
    for (const g of scene.ghosts) {
      const b = bodies.get(g.bodyId);
      if (!b || !(b.radius > 0)) continue;
      this.addSphereOutline(scene, `ghost:${g.id}`, 'ghostBody', proj.toView(g.pos), b.radius, COLORS.ghost, FAINT_LINE_WIDTH_PX);
    }
    for (const v of snapshot.vessels) {
      if (v.id === snapshot.activeVesselId) continue;
      if (!v.controllable && !options.debrisOrbits && v.id !== options.highlightVesselId) continue;
      this.addVesselOrbit(scene, v, bodies, snapshot.ut);
    }
    for (const t of snapshot.surfaceTargets) {
      if (t.kind !== 'recovery' || !(t.radius > 0)) continue;
      const b = bodies.get(t.bodyId);
      if (b) this.addZoneLine(scene, t, b);
    }

    // ------------------------------------------------------------------------------ trajectories
    let firstNodeUt = Infinity;
    for (const n of snapshot.nodes) if (n.ut < firstNodeUt) firstNodeUt = n.ut;
    const cur0 = snapshot.patches.current[0];
    const span = cur0 ? Math.min(Math.max(cur0.tEnd - cur0.tStart, 600), 30 * 86400) : 86400;
    const tau = 1.5 * span;
    const drawPatches = (list: PatchList, patches: Patch[]): void => {
      let chainIndex = 0;
      for (let i = 0; i < patches.length; i++) {
        const p = patches[i]!;
        if (list === 'planned' && p.afterNodeId === undefined) continue; // upstream of a node: already drawn as current
        const palette = list === 'current' ? COLORS.current : COLORS.planned;
        const color = palette[chainIndex % palette.length]!;
        chainIndex++;
        this.addPatchLine(scene, list, i, p, patchOrigin(p), color, list === 'planned', snapshot.ut, tau, list === 'current' ? firstNodeUt : Infinity);
      }
    };
    drawPatches('current', snapshot.patches.current);
    drawPatches('planned', snapshot.patches.planned);
    this.suppressCoincident(scene, firstNodeUt);

    // ---------------------------------------------------------------------------------- markers
    const target = snapshot.readouts.targetBodyId;
    // Label text reads the time, the target (closest approach) and the landing-target prediction (miss).
    const landing = snapshot.readouts.landingTarget;
    const landingId = landing?.targetId ?? null;
    const miss = landing?.predicted ? landing.predicted.missDistance : -1;
    const labelOf = (item: MarkerItem): void => {
      let per = this.labelCache.get(item.marker);
      if (!per) this.labelCache.set(item.marker, (per = new Map()));
      let hit = per.get(item.kind);
      if (!hit || hit.ut !== snapshot.ut || hit.target !== target || hit.landingId !== landingId || hit.miss !== miss) {
        hit = { ut: snapshot.ut, target, landingId, miss, text: this.labels.markerLabel(item, { snapshot, defs: this.defs }) };
        per.set(item.kind, hit);
      }
      item.label = hit.text.label;
      item.details = hit.text.details;
    };
    for (let li = 0; li < 2; li++) {
      const list: PatchList = li === 0 ? 'current' : 'planned';
      const patches = li === 0 ? snapshot.patches.current : snapshot.patches.planned;
      for (let index = 0; index < patches.length; index++) {
        const p = patches[index]!;
        if (list === 'planned' && p.afterNodeId === undefined) continue;
        const origin = patchOrigin(p);
        const markers = p.markers;
        // Apsides take the colour of their own patch line: the current orbit's and a planned orbit's Ap differ
        // at a glance.
        let lineColor: Rgba | null = null;
        for (const l of scene.lines) if (l.patchKey && l.patchKey.list === list && l.patchKey.index === index) lineColor = l.color;
        for (let mi = 0; mi < markers.length; mi++) {
          const m = markers[mi]!;
          if (m.kind === 'maneuverNode') continue;
          // n-th marker of this kind on the patch (ids stay stable when other kinds come and go)
          let n = 1;
          for (let j = 0; j < mi; j++) if (markers[j]!.kind === m.kind) n++;
          const id = `${list}/${index}/${m.kind}${n > 1 ? `#${n}` : ''}`;
          const frameOrigin = m.bodyId === p.bodyId ? origin : bodies.get(m.bodyId)?.pos ?? origin;
          const style = MARKER_STYLE[m.kind];
          const patchKey: PatchKey = { list, index };
          const apsis = m.kind === 'apoapsis' || m.kind === 'periapsis';
          const item = this.markerItem(scene, id, v3.add(frameOrigin, m.r), m.kind, m, patchKey, style.shape, apsis && lineColor ? lineColor : style.color, style.priority);
          labelOf(item);
          scene.markers.push(item);
          // Impact and entry points also sit on the ground, on the body as it is now (body-fixed lat/lon).
          if ((m.kind === 'impact' || m.kind === 'atmosphereEntry') && m.latitude !== undefined && m.longitude !== undefined) {
            const b = bodies.get(m.bodyId);
            if (b) {
              const dirFixed = latLonToDir(m.latitude, m.longitude);
              const rootS = v3.addScaled(b.pos, quat.rotate(b.q, dirFixed), b.radius);
              const kind = m.kind === 'impact' ? ('impactSurface' as const) : ('entrySurface' as const);
              const sItem = this.markerItem(scene, `${id}/surface`, rootS, kind, m, patchKey, 'surfacePoint', style.color, 2);
              sItem.parent = item;
              labelOf(sItem);
              scene.markers.push(sItem);
            }
          }
        }
        // A patch in another body's frame than the one before it starts with a small entry tick: drawn around
        // its body's current position, its first point lies away from the SOI marker of the previous patch.
        const prev = patches[index - 1];
        if (prev && prev.bodyId !== p.bodyId && p.conic.p > 0) {
          let parent: MarkerItem | undefined;
          for (const m of scene.markers) if (m.patchKey.list === list && m.patchKey.index === index - 1 && (m.kind === 'soiExit' || m.kind === 'soiEnter')) parent = m;
          if (parent) {
            const start = v3.add(origin, conicPosition(p.conic, p.nuStart));
            const tick = this.markerItem(scene, `${list}/${index}/start`, start, 'patchStart', parent.marker, { list, index }, 'soiEnter', parent.color, 2);
            tick.parent = parent;
            tick.details = parent.details;
            scene.markers.push(tick);
          }
        }
      }
    }

    // ------------------------------------------------------------------------------------ nodes
    for (const node of snapshot.nodes) {
      const loc = this.locate(snapshot, node);
      if (!loc) continue;
      const root = v3.add(patchOrigin(loc.patch), loc.rBody);
      const view = proj.toView(root);
      const item: NodeItem = {
        id: node.id,
        x: 0,
        y: 0,
        front: false,
        hidden: 1,
        view,
        loc,
        root,
        axes: {
          prograde: this.axisScreen(scene, view, loc.prograde),
          normal: this.axisScreen(scene, view, loc.normal),
          radial: this.axisScreen(scene, view, loc.radial),
        },
      };
      this.place(scene, item);
      scene.nodes.push(item);
    }

    // ------------------------------------------------------------------------- bodies, vessels
    const pxScale = viewport.pxScale;
    for (const b of bodies.values()) {
      if (!(b.radius > 0)) continue;
      scene.bodies.push(this.bodyItem(scene, b.id, b, b.pos, false, pxScale, b.name));
    }
    for (const g of scene.ghosts) {
      const b = bodies.get(g.bodyId);
      if (!b) continue;
      scene.bodies.push(this.bodyItem(scene, g.id, b, g.pos, true, pxScale, `${b.name} (${g.plannedOnly ? 'planned encounter' : 'encounter'})`));
    }
    for (const v of snapshot.vessels) {
      const view = proj.toView(v.rRoot);
      // Debris are dots: only vessels drawn as arrowheads need their heading on screen.
      const speed = v.controllable ? v3.len(v.v) : 0;
      const heading = speed > 0 ? this.axisScreen(scene, view, v3.scale(v.v, 1 / speed)) : NO_HEADING;
      const item: VesselItem = { id: v.id, x: 0, y: 0, front: false, hidden: 1, view, vesselId: v.id, bodyId: v.bodyId, name: v.name, active: v.id === snapshot.activeVesselId, debris: !v.controllable, dirX: heading.extent > 0 ? heading.dx : 0, dirY: heading.extent > 0 ? heading.dy : 0 };
      this.place(scene, item);
      scene.vessels.push(item);
    }

    // --------------------------------------------------------------------------- surface targets
    for (const t of snapshot.surfaceTargets) {
      const b = bodies.get(t.bodyId);
      if (!b) continue;
      const rootT = v3.addScaled(b.pos, quat.rotate(b.q, latLonToDir(t.latitude, t.longitude)), b.radius);
      const shape: MarkerShape = t.kind === 'landing' ? 'pin' : t.kind === 'site' ? 'pad' : 'zone';
      const color = t.kind === 'landing' ? COLORS.landing : t.kind === 'site' ? COLORS.site : COLORS.recovery;
      const item: TargetItem = { id: t.id, x: 0, y: 0, front: false, hidden: 1, view: proj.toView(rootT), target: t, shape, color };
      this.place(scene, item);
      scene.targets.push(item);
    }
    return scene;
  }

  // -------------------------------------------------------------------------------------- helpers

  /**
   * At-intercept anchors, one per ENCOUNTER: a run of consecutive patches about the same body in one list.
   * The patch before the run ends in ROOT at prev.bodyPosAtEnd + r(prev.nuEnd) (Patch contract), so the
   * body sat at that point minus the run's first conic start: the drawn chain is continuous at that
   * intercept. A planned list that starts inside an encounter of the current list (its first node lies
   * there) continues that encounter and shares its anchor. Not anchored: the root body, and the run the
   * vessel is in now (current[0], drawn where its body is now). Fills scene.ghosts / ghostAnchors.
   */
  private encounterAnchors(s: SimSnapshot, bodies: Map<string, BodyInfo>, scene: MapScene): Map<Patch, Vec3> {
    const anchors = new Map<Patch, Vec3>();
    /** Distinct anchors in order of appearance, with their body and whether the current list meets them. */
    const distinct = new Map<Vec3, { bodyId: string; current: boolean }>();
    const root = this.defs.rootBodyId;
    const current = s.patches.current;
    const lists: [Patch[], boolean][] = [
      [current, true],
      [s.patches.planned, false],
    ];
    for (const [list, isCurrent] of lists) {
      let anchor: Vec3 | null = null;
      for (let i = 0; i < list.length; i++) {
        const p = list[i]!;
        const prev = list[i - 1];
        if (prev && prev.bodyId === p.bodyId) {
          if (anchor) anchors.set(p, anchor);
          continue;
        }
        // first patch of a run
        anchor = null;
        if (p.bodyId === root || !bodies.has(p.bodyId)) continue;
        if (prev) {
          anchor = v3.sub(v3.add(prev.bodyPosAtEnd, conicPosition(prev.conic, prev.nuEnd)), conicPosition(p.conic, p.nuStart));
        } else if (isCurrent) {
          continue; // the encounter the vessel is in now
        } else {
          const host = current.find((c) => c.bodyId === p.bodyId && p.tStart >= c.tStart - UT_EPS && p.tStart <= c.tEnd + UT_EPS);
          anchor = host ? anchors.get(host) ?? null : v3.clone(p.bodyPosAtEnd);
        }
        if (!anchor) continue;
        anchors.set(p, anchor);
        if (!distinct.has(anchor)) distinct.set(anchor, { bodyId: p.bodyId, current: isCurrent });
      }
    }
    const perBody = new Map<string, number>();
    for (const [pos, { bodyId, current: metByCurrent }] of distinct) {
      const n = (perBody.get(bodyId) ?? 0) + 1;
      perBody.set(bodyId, n);
      const id = `${bodyId}@intercept${n > 1 ? `#${n}` : ''}`;
      scene.ghosts.push({ id, bodyId, pos, plannedOnly: !metByCurrent });
      scene.ghostAnchors.set(id, pos);
    }
    return anchors;
  }

  private bodyInfo(s: SimSnapshot): Map<string, BodyInfo> {
    const out = new Map<string, BodyInfo>();
    for (const b of s.bodies) {
      const def = this.defs.bodies[b.id];
      const radius = def?.radius ?? 0;
      let style = this.bodyStyles.get(b.id);
      if (!style || style.radius !== radius) {
        style = { radius, vis: radius + visibleAtmosphereHeight(radius, def?.render.atmosphere, VISIBLE_LIMB_OPTICAL_DEPTH), tint: bodyTint(def?.render.meanColor) };
        this.bodyStyles.set(b.id, style);
      }
      out.set(b.id, {
        id: b.id,
        name: def?.name ?? b.id,
        radius,
        vis: style.vis,
        pos: b.rRoot,
        q: b.qFixedToRoot,
        soi: b.soiRadius,
        orbit: b.orbit,
        parent: def?.parent ?? null,
        attractor: def?.gravityRole === 'attractor',
        star: def?.emission != null,
        sunDir: b.sunDir,
        tint: style.tint,
      });
    }
    return out;
  }

  /** Node location from the snapshot, recomputed only when the node or the predicted patches change. */
  private locate(s: SimSnapshot, node: ManeuverNode): NodeLocation | null {
    const c = this.nodeLocations.get(node.id);
    if (c && c.node === node && c.current === s.patches.current && c.planned === s.patches.planned) return c.loc;
    const loc = locateNode(s, node);
    this.nodeLocations.set(node.id, { node, current: s.patches.current, planned: s.patches.planned, loc });
    if (this.nodeLocations.size > 4 * s.nodes.length + 16) {
      for (const id of this.nodeLocations.keys()) if (!s.nodes.some((n) => n.id === id)) this.nodeLocations.delete(id);
    }
    return loc;
  }

  /** Project an item's view-space position and evaluate its occlusion. */
  private place(scene: MapScene, item: PointItem): void {
    const proj = scene.proj;
    const v = item.view;
    const depth = -v.z;
    if (depth > proj.near) {
      const k = proj.focal / depth;
      item.x = proj.cx + v.x * k;
      item.y = proj.cy - v.y * k;
      item.front = true;
      item.hidden = occlusionWeight(v, scene.occluders, proj.focal, OCCLUSION_FADE_PX * proj.pxScale);
    } else {
      item.x = NaN;
      item.y = NaN;
      item.front = false;
      item.hidden = 1;
    }
  }

  private markerItem(scene: MapScene, id: string, root: Vec3, kind: MarkerItem['kind'], marker: Marker, patchKey: PatchKey, shape: MarkerShape, color: Rgba, priority: number): MarkerItem {
    const item: MarkerItem = { id, x: 0, y: 0, front: false, hidden: 1, view: scene.proj.toView(root), kind, marker, patchKey, shape, color, label: NO_TEXT, details: NO_TEXT, priority };
    this.place(scene, item);
    return item;
  }

  private axisScreen(scene: MapScene, p: Vec3, axisRoot: Vec3): AxisScreen {
    const a = scene.proj.rotate(axisRoot, this.tmpV);
    const dist = Math.hypot(p.x, p.y, p.z);
    // Component of the axis perpendicular to the view ray, and its screen direction (derivative of the projection).
    const along = (a.x * p.x + a.y * p.y + a.z * p.z) / dist;
    const extent = Math.sqrt(Math.max(0, 1 - along * along));
    const depth = -p.z;
    // d(screen)/d(t) for p + t a: x' = (a.x depth + p.x a.z) / depth^2 ... (y flipped)
    const dxs = (a.x * depth + p.x * a.z) / (depth * depth);
    const dys = -(a.y * depth + p.y * a.z) / (depth * depth);
    const l = Math.hypot(dxs, dys);
    return l > 0 ? { dx: dxs / l, dy: dys / l, extent } : { dx: 1, dy: 0, extent: 0 };
  }

  private bodyItem(scene: MapScene, id: string, b: BodyInfo, pos: Vec3, ghost: boolean, pxScale: number, label: string): BodyItem {
    const proj = scene.proj;
    const radius = b.radius;
    const view = proj.toView(pos);
    const L = Math.hypot(view.x, view.y, view.z);
    const ang = L > radius ? Math.asin(radius / L) : Math.PI / 2;
    const radiusPx = Math.tan(Math.min(ang, 1.5)) * proj.focal;
    const sun = b.star ? null : proj.rotate(b.sunDir);
    const item: BodyItem = {
      id,
      x: NaN,
      y: NaN,
      front: false,
      hidden: 1,
      view,
      bodyId: b.id,
      name: b.name,
      radiusPx,
      small: 2 * radiusPx < SMALL_OBJECT_PX * pxScale,
      ghost,
      label,
      sunX: sun ? sun.x : 0,
      sunY: sun ? sun.y : 0,
      sunZ: sun ? sun.z : 0,
      tint: b.tint,
      star: b.star,
    };
    const depth = -view.z;
    if (depth > proj.near) {
      const k = proj.focal / depth;
      item.x = proj.cx + view.x * k;
      item.y = proj.cy - view.y * k;
      item.front = true;
      // A body is hidden by another body in front of it (never by itself).
      let w = 0;
      for (const o of scene.occluders) {
        if (Math.abs(o.x - view.x) + Math.abs(o.y - view.y) + Math.abs(o.z - view.z) <= 1e-3 * radius) continue;
        w = Math.max(w, occlusionWeight(view, ONE_OCCLUDER(o), proj.focal, OCCLUSION_FADE_PX * pxScale));
      }
      item.hidden = w;
    }
    return item;
  }

  private nextCurve(): ViewConic {
    let c = this.curves[this.curvesUsed];
    if (!c) this.curves.push((c = new ViewConic()));
    this.curvesUsed++;
    return c;
  }

  /** Sample a conic arc between true anomalies (unwrapped) around a ROOT focus and append a line. */
  private addConicLine(
    scene: MapScene,
    id: string,
    kind: LineKind,
    conic: ConicElements,
    focusRoot: Vec3,
    nu0: number,
    nu1: number,
    color: Rgba,
    widthPx: number,
    dashed: boolean,
  ): PatchCurveLine | null {
    const curve = this.nextCurve().setFromElements(conic, focusRoot, scene.proj);
    return this.addCurve(scene, id, kind, curve, curve.nuToU(nu0), curve.nuToU(nu1), color, widthPx, dashed);
  }

  private addCurve(scene: MapScene, id: string, kind: LineKind, curve: ViewConic, u0: number, u1: number, color: Rgba, widthPx: number, dashed: boolean): PatchCurveLine | null {
    const proj = scene.proj;
    const tolerance = kind === 'debrisOrbit' ? DEBRIS_CHORD_TOLERANCE_PX : kind === 'vesselOrbit' ? FAINT_CHORD_TOLERANCE_PX : CHORD_TOLERANCE_PX;
    const s = this.sampleLine(id, curve, u0, u1, proj, tolerance);
    if (s.count < 2) return null;
    const out = this.span;
    // (bulk debris rings at 20 % alpha are left open: a cap there does not show)
    const closed = kind !== 'debrisOrbit' && curve.kind === 'E' && Math.abs(u1 - u0 - TWO_PI) <= REUSE_PARAM_EPS;
    this.verts.appendLine(proj, s.count, s.vx, s.vy, s.vz, s.u, out, closed);
    const rec: PatchCurveLine = { kind, id, start: out.start, count: out.count, seam: out.seam, color, width: widthPx * proj.pxScale, dashed, curve, visibleVertices: out.visible, span: out.span, capped: s.capped, evaluations: s.evaluations, occlusionSlack: 0, casing: true };
    scene.lines.push(rec);
    return rec;
  }

  /**
   * Sample line `id` over [u0, u1]: from the breakpoints kept for it when they still apply and every piece
   * verifies (BreakpointCache), else afresh. The result is within the line's tolerance either way.
   */
  private sampleLine(id: string, curve: ViewConic, u0: number, u1: number, proj: Projector, tolerance: number): SampledCurve {
    const sampler = this.sampler;
    const faint = tolerance > CHORD_TOLERANCE_PX;
    let entry = this.breakpoints.get(id);
    if (entry && !entry.stale && entry.tolerance === tolerance && entry.kind === curve.kind && sameShape(entry.e, curve)) {
      const n = this.fitBreakpoints(entry, curve, u0, u1);
      const r = n >= 2 ? sampler.resample(curve, this.bu, this.bc, this.bs, n, proj, tolerance) : null;
      if (r) {
        entry.used = this.builds;
        // Refined for a closer view than this one: good for this frame, sampled afresh in the next.
        if (n > entry.initial + 1 && r.maxError < REUSE_OVER_REFINED * entry.maxError) entry.stale = true;
        this.reuse.resampled++;
        return r;
      }
    }
    const s = faint ? sampler.sample(curve, u0, u1, proj, tolerance * REUSE_HEADROOM, MAX_POINTS_PER_CURVE, FAINT_MAX_TURN) : sampler.sample(curve, u0, u1, proj, tolerance * REUSE_HEADROOM);
    this.reuse.fresh++;
    if (s.count < 2 || s.capped) {
      if (entry) this.breakpoints.delete(id);
      return s;
    }
    const n = s.count;
    if (!entry || entry.u.length < n) {
      const size = Math.max(32, 2 * n);
      entry = { kind: curve.kind, e: curve.e, tolerance, closed: false, n: 0, u: new Float64Array(size), c: new Float64Array(size), s: new Float64Array(size), initial: 0, maxError: 0, stale: false, used: 0 };
      this.breakpoints.set(id, entry);
    }
    entry.kind = curve.kind;
    entry.e = curve.e;
    entry.tolerance = tolerance;
    entry.closed = curve.kind === 'E' && Math.abs(u1 - u0 - TWO_PI) <= REUSE_PARAM_EPS;
    entry.n = n;
    entry.u.set(s.u.subarray(0, n));
    entry.c.set(s.c.subarray(0, n));
    entry.s.set(s.s.subarray(0, n));
    entry.initial = s.initial;
    entry.maxError = s.maxError;
    entry.stale = false;
    entry.used = this.builds;
    return s;
  }

  /**
   * Breakpoints of `entry` for the range [u0, u1], into bu / bc / bs: the two ends plus every kept
   * breakpoint strictly between them. A whole revolution of an ellipse may start anywhere (the kept points
   * are taken modulo one turn); any other range must lie inside the kept one. Returns the count, 0 when the
   * kept breakpoints do not cover the range.
   */
  private fitBreakpoints(entry: BreakpointCache, curve: ViewConic, u0: number, u1: number): number {
    const n = entry.n;
    const cu = entry.u;
    const cc = entry.c;
    const cs = entry.s;
    if (this.bu.length < n + 2) {
      const size = 2 * (n + 2);
      this.bu = new Float64Array(size);
      this.bc = new Float64Array(size);
      this.bs = new Float64Array(size);
    }
    const bu = this.bu;
    const bc = this.bc;
    const bs = this.bs;
    const hyperbola = curve.kind === 'H';
    bu[0] = u0;
    bc[0] = hyperbola ? Math.cosh(u0) : Math.cos(u0);
    bs[0] = hyperbola ? Math.sinh(u0) : Math.sin(u0);
    let m = 1;
    if (entry.closed) {
      if (Math.abs(u1 - u0 - TWO_PI) > REUSE_PARAM_EPS) return 0;
      // Offsets of the kept points from the first one: ascending in [0, 2 pi) for j = 0 .. n - 2.
      const first = cu[0]!;
      const turn = u0 - first;
      const d = turn - TWO_PI * Math.floor(turn / TWO_PI);
      const base = u0 - d;
      let j0 = 0;
      while (j0 < n - 1 && cu[j0]! - first <= d + REUSE_PARAM_EPS) j0++;
      for (let j = j0; j < n - 1; j++) {
        bu[m] = base + (cu[j]! - first);
        bc[m] = cc[j]!;
        bs[m] = cs[j]!;
        m++;
      }
      const next = base + TWO_PI;
      for (let j = 0; j < j0; j++) {
        const o = cu[j]! - first;
        if (o >= d - REUSE_PARAM_EPS) break;
        bu[m] = next + o;
        bc[m] = cc[j]!;
        bs[m] = cs[j]!;
        m++;
      }
      bu[m] = u1;
      bc[m] = bc[0]!;
      bs[m] = bs[0]!;
      return m + 1;
    }
    if (cu[0]! > u0 + REUSE_PARAM_EPS || cu[n - 1]! < u1 - REUSE_PARAM_EPS) return 0;
    for (let j = 0; j < n; j++) {
      const u = cu[j]!;
      if (u <= u0 + REUSE_PARAM_EPS) continue;
      if (u >= u1 - REUSE_PARAM_EPS) break;
      bu[m] = u;
      bc[m] = cc[j]!;
      bs[m] = cs[j]!;
      m++;
    }
    bu[m] = u1;
    bc[m] = hyperbola ? Math.cosh(u1) : Math.cos(u1);
    bs[m] = hyperbola ? Math.sinh(u1) : Math.sin(u1);
    return m + 1;
  }

  private addPatchLine(scene: MapScene, list: PatchList, index: number, p: Patch, origin: Vec3, color: Rgba, dashed: boolean, now: number, tau: number, dimAfterUt: number): void {
    const c = p.conic;
    if (!(c.p > 0)) {
      this.addRadialPatchLine(scene, list, index, p, origin, color, dashed);
      return;
    }
    let nu0 = p.nuStart;
    let nu1 = p.nuEnd;
    if (isFullRevolution(p)) nu1 = nu0 + TWO_PI;
    if (c.period === null) {
      const lim = conicMaxTrueAnomaly(c) - 1e-7;
      nu0 = Math.max(-lim, Math.min(lim, nu0));
      nu1 = Math.max(-lim, Math.min(lim, nu1));
    }
    if (!(nu1 > nu0)) return;
    const rec = this.addConicLine(scene, `${list}/${index}`, list, c, origin, nu0, nu1, color, LINE_WIDTH_PX, dashed);
    if (!rec) return;
    rec.patchKey = { list, index };
    rec.patch = p;
    if (dashed) this.dashAlongPath(scene, rec);
    // Time at every vertex (first lap for multi-revolution patches) and the fade with time ahead. With the
    // eccentric/hyperbolic anomaly as the parameter this is Kepler's equation itself: dt = dM / n.
    const verts = this.verts;
    const curve = rec.curve;
    const aAbs = Math.abs(c.a);
    const meanMotion = Number.isFinite(aAbs) ? Math.sqrt(c.mu / (aAbs * aAbs * aAbs)) : NaN;
    const m0 = curve.meanAnomaly(verts.u[rec.start]!);
    const kepler = Number.isFinite(m0) && Number.isFinite(meanMotion);
    const tspStart = kepler ? 0 : timeSincePeriapsis(c, wrapPi(p.nuStart));
    for (let i = 0; i < rec.count; i++) {
      const j = rec.start + i;
      const t = kepler ? p.tStart + (curve.meanAnomaly(verts.u[j]!) - m0) / meanMotion : p.tStart + (timeSincePeriapsis(c, curve.uToNu(verts.u[j]!)) - tspStart);
      verts.t[j] = t;
      const ahead = t > now ? t - now : 0;
      verts.fade[j] = 1 - Math.exp(-ahead / tau);
      verts.alpha[j] = t > dimAfterUt ? AFTER_NODE_DIM : 1;
    }
  }

  /**
   * A radial trajectory (h = 0) comes as a degenerate conic with p = 0 and P = minus the radial direction
   * (sim-orbits convention): it is drawn as the straight segment along -P between the lowest and highest
   * radius known on it (the vessel for the first current patch, and the patch's markers). Anomaly-based
   * editing does not apply, so the line is not interactive.
   */
  private addRadialPatchLine(scene: MapScene, list: PatchList, index: number, p: Patch, origin: Vec3, color: Rgba, dashed: boolean): void {
    const dir = v3.neg(p.conic.P);
    const radii: number[] = [];
    for (const m of p.markers) if (m.bodyId === p.bodyId) radii.push(v3.len(m.r));
    const active = scene.snapshot.vessels.find((v) => v.id === scene.snapshot.activeVesselId);
    if (list === 'current' && index === 0 && active && active.bodyId === p.bodyId) radii.push(v3.len(active.r));
    const finite = radii.filter((r) => Number.isFinite(r));
    if (finite.length < 2) return;
    const r0 = Math.min(...finite);
    const r1 = Math.max(...finite);
    if (!(r1 - r0 > 1)) return;
    const proj = scene.proj;
    const a = proj.toView(v3.addScaled(origin, dir, r0));
    const b = proj.toView(v3.addScaled(origin, dir, r1));
    const out = this.span;
    this.verts.appendLine(proj, 2, [a.x, b.x], [a.y, b.y], [a.z, b.z], [r0, r1], out);
    const rec: LineRecord = { kind: list, id: `${list}/${index}`, start: out.start, count: out.count, seam: out.seam, color, width: LINE_WIDTH_PX * proj.pxScale, dashed, curve: null, visibleVertices: out.visible, span: out.span, capped: false, evaluations: 0, occlusionSlack: 0, casing: true };
    scene.lines.push(rec);
    if (dashed) this.dashAlongPath(scene, rec);
  }

  /**
   * Lay the dash pattern of a planned patch out along the path itself. Every vertex carries its arc length from
   * the patch start (the node) in metres, integrated exactly from the conic (Simpson over the sampling
   * parameter, so it does not depend on where the sampler put the vertices), and every segment the octave of
   * its world dash period: floor(log2(DASH_PERIOD_PX x metres per pixel at the segment's depth)). The GPU draws
   * the patterns of that octave and the next one, each fixed to the path, and cross-fades between them by the
   * depth of the fragment (as a texture blends its mip levels): the dashes never slide along the path when the
   * camera turns, zooms or follows the vessel, and stay close to DASH_PERIOD_PX on screen on a near stretch and
   * a far one alike.
   */
  private dashAlongPath(scene: MapScene, rec: LineRecord): void {
    const proj = scene.proj;
    const v = this.verts;
    const k = (DASH_PERIOD_PX * proj.pxScale) / proj.focal;
    const curve = rec.curve;
    let arc = 0;
    const end = rec.start + rec.count;
    // Arc lengths of the last build at the same parameters (kept breakpoints give the same vertices frame after
    // frame): taken over while the patch's conic and start are unchanged, integrated afresh otherwise.
    const conic = rec.patch?.conic ?? null;
    let cache = this.arcCache.get(rec.id);
    const valid = curve !== null && conic !== null && cache !== undefined && cache.conic === conic && cache.u0 === v.u[rec.start];
    if (!cache) {
      if (this.arcCache.size > 64) this.arcCache.clear();
      this.arcCache.set(rec.id, (cache = { conic, u0: 0, n: 0, u: new Float64Array(64), arc: new Float64Array(64), u2: new Float64Array(64), arc2: new Float64Array(64) }));
    }
    if (cache.u2.length < rec.count) {
      cache.u2 = new Float64Array(2 * rec.count);
      cache.arc2 = new Float64Array(2 * rec.count);
    }
    const nu = cache.u2;
    const narc = cache.arc2;
    let p = 0;
    // the speed |dr/du| at the previous vertex (NaN: not evaluated yet)
    let f0 = NaN;
    for (let j = rec.start; j < end; j++) {
      const u = v.u[j]!;
      if (j > rec.start) {
        let hit = false;
        if (valid) {
          while (p < cache.n && cache.u[p]! < u - 1e-12) p++;
          if (p < cache.n && Math.abs(cache.u[p]! - u) <= 1e-12) {
            arc = cache.arc[p]!;
            hit = true;
            f0 = NaN;
          }
        }
        if (!hit) {
          if (curve) {
            const u0 = v.u[j - 1]!;
            if (Number.isNaN(f0)) f0 = conicSpeed(curve, u0, this.dash);
            arc += arcLength(curve, u0, u, f0, this.dash);
            f0 = this.dash[4]!;
          } else arc += Math.hypot(v.vx[j]! - v.vx[j - 1]!, v.vy[j]! - v.vy[j - 1]!, v.vz[j]! - v.vz[j - 1]!);
        }
      }
      v.len[j] = arc;
      v.oct[j] = Math.floor(Math.log2(Math.max(1e-3, k * -v.vz[j]!)));
      nu[j - rec.start] = u;
      narc[j - rec.start] = arc;
    }
    // this build's table becomes the cache (the two buffers swap)
    cache.u2 = cache.u;
    cache.arc2 = cache.arc;
    cache.u = nu;
    cache.arc = narc;
    cache.n = rec.count;
    cache.conic = conic;
    cache.u0 = v.u[rec.start]!;
  }

  /**
   * Patches lying on one another are drawn once: a fine occupancy bitmap (COINCIDENT_PX / 2 cells over the
   * screen box of the trajectories) holds what has been drawn, in priority order: the current trajectory up to
   * the first node (the path the vessel is on), then the planned patches in time order, then the current
   * trajectory after the first node (the path it leaves). A segment of a later line that runs within about
   * COINCIDENT_PX of drawn cells for most of its on-screen length is not drawn, so coincident laps read as one
   * stroke and a node with little delta-v shows one orbit, not interleaved dashes. The segment is only hidden
   * (VertexArrays.cover): it can still be clicked and a node still slides along it. Segments are clipped to the
   * box before they are walked (a chord far off screen costs nothing), and only the marked cells are cleared
   * for the next build.
   */
  private suppressCoincident(scene: MapScene, firstNodeUt: number): void {
    const lines = scene.lines;
    const occ0 = this.occ;
    // clear what the previous build marked
    for (let q = 0; q < this.nMarked; q++) occ0[this.marked[q]!] = 0;
    this.nMarked = 0;
    let planned = 0;
    for (const l of lines) if (l.kind === 'planned') planned++;
    if (planned === 0) return;
    const v = this.verts;
    const W = scene.proj.width;
    const H = scene.proj.height;
    const cs = (COINCIDENT_PX / 2) * scene.proj.pxScale;
    const inv = 1 / cs;
    // screen box of the trajectories' drawn vertices, clipped to the screen
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const l of lines) {
      if (l.kind !== 'current' && l.kind !== 'planned') continue;
      for (let i = l.start; i < l.start + l.count; i++) {
        if (v.front[i] !== 1) continue;
        const x = v.sx[i]!;
        const y = v.sy[i]!;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
    x0 = Math.max(0, x0) - 2 * cs;
    y0 = Math.max(0, y0) - 2 * cs;
    x1 = Math.min(W, x1) + 2 * cs;
    y1 = Math.min(H, y1) + 2 * cs;
    if (!(x1 > x0 && y1 > y0)) return;
    const cols = Math.ceil((x1 - x0) * inv);
    const rows = Math.ceil((y1 - y0) * inv);
    const n = cols * rows;
    if (n > 4e6) return;
    if (this.occ.length < n) this.occ = new Uint8Array(Math.ceil(n * 1.25));
    const occ = this.occ;
    const clip = this.clipT;
    // the part of segment i inside the box [x0, x1] x [y0, y1] (Liang-Barsky), as parameters clip[0..1]
    const clipSeg = (ax: number, ay: number, dx: number, dy: number): boolean => clipToBox(ax, ay, dx, dy, x0, y0, x1, y1, clip);
    const mark = (i: number): void => {
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const dx = v.sx[i + 1]! - ax;
      const dy = v.sy[i + 1]! - ay;
      if (!clipSeg(ax, ay, dx, dy)) return;
      const t0 = clip[0]!;
      const t1 = clip[1]!;
      // one step per 2 cells: a skipped cell is still within the 3 x 3 neighbourhood the test looks at
      const steps = Math.max(1, Math.ceil((Math.sqrt(dx * dx + dy * dy) * (t1 - t0)) / (2 * cs)));
      let gx = (ax + dx * t0 - x0) * inv;
      let gy = (ay + dy * t0 - y0) * inv;
      const sx = (dx * (t1 - t0) * inv) / steps;
      const sy = (dy * (t1 - t0) * inv) / steps;
      for (let s = 0; s <= steps; s++, gx += sx, gy += sy) {
        const ci = gx | 0;
        const cj = gy | 0;
        if (ci < 0 || cj < 0 || ci >= cols || cj >= rows) continue;
        const c = cj * cols + ci;
        if (occ[c] === 0) {
          occ[c] = 1;
          if (this.nMarked >= this.marked.length) {
            const grown = new Int32Array(this.marked.length * 2);
            grown.set(this.marked);
            this.marked = grown;
          }
          this.marked[this.nMarked++] = c;
        }
      }
    };
    // any drawn cell in the 3 x 3 neighbourhood (unrolled; at the box edge a read wraps into the next row or
    // falls outside the array, which only concerns points in the off-screen padding)
    const near = (gx: number, gy: number): boolean => {
      const c = (gy | 0) * cols + (gx | 0);
      const u = c - cols;
      const d = c + cols;
      return occ[u - 1] === 1 || occ[u] === 1 || occ[u + 1] === 1 || occ[c - 1] === 1 || occ[c] === 1 || occ[c + 1] === 1 || occ[d - 1] === 1 || occ[d] === 1 || occ[d + 1] === 1;
    };
    // three quarters of the segment's on-screen part within a cell of drawn cells (a sample per 3 cells, the
    // middle first: most segments are decided by one or two lookups)
    const covered = (i: number): boolean => {
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const dx = v.sx[i + 1]! - ax;
      const dy = v.sy[i + 1]! - ay;
      if (!clipSeg(ax, ay, dx, dy)) return false;
      const t0 = clip[0]!;
      const t1 = clip[1]!;
      const gx0 = (ax + dx * t0 - x0) * inv;
      const gy0 = (ay + dy * t0 - y0) * inv;
      const gdx = dx * (t1 - t0) * inv;
      const gdy = dy * (t1 - t0) * inv;
      if (!near(gx0 + gdx * 0.5, gy0 + gdy * 0.5)) return false;
      const cells = Math.sqrt(gdx * gdx + gdy * gdy);
      // a short segment (most of them): its two ends decide
      if (cells <= 6) return near(gx0, gy0) && near(gx0 + gdx, gy0 + gdy);
      const steps = Math.min(256, Math.max(2, Math.ceil(cells / 3)));
      const allowed = 0.25 * (steps + 1);
      let miss = 0;
      for (let s = 0; s <= steps; s++) {
        if (!near(gx0 + (gdx * s) / steps, gy0 + (gdy * s) / steps) && ++miss > allowed) return false;
      }
      return true;
    };
    // 1. the current trajectory up to the first node: drawn as it is, and the reference for everything else
    for (const l of lines) {
      if (l.kind !== 'current') continue;
      for (let i = l.start; i < l.start + l.count - 1; i++) if (v.seg[i] === 1 && !(v.t[i + 1]! > firstNodeUt)) mark(i);
    }
    // 2. planned patches in time order, 3. the current trajectory after the first node
    for (let pass = 0; pass < 2; pass++) {
      for (const l of lines) {
        if (l.kind !== (pass === 0 ? 'planned' : 'current')) continue;
        const end = l.start + l.count - 1;
        let any = false;
        for (let i = l.start; i < end; i++) {
          if (v.seg[i] !== 1) continue;
          if (pass === 1 && !(v.t[i + 1]! > firstNodeUt)) continue;
          if (covered(i)) {
            v.cover[i] = 1;
            any = true;
          }
        }
        if (any) this.cleanCover(l, (DASH_PERIOD_PX * scene.proj.pxScale) | 0);
        if (pass === 0) for (let i = l.start; i < end; i++) if (v.seg[i] === 1 && v.cover[i] === 0) mark(i);
      }
    }
  }

  /** Orbit of another vessel from its state (cached while the state and time are unchanged). */
  private vesselOrbit(v: VesselSnapshot, mu: number, ut: number): VesselOrbitCache {
    const c = this.vesselOrbits.get(v.id);
    if (c && c.ut === ut && c.rx === v.r.x && c.ry === v.r.y && c.rz === v.r.z && c.vx === v.v.x && c.vy === v.v.y && c.vz === v.v.z && c.conic.mu === mu) return c;
    const conic = conicFromState(mu, v.r, v.v, ut);
    const entry: VesselOrbitCache = { rx: v.r.x, ry: v.r.y, rz: v.r.z, vx: v.v.x, vy: v.v.y, vz: v.v.z, ut, conic, nuNow: conicTrueAnomaly(conic, v.r) };
    this.vesselOrbits.set(v.id, entry);
    return entry;
  }

  private addVesselOrbit(scene: MapScene, v: VesselSnapshot, bodies: Map<string, BodyInfo>, ut: number): void {
    if (v.translationMode === 'landed' || v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') return;
    const b = bodies.get(v.bodyId);
    const mu = this.defs.bodies[v.bodyId]?.mu;
    if (!b || !mu) return;
    const hx = v.r.y * v.v.z - v.r.z * v.v.y;
    const hy = v.r.z * v.v.x - v.r.x * v.v.z;
    const hz = v.r.x * v.v.y - v.r.y * v.v.x;
    if (!(hx * hx + hy * hy + hz * hz > 0)) return;
    const { conic: c, nuNow } = this.vesselOrbit(v, mu, ut);
    let nu0 = nuNow;
    let nu1: number;
    const rp = c.p / (1 + c.e);
    if (rp < b.radius && v3.len(v.r) > b.radius) {
      // Suborbital: from now down to the surface (inbound crossing of the datum sphere).
      const cross = conicRadiusCrossing(c, b.radius);
      if (cross === null) return;
      const inbound = -cross;
      let d = inbound - nuNow;
      d -= TWO_PI * Math.floor(d / TWO_PI);
      nu1 = nuNow + d;
    } else if (c.period !== null) {
      nu0 = nuNow;
      nu1 = nuNow + TWO_PI;
    } else {
      const limit = b.soi ?? 2e9;
      const cross = conicRadiusCrossing(c, limit);
      const lim = conicMaxTrueAnomaly(c) - 1e-7;
      nu1 = cross === null ? lim : Math.min(cross, lim);
      if (!(nu1 > nu0)) return;
    }
    // Debris drawn in bulk (setDebrisOrbits) are faint and coarser; the hovered vessel's or debris' orbit is
    // drawn in the hover colour, one step wider, so it reads as the one the tooltip describes.
    const hovered = v.id === scene.options.highlightVesselId;
    const bulk = !v.controllable && !hovered;
    const rec = this.addConicLine(scene, `vessel:${v.id}`, bulk ? 'debrisOrbit' : 'vesselOrbit', c, b.pos, nu0, nu1, hovered ? COLORS.hoverOrbit : bulk ? COLORS.debrisOrbit : COLORS.vesselOrbit, hovered ? HOVER_ORBIT_WIDTH_PX : FAINT_LINE_WIDTH_PX, false);
    // Another vessel's or a debris' orbit a few pixels across says nothing at this zoom and buries the body it
    // circles (twenty debris orbits around an 11 px planet icon read as a scribble); the hovered one stays.
    if (rec && !hovered && rec.span < ORBIT_MIN_SPAN_PX * scene.proj.pxScale) {
      scene.lines.pop();
      this.verts.n = rec.start;
    }
  }

  /**
   * Hidden stretches of a line (suppressCoincident) without flicker along it: where two lines drift apart
   * slowly the test flips from segment to segment. A visible run shorter than two dash periods between hidden
   * ones is hidden too, a hidden run shorter than one period between visible ones is shown (screen length).
   */
  private cleanCover(l: LineRecord, periodPx: number): void {
    const v = this.verts;
    const end = l.start + l.count - 1;
    for (let pass = 0; pass < 2; pass++) {
      const target = pass === 0 ? 0 : 1; // pass 0: short visible runs; pass 1: short hidden runs
      const limit = pass === 0 ? 2 * periodPx : periodPx;
      let i = l.start;
      while (i < end) {
        if (v.seg[i] !== 1 || v.cover[i] !== target) {
          i++;
          continue;
        }
        const runStart = i;
        let len = 0;
        while (i < end && v.seg[i] === 1 && v.cover[i] === target) {
          const ex = v.sx[i + 1]! - v.sx[i]!;
          const ey = v.sy[i + 1]! - v.sy[i]!;
          len += Math.sqrt(ex * ex + ey * ey);
          i++;
        }
        const before = runStart > l.start && v.seg[runStart - 1] === 1 && v.cover[runStart - 1] !== target;
        const after = i < end && v.seg[i] === 1 && v.cover[i] !== target;
        if (before && after && len < limit) for (let q = runStart; q < i; q++) v.cover[q] = 1 - target;
      }
    }
  }

  /**
   * Silhouette ring of a body whose disc the renderer draws (projected radius from BODY_ICON_MAX_RADIUS_PX;
   * below that the map draws the body as an icon): the outline of the solid sphere seen from the eye, strong on
   * the night side, faint on the lit side (alpha per vertex from the sun direction at that point of the limb).
   * Its chords dip below the sphere between vertices, so it is tested against the sphere shrunk by that depth
   * (as the zone rings are): the body never hides its own outline.
   */
  private addLimbLine(scene: MapScene, b: BodyInfo): void {
    const proj = scene.proj;
    const c = proj.toView(b.pos);
    const L = Math.hypot(c.x, c.y, c.z);
    if (!(L > b.radius * 1.0001) || -c.z <= 0) return;
    const radiusPx = Math.tan(Math.min(Math.asin(b.radius / L), 1.5)) * proj.focal;
    if (radiusPx < BODY_ICON_MAX_RADIUS_PX * proj.pxScale) return;
    const rec = this.addSphereOutline(scene, `limb:${b.id}`, 'limb', c, b.radius, COLORS.limb, LIMB_WIDTH_PX);
    if (!rec) return;
    rec.casing = false;
    const v = this.verts;
    const s = proj.rotate(b.sunDir, this.tmpV);
    const sx = s.x;
    const sy = s.y;
    const sz = s.z;
    let depth = 0;
    for (let i = rec.start; i < rec.start + rec.count; i++) {
      const nx = (v.vx[i]! - c.x) / b.radius;
      const ny = (v.vy[i]! - c.y) / b.radius;
      const nz = (v.vz[i]! - c.z) / b.radius;
      // lit side of the limb (cos of the angle to the sun), smoothly to the faint day value
      const lit = Math.min(1, Math.max(0, (nx * sx + ny * sy + nz * sz + 0.05) / 0.3));
      v.alpha[i] = 1 - (1 - LIMB_DAY_FACTOR) * lit * lit * (3 - 2 * lit);
      if (i < rec.start + rec.count - 1 && v.seg[i] === 1) {
        const mx = (v.vx[i]! + v.vx[i + 1]!) / 2 - c.x;
        const my = (v.vy[i]! + v.vy[i + 1]!) / 2 - c.y;
        const mz = (v.vz[i]! + v.vz[i + 1]!) / 2 - c.z;
        depth = Math.max(depth, b.radius - Math.sqrt(mx * mx + my * my + mz * mz));
      }
    }
    rec.occlusionSlack = depth + SURFACE_SLACK_MARGIN * b.radius;
  }

  /**
   * SOI sphere: its silhouette, seen from outside. From inside there is no silhouette and nothing is drawn (a
   * great circle through the body would read as a second orbit beside the body's own).
   */
  private addSoiLine(scene: MapScene, b: BodyInfo): void {
    const c = scene.proj.toView(b.pos);
    const L = Math.hypot(c.x, c.y, c.z);
    if (L > b.soi! * 1.0001) this.addSphereOutline(scene, `soi:${b.id}`, 'soi', c, b.soi!, COLORS.soi, FAINT_LINE_WIDTH_PX);
  }

  /** Silhouette circle of a sphere seen from the eye (nothing when the eye is inside it). */
  private addSphereOutline(scene: MapScene, id: string, kind: LineKind, c: Vec3, R: number, color: Rgba, widthPx: number): PatchCurveLine | null {
    const L = Math.hypot(c.x, c.y, c.z);
    if (!(L > R)) return null;
    const k = 1 - (R * R) / (L * L);
    const centre = v3.scale(c, k);
    const radius = R * Math.sqrt(k);
    const n = v3.scale(c, 1 / L);
    const u = v3.anyOrthogonal(n);
    const w = v3.cross(n, u);
    const curve = this.nextCurve().setCircle(centre, u, w, radius);
    return this.addCurve(scene, id, kind, curve, 0, TWO_PI, color, widthPx, false);
  }

  /** A recovery zone: the small circle of the zone radius lying on the body sphere (body-fixed, rotates with it). */
  private addZoneLine(scene: MapScene, t: SurfaceTarget, b: BodyInfo): void {
    // Zones appear with the other surface targets, once the body is large enough on screen.
    const c = scene.proj.toView(b.pos);
    const L = Math.hypot(c.x, c.y, c.z);
    if (L > b.radius && Math.tan(Math.asin(b.radius / L)) * scene.proj.focal < TARGET_MIN_BODY_PX * scene.proj.pxScale) return;
    const rho = Math.min(t.radius / b.radius, Math.PI / 2);
    const nFixed = latLonToDir(t.latitude, t.longitude);
    let east = v3.cross({ x: 0, y: 0, z: 1 }, nFixed);
    east = v3.len(east) < 1e-9 ? { x: 0, y: 1, z: 0 } : v3.normalize(east);
    const north = v3.cross(nFixed, east);
    const n = quat.rotate(b.q, nFixed);
    const e = quat.rotate(b.q, east);
    const no = quat.rotate(b.q, north);
    const centreRoot = v3.add(b.pos, v3.scale(n, b.radius * Math.cos(rho)));
    const proj = scene.proj;
    const curve = this.nextCurve().setCircle(proj.toView(centreRoot, this.tmpV), proj.rotate(e), proj.rotate(no), b.radius * Math.sin(rho));
    const rec = this.addCurve(scene, `zone:${t.id}`, 'recoveryZone', curve, 0, TWO_PI, COLORS.recovery, ZONE_LINE_WIDTH_PX, false);
    if (!rec) return;
    // The chords cut below the sphere between vertices: the line is tested against the sphere shrunk by the
    // deepest chord midpoint (a radial allowance, the same at the limb as at the centre of the disc).
    const v = this.verts;
    let depth = 0;
    for (let i = rec.start; i < rec.start + rec.count - 1; i++) {
      if (v.seg[i] !== 1) continue;
      const mx = (v.vx[i]! + v.vx[i + 1]!) / 2 - c.x;
      const my = (v.vy[i]! + v.vy[i + 1]!) / 2 - c.y;
      const mz = (v.vz[i]! + v.vz[i + 1]!) / 2 - c.z;
      depth = Math.max(depth, b.radius - Math.sqrt(mx * mx + my * my + mz * mz));
    }
    rec.occlusionSlack = depth + SURFACE_SLACK_MARGIN * b.radius;
  }
}

const ORIGIN: Vec3 = { x: 0, y: 0, z: 0 };
const NO_HEADING: AxisScreen = { dx: 0, dy: 0, extent: 0 };

/** Do breakpoints made for eccentricity `e` still apply to `curve` (same parameter kind assumed)? */
function sameShape(e: number, curve: ViewConic): boolean {
  if (curve.kind === 'nu') return e === curve.e;
  return Math.abs(curve.e - e) <= REUSE_SHAPE_TOLERANCE * Math.abs(1 - curve.e * curve.e);
}

/**
 * Arc length (m) of a placed conic between sampling parameters u0 and u1, given the speed f0 = |dr/du| at u0:
 * composite Simpson over panels of at most ARC_PANEL in the parameter (exact for a circle; for e = 0.97 the
 * relative error of a 0.05 rad panel is below 1e-6). The speed at u1 is left in scratch[4] for the next piece.
 * `scratch` holds five floats.
 */
const ARC_PANEL = 0.05;
function arcLength(curve: ViewConic, u0: number, u1: number, f0: number, scratch: Float64Array): number {
  const span = u1 - u0;
  const f1 = conicSpeed(curve, u1, scratch);
  scratch[4] = f1;
  if (!(Math.abs(span) > 0)) return 0;
  const n = Math.min(4096, Math.max(1, Math.ceil(Math.abs(span) / ARC_PANEL)));
  const h = span / n;
  let sum = f0 + f1;
  for (let i = 1; i < n; i++) sum += 2 * conicSpeed(curve, u0 + i * h, scratch);
  for (let i = 0; i < n; i++) sum += 4 * conicSpeed(curve, u0 + (i + 0.5) * h, scratch);
  return Math.abs((h / 6) * sum);
}

/** Clip the segment (a, a + d) to a box: true and the parameter range in out[0..1] when part of it is inside. */
function clipToBox(ax: number, ay: number, dx: number, dy: number, x0: number, y0: number, x1: number, y1: number, out: Float64Array): boolean {
  out[0] = 0;
  out[1] = 1;
  return clipEdge(-dx, ax - x0, out) && clipEdge(dx, x1 - ax, out) && clipEdge(-dy, ay - y0, out) && clipEdge(dy, y1 - ay, out) && out[1]! > out[0]!;
}

/** One Liang-Barsky boundary: narrows the range out[0..1]; false when nothing is left. */
function clipEdge(p: number, q: number, out: Float64Array): boolean {
  if (p === 0) return q >= 0;
  const r = q / p;
  if (p < 0) {
    if (r > out[1]!) return false;
    if (r > out[0]!) out[0] = r;
  } else {
    if (r < out[0]!) return false;
    if (r < out[1]!) out[1] = r;
  }
  return true;
}

/** |dr/du| of a placed conic at parameter u (m per unit parameter). */
function conicSpeed(curve: ViewConic, u: number, scratch: Float64Array): number {
  curve.perifocalWithDerivative(u, scratch);
  return Math.sqrt(scratch[2]! * scratch[2]! + scratch[3]! * scratch[3]!);
}

/**
 * Display colour of a body's icon: its mean albedo colour (linear) scaled so the brightest channel is 0.8, then
 * encoded to sRGB: the Earth a light blue, the Moon a warm light grey.
 */
function bodyTint(mean: readonly number[] | undefined): Rgba {
  const m = mean && mean.length >= 3 ? mean : [0.5, 0.5, 0.5];
  const peak = Math.max(m[0]!, m[1]!, m[2]!, 1e-6);
  const enc = (c: number): number => {
    const x = Math.max(0, Math.min(1, (0.8 * c) / peak));
    return x <= 0.0031308 ? 12.92 * x : 1.055 * Math.pow(x, 1 / 2.4) - 0.055;
  };
  return [enc(m[0]!), enc(m[1]!), enc(m[2]!), 1];
}

/** A one-element occluder list (reused: occlusionWeight only reads it). */
const ONE_OCCLUDER = (() => {
  const list: Occluder[] = [{ x: 0, y: 0, z: 0, radius: 0, vis: 0 }];
  return (o: Occluder): Occluder[] => {
    list[0] = o;
    return list;
  };
})();

const wrapPi = (a: number): number => {
  const r = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return r === -Math.PI ? Math.PI : r;
};
