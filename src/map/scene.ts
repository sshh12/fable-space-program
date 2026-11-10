/**
 * Builds the projected map geometry for one (snapshot, camera, viewport): sampled polylines of every
 * trajectory and reference orbit, markers, nodes, bodies, vessels and surface targets, all positioned in
 * float64 and projected by one Projector. Both the GPU draw list and hit-testing read this structure, so
 * the pointer is always tested against exactly what is drawn.
 */
import type { CameraState } from '@/core/contracts/render';
import type { DefLibrary } from '@/core/contracts/defs';
import type { Marker, MarkerKind, Patch, SimSnapshot, SurfaceTarget, VesselSnapshot } from '@/core/contracts/sim';
import { latLonToDir } from '@/core/geo/cubeSphere';
import { conicFromState, conicMaxTrueAnomaly, conicPosition, conicRadiusCrossing, conicTrueAnomaly, timeSincePeriapsis, type ConicElements } from '@/core/math/conic';
import { quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { isFullRevolution } from './anomalyTime';
import { ViewConic } from './conicCurve';
import {
  AFTER_NODE_DIM,
  CHORD_TOLERANCE_PX,
  COLORS,
  FAINT_CHORD_TOLERANCE_PX,
  FADE_FLOOR,
  FAINT_LINE_WIDTH_PX,
  LINE_WIDTH_PX,
  MAX_POINTS_PER_CURVE,
  OCCLUSION_FADE_PX,
  SMALL_OBJECT_PX,
  TARGET_MIN_BODY_PX,
  type Rgba,
} from './constants';
import { locateNode, type NodeLocation, type PatchKey, type PatchList } from './nodes';
import { occlusionWeight, type Occluder } from './occlusion';
import { Projector, type Viewport } from './projection';
import { FAINT_MAX_TURN, Sampler } from './sampler';

const TWO_PI = 2 * Math.PI;

export type LineKind = 'current' | 'planned' | 'vesselOrbit' | 'debrisOrbit' | 'bodyOrbit' | 'soi' | 'recoveryZone' | 'ghostBody';

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
  /** The sampled curve (for parameter -> anomaly on hit-testing); null for a radial (straight) patch. */
  curve: ViewConic | null;
  /** Set for trajectories of the active vessel. */
  patchKey?: PatchKey;
  patch?: Patch;
  /** Vertices on screen and in front of the eye (for tests and the lab statistics). */
  visibleVertices: number;
  capped: boolean;
  /** Curve evaluations the sampler spent on this line this frame. */
  evaluations: number;
  /**
   * Depth (m) below a body surface that still counts as on it in the occlusion test: non-zero for lines
   * lying on a body (recovery zones), whose chords dip below the sphere between vertices.
   */
  occlusionSlack: number;
}

/** A line sampled from a conic (every line except a radial patch). */
export type PatchCurveLine = LineRecord & { curve: ViewConic };

export type MarkerShape =
  | 'apsis'
  | 'inclination'
  | 'soi'
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
  kind: MarkerKind | 'impactSurface' | 'entrySurface';
  marker: Marker;
  patchKey: PatchKey;
  shape: MarkerShape;
  color: Rgba;
  /** Short label (first line bright, rest dim) and the hover details. */
  label: string[];
  details: string[];
  priority: number;
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
}

export interface VesselItem extends PointItem {
  vesselId: string;
  name: string;
  active: boolean;
  debris: boolean;
}

export interface TargetItem extends PointItem {
  target: SurfaceTarget;
  shape: MarkerShape;
  color: Rgba;
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
  /** Cumulative screen length along the polyline, device px. */
  len = new Float64Array(0);
  /** Per-vertex alpha multiplier (time fade). */
  alpha = new Float64Array(0);

  reserve(extra: number): void {
    const need = this.n + extra;
    if (need <= this.capacity) return;
    const cap = Math.max(need, Math.ceil(this.capacity * 1.5), 4096);
    const grow = (a: Float64Array): Float64Array<ArrayBuffer> => {
      const b = new Float64Array(cap);
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
    this.alpha = grow(this.alpha);
    this.capacity = cap;
  }
}

export interface SceneOptions {
  /**
   * Draw encounter patches around their body's position at the intercept (derived from the preceding
   * patch's Patch.bodyPosAtEnd) instead of its current position.
   */
  atIntercept: boolean;
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
  /** ROOT origin of each body's patches (current position, or the at-intercept anchor). */
  ghostAnchors: Map<string, Vec3>;
}

interface BodyInfo {
  id: string;
  name: string;
  radius: number;
  pos: Vec3;
  q: SimSnapshot['bodies'][number]['qFixedToRoot'];
  soi: number | null;
  orbit: ConicElements | null;
  parent: string | null;
  attractor: boolean;
}

const MARKER_STYLE: Record<MarkerKind, { shape: MarkerShape; color: Rgba; priority: number }> = {
  apoapsis: { shape: 'apsis', color: COLORS.apsis, priority: 6 },
  periapsis: { shape: 'apsis', color: COLORS.apsis, priority: 6 },
  ascendingNode: { shape: 'inclination', color: COLORS.inclination, priority: 3 },
  descendingNode: { shape: 'inclination', color: COLORS.inclination, priority: 3 },
  soiEnter: { shape: 'soi', color: COLORS.soiMarker, priority: 5 },
  soiExit: { shape: 'soi', color: COLORS.soiMarker, priority: 5 },
  impact: { shape: 'impact', color: COLORS.impact, priority: 8 },
  atmosphereEntry: { shape: 'entry', color: COLORS.entry, priority: 8 },
  closestApproach: { shape: 'closest', color: COLORS.closest, priority: 4 },
  maneuverNode: { shape: 'node', color: COLORS.node, priority: 9 },
};

export interface LabelSource {
  markerLabel(item: Omit<MarkerItem, 'label' | 'details'>, scene: { snapshot: SimSnapshot; defs: DefLibrary }): { label: string[]; details: string[] };
}

export class SceneBuilder {
  private readonly sampler = new Sampler();
  private readonly verts = new VertexArrays();
  private readonly tmpV: Vec3 = { x: 0, y: 0, z: 0 };
  /** Label text per marker object, reused while the snapshot time and target are unchanged (camera-only frames). */
  private readonly labelCache = new WeakMap<Marker, Map<string, { ut: number; target: string | null; text: { label: string[]; details: string[] } }>>();

  constructor(
    private readonly defs: DefLibrary,
    private readonly labels: LabelSource,
  ) {}

  build(snapshot: SimSnapshot, camera: CameraState, viewport: Viewport, options: SceneOptions): MapScene {
    const proj = new Projector(camera, viewport);
    const verts = this.verts;
    verts.n = 0;
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
      ghostAnchors: new Map(),
    };
    const bodies = this.bodyInfo(snapshot);
    const active = snapshot.vessels.find((v) => v.id === snapshot.activeVesselId) ?? null;

    // Encounter anchors for at-intercept drawing: one per body, its ROOT position at the intercept (SOI
    // entry) of its first encounter patch. The preceding patch ends there in ROOT at
    // prev.bodyPosAtEnd + r(prev.nuEnd) (Patch contract), so the body sat at that point minus the
    // encounter conic's start: the drawn chain is continuous at the intercept. An encounter patch without a
    // predecessor in its list falls back to its own bodyPosAtEnd.
    const anchors = new Map<string, Vec3>();
    if (options.atIntercept) {
      for (const list of [snapshot.patches.current, snapshot.patches.planned]) {
        list.forEach((p, i) => {
          if ((active && p.bodyId === active.bodyId) || p.bodyId === this.defs.rootBodyId || anchors.has(p.bodyId)) return;
          const prev = list[i - 1];
          if (prev && prev.bodyId !== p.bodyId) {
            const endRoot = v3.add(prev.bodyPosAtEnd, conicPosition(prev.conic, prev.nuEnd));
            anchors.set(p.bodyId, v3.sub(endRoot, conicPosition(p.conic, p.nuStart)));
          } else anchors.set(p.bodyId, v3.clone(p.bodyPosAtEnd));
        });
      }
    }
    scene.ghostAnchors = anchors;

    // Occluders: every body at its current position, plus ghosts at their anchors.
    for (const b of bodies.values()) {
      if (!(b.radius > 0)) continue;
      const c = proj.toView(b.pos);
      scene.occluders.push({ x: c.x, y: c.y, z: c.z, radius: b.radius });
    }
    for (const [id, pos] of anchors) {
      const b = bodies.get(id);
      if (!b || !(b.radius > 0)) continue;
      const c = proj.toView(pos);
      scene.occluders.push({ x: c.x, y: c.y, z: c.z, radius: b.radius });
    }

    const patchOrigin = (p: Patch): Vec3 => {
      const anchor = anchors.get(p.bodyId);
      if (anchor) return anchor;
      return bodies.get(p.bodyId)?.pos ?? v3.zero();
    };

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
    for (const [id, pos] of anchors) {
      const b = bodies.get(id);
      if (!b || !(b.radius > 0)) continue;
      this.addSphereOutline(scene, `ghost:${id}`, 'ghostBody', proj.toView(pos), b.radius, COLORS.ghost, FAINT_LINE_WIDTH_PX, b.orbit);
    }
    for (const v of snapshot.vessels) {
      if (v.id === snapshot.activeVesselId) continue;
      this.addVesselOrbit(scene, v, bodies, snapshot.ut);
    }
    for (const t of snapshot.surfaceTargets) {
      if (t.kind !== 'recovery' || !(t.radius > 0)) continue;
      const b = bodies.get(t.bodyId);
      if (b) this.addZoneLine(scene, t, b);
    }

    // ------------------------------------------------------------------------------ trajectories
    const firstNodeUt = snapshot.nodes.length > 0 ? Math.min(...snapshot.nodes.map((n) => n.ut)) : Infinity;
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

    // ---------------------------------------------------------------------------------- markers
    const markerPatches: [PatchList, Patch[]][] = [
      ['current', snapshot.patches.current],
      ['planned', snapshot.patches.planned],
    ];
    const labelOf = (item: Omit<MarkerItem, 'label' | 'details'>): { label: string[]; details: string[] } => {
      let per = this.labelCache.get(item.marker);
      if (!per) this.labelCache.set(item.marker, (per = new Map()));
      const hit = per.get(item.kind);
      const target = snapshot.readouts.targetBodyId;
      if (hit && hit.ut === snapshot.ut && hit.target === target) return hit.text;
      const text = this.labels.markerLabel(item, { snapshot, defs: this.defs });
      per.set(item.kind, { ut: snapshot.ut, target, text });
      return text;
    };
    for (const [list, patches] of markerPatches) {
      patches.forEach((p, index) => {
        if (list === 'planned' && p.afterNodeId === undefined) return;
        const origin = patchOrigin(p);
        const counts = new Map<string, number>();
        for (const m of p.markers) {
          if (m.kind === 'maneuverNode') continue;
          const n = (counts.get(m.kind) ?? 0) + 1;
          counts.set(m.kind, n);
          const id = `${list}/${index}/${m.kind}${n > 1 ? `#${n}` : ''}`;
          const frameOrigin = m.bodyId === p.bodyId ? origin : bodies.get(m.bodyId)?.pos ?? origin;
          const root = v3.add(frameOrigin, m.r);
          const style = MARKER_STYLE[m.kind];
          const base = this.point(scene, id, root);
          const item = { ...base, kind: m.kind, marker: m, patchKey: { list, index }, shape: style.shape, color: style.color, priority: style.priority };
          scene.markers.push({ ...item, ...labelOf(item) });
          // Impact and entry points also sit on the ground, on the body as it is now (body-fixed lat/lon).
          if ((m.kind === 'impact' || m.kind === 'atmosphereEntry') && m.latitude !== undefined && m.longitude !== undefined) {
            const b = bodies.get(m.bodyId);
            if (b) {
              const dirFixed = latLonToDir(m.latitude, m.longitude);
              const rootS = v3.add(b.pos, v3.scale(quat.rotate(b.q, dirFixed), b.radius));
              const sBase = this.point(scene, `${id}/surface`, rootS);
              const kind = m.kind === 'impact' ? ('impactSurface' as const) : ('entrySurface' as const);
              const sItem = { ...sBase, kind, marker: m, patchKey: { list, index }, shape: 'surfacePoint' as const, color: style.color, priority: 2 };
              scene.markers.push({ ...sItem, ...labelOf(sItem) });
            }
          }
        }
      });
    }

    // ------------------------------------------------------------------------------------ nodes
    for (const node of snapshot.nodes) {
      const loc = locateNode(snapshot, node);
      if (!loc) continue;
      const root = v3.add(patchOrigin(loc.patch), loc.rBody);
      const base = this.point(scene, node.id, root);
      scene.nodes.push({
        ...base,
        loc,
        root,
        axes: {
          prograde: this.axisScreen(scene, root, loc.prograde),
          normal: this.axisScreen(scene, root, loc.normal),
          radial: this.axisScreen(scene, root, loc.radial),
        },
      });
    }

    // ------------------------------------------------------------------------- bodies, vessels
    const pxScale = viewport.pxScale;
    for (const b of bodies.values()) {
      if (!(b.radius > 0)) continue;
      scene.bodies.push(this.bodyItem(scene, b.id, b.name, b.pos, b.radius, false, pxScale));
    }
    for (const [id, pos] of anchors) {
      const b = bodies.get(id);
      if (!b) continue;
      scene.bodies.push(this.bodyItem(scene, `${id}@intercept`, b.name, pos, b.radius, true, pxScale));
    }
    for (const v of snapshot.vessels) {
      const base = this.point(scene, v.id, v.rRoot);
      scene.vessels.push({ ...base, vesselId: v.id, name: v.name, active: v.id === snapshot.activeVesselId, debris: !v.controllable });
    }

    // --------------------------------------------------------------------------- surface targets
    for (const t of snapshot.surfaceTargets) {
      const b = bodies.get(t.bodyId);
      if (!b) continue;
      const rootT = v3.add(b.pos, v3.scale(quat.rotate(b.q, latLonToDir(t.latitude, t.longitude)), b.radius));
      const base = this.point(scene, t.id, rootT);
      const shape: MarkerShape = t.kind === 'landing' ? 'pin' : t.kind === 'site' ? 'pad' : 'zone';
      const color = t.kind === 'landing' ? COLORS.landing : t.kind === 'site' ? COLORS.site : COLORS.recovery;
      scene.targets.push({ ...base, target: t, shape, color });
    }
    return scene;
  }

  // -------------------------------------------------------------------------------------- helpers

  private bodyInfo(s: SimSnapshot): Map<string, BodyInfo> {
    const out = new Map<string, BodyInfo>();
    for (const b of s.bodies) {
      const def = this.defs.bodies[b.id];
      out.set(b.id, {
        id: b.id,
        name: def?.name ?? b.id,
        radius: def?.radius ?? 0,
        pos: b.rRoot,
        q: b.qFixedToRoot,
        soi: b.soiRadius,
        orbit: b.orbit,
        parent: def?.parent ?? null,
        attractor: def?.gravityRole === 'attractor',
      });
    }
    return out;
  }

  /** Projected point with occlusion. */
  private point(scene: MapScene, id: string, root: Vec3): PointItem {
    const proj = scene.proj;
    const view = proj.toView(root);
    const sp = proj.projectView(view);
    const hidden = sp.front ? occlusionWeight(view, scene.occluders, proj.focal, OCCLUSION_FADE_PX * proj.pxScale) : 1;
    return { id, x: sp.x, y: sp.y, front: sp.front, hidden, view };
  }

  private axisScreen(scene: MapScene, root: Vec3, axisRoot: Vec3): AxisScreen {
    const proj = scene.proj;
    const a = proj.rotate(axisRoot);
    const p = proj.toView(root);
    const dist = Math.hypot(p.x, p.y, p.z);
    // Component of the axis perpendicular to the view ray, and its screen direction (derivative of the projection).
    const rx = p.x / dist;
    const ry = p.y / dist;
    const rz = p.z / dist;
    const along = a.x * rx + a.y * ry + a.z * rz;
    const extent = Math.sqrt(Math.max(0, 1 - along * along));
    const depth = -p.z;
    // d(screen)/d(t) for p + t a: x' = (a.x depth + p.x a.z) / depth^2 ... (y flipped)
    const dxs = (a.x * depth + p.x * a.z) / (depth * depth);
    const dys = -(a.y * depth + p.y * a.z) / (depth * depth);
    const l = Math.hypot(dxs, dys);
    return l > 0 ? { dx: dxs / l, dy: dys / l, extent } : { dx: 1, dy: 0, extent: 0 };
  }

  private bodyItem(scene: MapScene, id: string, name: string, pos: Vec3, radius: number, ghost: boolean, pxScale: number): BodyItem {
    const proj = scene.proj;
    const view = proj.toView(pos);
    const sp = proj.projectView(view);
    const L = Math.hypot(view.x, view.y, view.z);
    const ang = L > radius ? Math.asin(radius / L) : Math.PI / 2;
    const radiusPx = Math.tan(Math.min(ang, 1.5)) * proj.focal;
    // A body is hidden by another body in front of it (never by itself).
    const others = scene.occluders.filter((o) => Math.abs(o.x - view.x) + Math.abs(o.y - view.y) + Math.abs(o.z - view.z) > 1e-3 * radius);
    const hidden = sp.front ? occlusionWeight(view, others, proj.focal, OCCLUSION_FADE_PX * pxScale) : 1;
    const small = 2 * radiusPx < SMALL_OBJECT_PX * pxScale;
    return { id, x: sp.x, y: sp.y, front: sp.front, hidden, view, bodyId: ghost ? id.slice(0, id.indexOf('@')) : id, name, radiusPx, small, ghost, label: ghost ? `${name} (encounter)` : name };
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
    const curve = new ViewConic().setFromElements(conic, focusRoot, scene.proj);
    return this.addCurve(scene, id, kind, curve, curve.nuToU(nu0), curve.nuToU(nu1), color, widthPx, dashed);
  }

  private addCurve(scene: MapScene, id: string, kind: LineKind, curve: ViewConic, u0: number, u1: number, color: Rgba, widthPx: number, dashed: boolean): PatchCurveLine | null {
    const proj = scene.proj;
    const faint = kind === 'debrisOrbit' || kind === 'vesselOrbit' || kind === 'recoveryZone';
    const s = faint ? this.sampler.sample(curve, u0, u1, proj, FAINT_CHORD_TOLERANCE_PX, MAX_POINTS_PER_CURVE, FAINT_MAX_TURN) : this.sampler.sample(curve, u0, u1, proj, CHORD_TOLERANCE_PX);
    if (s.count < 2) return null;
    const verts = this.verts;
    verts.reserve(s.count);
    const start = verts.n;
    let len = 0;
    let visible = 0;
    for (let i = 0; i < s.count; i++) {
      const j = start + i;
      verts.vx[j] = s.vx[i]!;
      verts.vy[j] = s.vy[i]!;
      verts.vz[j] = s.vz[i]!;
      const sx = s.sx[i]!;
      const sy = s.sy[i]!;
      verts.sx[j] = sx;
      verts.sy[j] = sy;
      verts.u[j] = s.u[i]!;
      verts.t[j] = NaN;
      verts.alpha[j] = 1;
      if (i > 0) {
        const dx = sx - verts.sx[j - 1]!;
        const dy = sy - verts.sy[j - 1]!;
        if (Number.isFinite(dx) && Number.isFinite(dy)) len += Math.sqrt(dx * dx + dy * dy);
      }
      verts.len[j] = len;
      if (Number.isFinite(sx) && proj.onScreen(sx, sy)) visible++;
    }
    verts.n = start + s.count;
    const rec: PatchCurveLine = { kind, id, start, count: s.count, color, width: widthPx * proj.pxScale, dashed, curve, visibleVertices: visible, capped: s.capped, evaluations: s.evaluations, occlusionSlack: 0 };
    scene.lines.push(rec);
    return rec;
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
    // Time at every vertex (first lap for multi-revolution patches) and the fade with time ahead. With the
    // eccentric/hyperbolic anomaly as the parameter this is Kepler's equation itself: dt = dM / n.
    const verts = this.verts;
    const curve = rec.curve;
    const tspStart = timeSincePeriapsis(c, wrapPi(p.nuStart));
    const aAbs = Math.abs(c.a);
    const meanMotion = Number.isFinite(aAbs) ? Math.sqrt(c.mu / (aAbs * aAbs * aAbs)) : NaN;
    const m0 = curve.meanAnomaly(verts.u[rec.start]!);
    for (let i = 0; i < rec.count; i++) {
      const j = rec.start + i;
      let t: number;
      if (Number.isFinite(m0) && Number.isFinite(meanMotion)) t = p.tStart + (curve.meanAnomaly(verts.u[j]!) - m0) / meanMotion;
      else t = p.tStart + (timeSincePeriapsis(c, curve.uToNu(verts.u[j]!)) - tspStart);
      verts.t[j] = t;
      const ahead = Math.max(0, t - now);
      let a = FADE_FLOOR + (1 - FADE_FLOOR) * Math.exp(-ahead / tau);
      if (t > dimAfterUt) a *= AFTER_NODE_DIM;
      verts.alpha[j] = a;
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
    const verts = this.verts;
    verts.reserve(2);
    const start = verts.n;
    let len = 0;
    let visible = 0;
    [r0, r1].forEach((r, i) => {
      const j = start + i;
      const v = proj.toView(v3.addScaled(origin, dir, r));
      const s = proj.projectView(v);
      verts.vx[j] = v.x;
      verts.vy[j] = v.y;
      verts.vz[j] = v.z;
      verts.sx[j] = s.x;
      verts.sy[j] = s.y;
      verts.u[j] = r;
      verts.t[j] = NaN;
      verts.alpha[j] = 1;
      if (i > 0 && s.front && Number.isFinite(verts.sx[j - 1]!)) len += Math.hypot(s.x - verts.sx[j - 1]!, s.y - verts.sy[j - 1]!);
      verts.len[j] = len;
      if (s.front && proj.onScreen(s.x, s.y)) visible++;
    });
    verts.n = start + 2;
    scene.lines.push({ kind: list, id: `${list}/${index}`, start, count: 2, color, width: LINE_WIDTH_PX * proj.pxScale, dashed, curve: null, visibleVertices: visible, capped: false, evaluations: 0, occlusionSlack: 0 });
  }

  private addVesselOrbit(scene: MapScene, v: VesselSnapshot, bodies: Map<string, BodyInfo>, ut: number): void {
    if (v.translationMode === 'landed' || v.situation === 'landed' || v.situation === 'splashed' || v.situation === 'prelaunch') return;
    const b = bodies.get(v.bodyId);
    const mu = this.defs.bodies[v.bodyId]?.mu;
    if (!b || !mu) return;
    if (!(v3.len(v3.cross(v.r, v.v)) > 0)) return;
    const c = conicFromState(mu, v.r, v.v, ut);
    const nuNow = conicTrueAnomaly(c, v.r);
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
    const debris = !v.controllable;
    this.addConicLine(scene, `vessel:${v.id}`, debris ? 'debrisOrbit' : 'vesselOrbit', c, b.pos, nu0, nu1, debris ? COLORS.debrisOrbit : COLORS.vesselOrbit, FAINT_LINE_WIDTH_PX, false);
  }

  /** SOI sphere: its silhouette from outside, the great circle in the body's orbit plane from inside. */
  private addSoiLine(scene: MapScene, b: BodyInfo): void {
    const c = scene.proj.toView(b.pos);
    const L = Math.hypot(c.x, c.y, c.z);
    const R = b.soi!;
    if (L > R * 1.0001) {
      this.addSphereOutline(scene, `soi:${b.id}`, 'soi', c, R, COLORS.soi, FAINT_LINE_WIDTH_PX, null);
    } else if (b.orbit) {
      const P = scene.proj.rotate(b.orbit.P);
      const Q = scene.proj.rotate(b.orbit.Q);
      const curve = new ViewConic().setCircle(c, P, Q, R);
      this.addCurve(scene, `soi:${b.id}`, 'soi', curve, 0, TWO_PI, COLORS.soi, FAINT_LINE_WIDTH_PX, false);
    }
  }

  /** Silhouette circle of a sphere seen from the eye (falls back to the orbit plane when the eye is inside). */
  private addSphereOutline(scene: MapScene, id: string, kind: LineKind, c: Vec3, R: number, color: Rgba, widthPx: number, orbit: ConicElements | null): void {
    const L = Math.hypot(c.x, c.y, c.z);
    if (!(L > R)) {
      if (!orbit) return;
      const curve = new ViewConic().setCircle(c, scene.proj.rotate(orbit.P), scene.proj.rotate(orbit.Q), R);
      this.addCurve(scene, id, kind, curve, 0, TWO_PI, color, widthPx, false);
      return;
    }
    const k = 1 - (R * R) / (L * L);
    const centre = v3.scale(c, k);
    const radius = R * Math.sqrt(k);
    const n = v3.scale(c, 1 / L);
    const u = v3.anyOrthogonal(n);
    const w = v3.cross(n, u);
    const curve = new ViewConic().setCircle(centre, u, w, radius);
    this.addCurve(scene, id, kind, curve, 0, TWO_PI, color, widthPx, false);
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
    const curve = new ViewConic().setCircle(proj.toView(centreRoot, this.tmpV), proj.rotate(e), proj.rotate(no), b.radius * Math.sin(rho));
    const rec = this.addCurve(scene, `zone:${t.id}`, 'recoveryZone', curve, 0, TWO_PI, COLORS.recovery, FAINT_LINE_WIDTH_PX + 0.5, false);
    if (!rec) return;
    // The chords cut below the sphere between vertices: their deepest point is the occlusion slack.
    const cb = proj.toView(b.pos);
    const v = this.verts;
    let depth = 0;
    for (let i = rec.start; i < rec.start + rec.count - 1; i++) {
      const mx = (v.vx[i]! + v.vx[i + 1]!) / 2 - cb.x;
      const my = (v.vy[i]! + v.vy[i + 1]!) / 2 - cb.y;
      const mz = (v.vz[i]! + v.vz[i + 1]!) / 2 - cb.z;
      depth = Math.max(depth, b.radius - Math.sqrt(mx * mx + my * my + mz * mz));
    }
    rec.occlusionSlack = depth + 1e-3 * b.radius;
  }
}

const wrapPi = (a: number): number => {
  const r = a - TWO_PI * Math.floor((a + Math.PI) / TWO_PI);
  return r === -Math.PI ? Math.PI : r;
};
