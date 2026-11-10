/**
 * The map view's CPU half: scene caching, hit-testing, maneuver-node editing, target/focus requests,
 * describe() and the per-frame draw list. No WebGPU and no DOM here, so all of it runs in vitest; the
 * GPU renderer (gpu/) and the DOM node panel (panel.ts) are thin layers on top (mapView.ts).
 *
 * Every edit goes through PlayerCommands (addNode / setNode / removeNode / setTarget). The map never
 * predicts a trajectory: the edited plan comes back as patches in the next snapshot.
 */
import type { PlayerCommands, PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { ManeuverNode, SimSnapshot } from '@/core/contracts/sim';
import type { MapElementInfo, MapUpdateResult, MapView } from '@/core/contracts/ui';
import { utAtTrueAnomaly } from './anomalyTime';
import {
  CLICK_SLOP_PX,
  COARSE_FACTOR,
  COLORS,
  DV_PER_PX,
  FINE_FACTOR,
  HANDLE_DISTANCE_PX,
  HANDLE_MIN_FORESHORTEN,
  HANDLE_RADIUS_PX,
  HANDLE_TRAVEL_PX,
  HIT_TOLERANCE_PX,
  LABEL_GAP_PX,
  LABEL_LINE_PX,
  MARKER_RADIUS_PX,
  NODE_RADIUS_PX,
  RAMP_DOUBLING_S,
  RAMP_MAX_RATE,
  RAMP_START_RATE,
  TARGET_LABEL_BODY_PX,
  TARGET_MIN_BODY_PX,
  WHEEL_DV,
  type Rgba,
} from './constants';
import { ICON, type DrawList, type IconId, type IconInstance, type TextMetricsLike, type TextRun } from './drawList';
import { formatDistance, formatDuration, formatDv, formatTimeTo } from './format';
import { declutter, markerLabels, type LabelBox } from './labels';
import { occlusionWeight } from './occlusion';
import { closestParam2D } from './sampler';
import { SceneBuilder, type LineRecord, type MapScene, type MarkerShape, type NodeItem } from './scene';

export type DvComponent = keyof ManeuverNode['dv'];
export type HandleName = 'prograde' | 'retrograde' | 'normal' | 'antinormal' | 'radialOut' | 'radialIn';

export const HANDLES: readonly { name: HandleName; comp: DvComponent; sign: 1 | -1; icon: IconId; color: Rgba }[] = [
  { name: 'prograde', comp: 'prograde', sign: 1, icon: ICON.prograde, color: COLORS.prograde },
  { name: 'retrograde', comp: 'prograde', sign: -1, icon: ICON.retrograde, color: COLORS.prograde },
  { name: 'normal', comp: 'normal', sign: 1, icon: ICON.normal, color: COLORS.normal },
  { name: 'antinormal', comp: 'normal', sign: -1, icon: ICON.antinormal, color: COLORS.normal },
  { name: 'radialOut', comp: 'radial', sign: 1, icon: ICON.radialOut, color: COLORS.radial },
  { name: 'radialIn', comp: 'radial', sign: -1, icon: ICON.radialIn, color: COLORS.radial },
];

export interface HandleLayout {
  name: HandleName;
  comp: DvComponent;
  sign: 1 | -1;
  /** Unit screen direction from the node (device px space) and the rest position. */
  dx: number;
  dy: number;
  x: number;
  y: number;
}

/** Modifier factor of a drag or wheel step: Shift = fine (x0.1), Ctrl = coarse (x10). */
export const modifierFactor = (p: Pick<PointerState, 'shift' | 'ctrl'>): number => (p.shift ? FINE_FACTOR : p.ctrl ? COARSE_FACTOR : 1);

/** Delta-v change for a pointer movement of (dx, dy) CSS px along a handle's unit screen direction. */
export const dragDelta = (dx: number, dy: number, dirX: number, dirY: number, sign: 1 | -1, factor: number): number =>
  sign * (dx * dirX + dy * dirY) * DV_PER_PX * factor;

type Hit =
  | { type: 'handle'; d: number; handle: HandleLayout; node: NodeItem }
  | { type: 'node'; d: number; node: NodeItem }
  | { type: 'line'; d: number; line: LineRecord; u: number }
  | { type: 'vessel'; d: number; id: string }
  | { type: 'body'; d: number; id: string }
  | { type: 'marker'; d: number; index: number };

type DragState =
  | {
      type: 'handle';
      nodeId: string;
      comp: DvComponent;
      sign: 1 | -1;
      dirX: number;
      dirY: number;
      value: number;
      travel: number;
      rampSince: number | null;
      lastMs: number;
      handle: HandleName;
    }
  | { type: 'node'; nodeId: string; lastUt: number };

type Pending =
  | { type: 'node'; nodeId: string; x: number; y: number; moved: number }
  | { type: 'line'; line: LineRecord; u: number; x: number; y: number; moved: number }
  | { type: 'body'; id: string; x: number; y: number; moved: number }
  | { type: 'empty'; x: number; y: number; moved: number };

export interface PanelState {
  nodeId: string;
  index: number;
  count: number;
  dv: ManeuverNode['dv'];
  total: number;
  ut: number;
  timeTo: number;
  /** Period of the conic the node sits on (null when open): enables the +/- orbit buttons. */
  period: number | null;
  canMinusOrbit: boolean;
  /** Screen anchor (CSS px) next to the node, already clamped into the viewport. */
  x: number;
  y: number;
}

export type PanelField = 'prograde' | 'normal' | 'radial' | 'ut';

export interface MapControllerOptions {
  /** Milliseconds clock (default: performance.now when available). */
  now?: () => number;
  /** Monospace text metrics in device px at pxScale 1 (default: 12 px Consolas-like). */
  textMetrics?: (pxScale: number) => TextMetricsLike;
}

export interface MapStats {
  lines: { id: string; kind: string; vertices: number; visibleVertices: number; capped: boolean; evaluations: number }[];
  markers: number;
  nodes: number;
  targets: number;
  icons: number;
  glyphs: number;
}

/** Metrics of the 12 px monospace label font without an atlas (vitest); the atlas reports the real ones. */
export const defaultTextMetrics = (pxScale: number): TextMetricsLike => ({ advance: 6.6 * pxScale, lineHeight: LABEL_LINE_PX * pxScale });

export class MapController implements MapView {
  private active = false;
  private atIntercept = false;
  private readonly builder: SceneBuilder;
  private scene: MapScene | null = null;
  private sceneCssSize: [number, number] = [0, 0];
  private pxScale = 1;
  private selected: string | null = null;
  private selectedMissing = 0;
  private drag: DragState | null = null;
  private pending: Pending | null = null;
  private hover: Hit | null = null;
  private hoverPos: { x: number; y: number } | null = null;
  private commands: PlayerCommands | null = null;
  private panelFocused = false;
  private panelHovered = false;
  private consumed = false;
  private lastDraw: DrawList | null = null;
  private readonly now: () => number;
  private readonly metrics: (pxScale: number) => TextMetricsLike;

  constructor(
    private readonly defs: DefLibrary,
    opts: MapControllerOptions = {},
  ) {
    this.builder = new SceneBuilder(defs, markerLabels);
    this.now = opts.now ?? (() => (typeof performance !== 'undefined' ? performance.now() : 0));
    this.metrics = opts.textMetrics ?? defaultTextMetrics;
  }

  // ---------------------------------------------------------------------------------- MapView

  setActive(active: boolean): void {
    this.active = active;
    if (!active) {
      this.drag = null;
      this.pending = null;
      this.hover = null;
      this.consumed = false;
    }
  }

  get isActive(): boolean {
    return this.active;
  }

  setDrawAtIntercept(on: boolean): void {
    if (this.atIntercept !== on) {
      this.atIntercept = on;
      this.scene = null;
    }
  }

  get drawAtIntercept(): boolean {
    return this.atIntercept;
  }

  get selectedNodeId(): string | null {
    return this.selected;
  }

  selectNode(id: string | null): void {
    this.selected = id;
    this.selectedMissing = 0;
  }

  update(snapshot: SimSnapshot, camera: CameraState, commands: PlayerCommands, pointer: PointerState, displaySize: [number, number]): MapUpdateResult {
    this.commands = commands;
    if (!this.active) return { consumed: false };
    this.sceneCssSize = [displaySize[0], displaySize[1]];
    const scene = this.sceneFor(snapshot, camera, displaySize);
    const k = scene.proj.pxScale;
    const px = pointer.x * k;
    const py = pointer.y * k;
    const tMs = this.now();
    // A node selected from outside (or just added) appears one snapshot later: deselect only when it stays gone.
    if (this.selected && !snapshot.nodes.some((n) => n.id === this.selected)) {
      if (++this.selectedMissing > 2) this.selected = null;
    } else this.selectedMissing = 0;
    let focus: MapUpdateResult['focus'];
    let consumedNow = false;
    const primaryDown = (pointer.buttons & 1) !== 0;

    // ---- an active drag owns the pointer until release, wherever it goes
    if (this.drag) {
      consumedNow = true;
      this.applyDrag(scene, pointer, px, py, tMs);
      if (pointer.released || !primaryDown) this.drag = null;
    } else if (this.pending) {
      consumedNow = this.pending.type === 'node';
      this.advancePending(scene, pointer, px, py, tMs);
      consumedNow = consumedNow || this.drag !== null;
    } else if (pointer.pressed && !pointer.overUi && !this.panelHovered) {
      const hit = this.hitTest(scene, px, py, true);
      this.startPress(scene, hit, pointer, px, py, tMs);
      consumedNow = hit !== null && (hit.type === 'handle' || hit.type === 'node');
      // Press and release within one frame (a fast click).
      if (this.pending && pointer.released) this.advancePending(scene, pointer, px, py, tMs);
      else if (this.drag && pointer.released) this.drag = null;
    }

    // ---- wheel over a handle nudges by 0.1 m/s (times the modifiers)
    if (!this.drag && pointer.wheel !== 0 && !pointer.overUi) {
      const hit = this.hitTest(scene, px, py, true);
      if (hit?.type === 'handle') {
        const node = snapshot.nodes.find((n) => n.id === hit.node.loc.node.id);
        if (node) {
          const value = node.dv[hit.handle.comp] + hit.handle.sign * Math.sign(pointer.wheel) * WHEEL_DV * modifierFactor(pointer);
          commands.setNode(node.id, { dv: { [hit.handle.comp]: value } });
        }
        consumedNow = true;
      }
    }

    // ---- double click on a body or vessel: one focus request on that frame
    if (pointer.doubleClick && !pointer.overUi) {
      const hit = this.hitTest(scene, px, py, false, true);
      if (hit?.type === 'body') focus = { bodyId: hit.id };
      else if (hit?.type === 'vessel') focus = { vesselId: hit.id };
    }

    // ---- hover (for consumption, tooltips and the add-maneuver preview)
    this.hoverPos = pointer.overUi ? null : { x: px, y: py };
    this.hover = pointer.overUi || this.drag ? null : this.hitTest(scene, px, py, true, true, true);
    const hoverInteractive = this.hover !== null && (this.hover.type === 'handle' || this.hover.type === 'node');
    this.consumed = consumedNow || this.drag !== null || hoverInteractive || this.panelFocused || this.panelHovered || (this.pending?.type === 'node');
    return focus ? { consumed: this.consumed, focus } : { consumed: this.consumed };
  }

  describe(): MapElementInfo[] {
    const scene = this.scene;
    if (!scene) return [];
    const k = scene.proj.pxScale;
    const out: MapElementInfo[] = [];
    const vis = (x: number, y: number, front: boolean, hidden: number): boolean => front && hidden < 0.5 && scene.proj.onScreen(x, y);
    const push = (kind: MapElementInfo['kind'], id: string, x: number, y: number, visible: boolean): void => {
      out.push({ kind, id, x: Number.isFinite(x) ? x / k : NaN, y: Number.isFinite(y) ? y / k : NaN, visible });
    };
    for (const m of scene.markers) push('marker', m.id, m.x, m.y, vis(m.x, m.y, m.front, m.hidden));
    for (const n of scene.nodes) {
      push('node', n.id, n.x, n.y, vis(n.x, n.y, n.front, n.hidden));
      if (n.id === this.selected) for (const h of this.handleLayout(n, scene)) push('nodeHandle', `${n.id}/${h.name}`, h.x, h.y, vis(h.x, h.y, n.front, 0));
    }
    for (const b of scene.bodies) push('body', b.id, b.x, b.y, vis(b.x, b.y, b.front, b.hidden));
    for (const v of scene.vessels) push('vessel', v.id, v.x, v.y, vis(v.x, v.y, v.front, v.hidden));
    const bodyPx = new Map(scene.bodies.filter((b) => !b.ghost).map((b) => [b.bodyId, b.radiusPx / k]));
    for (const t of scene.targets) push('surfaceTarget', t.id, t.x, t.y, vis(t.x, t.y, t.front, t.hidden) && (bodyPx.get(t.target.bodyId) ?? 0) >= TARGET_MIN_BODY_PX);
    return out;
  }

  // ------------------------------------------------------------------------------ panel actions

  setPanelFocus(focused: boolean): void {
    this.panelFocused = focused;
  }

  setPanelHover(hovered: boolean): void {
    this.panelHovered = hovered;
  }

  /** State of the node editor panel for the selected node (null: no panel). */
  panelState(): PanelState | null {
    const scene = this.scene;
    if (!this.active || !scene || !this.selected) return null;
    const s = scene.snapshot;
    const node = s.nodes.find((n) => n.id === this.selected);
    const item = scene.nodes.find((n) => n.id === this.selected);
    if (!node) return null;
    const k = scene.proj.pxScale;
    const [w, h] = this.sceneCssSize;
    // Beside the node, clear of the gizmo; clamped so the whole panel (220 x ~215 CSS px) stays on screen.
    let x = item && item.front ? item.x / k + 92 : w - 236;
    let y = item && item.front ? item.y / k + 28 : 24;
    x = Math.max(8, Math.min(w - 228, x));
    y = Math.max(8, Math.min(h - 224, y));
    const period = item?.loc.patch.conic.period ?? null;
    const sorted = [...s.nodes].sort((a, b) => a.ut - b.ut);
    return {
      nodeId: node.id,
      index: sorted.findIndex((n) => n.id === node.id),
      count: sorted.length,
      dv: { ...node.dv },
      total: Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial),
      ut: node.ut,
      timeTo: node.ut - s.ut,
      period,
      canMinusOrbit: period !== null && node.ut - period > s.ut,
      x,
      y,
    };
  }

  /** Apply a typed value from the numeric panel. Returns false when the text is not a finite number. */
  panelSetValue(field: PanelField, value: number): boolean {
    const st = this.panelState();
    if (!st || !this.commands || !Number.isFinite(value)) return false;
    if (field === 'ut') {
      if (!(value > this.scene!.snapshot.ut)) return false;
      return this.commands.setNode(st.nodeId, { ut: value }).ok;
    }
    return this.commands.setNode(st.nodeId, { dv: { [field]: value } }).ok;
  }

  panelAction(action: 'plusOrbit' | 'minusOrbit' | 'delete' | 'next' | 'previous'): boolean {
    const st = this.panelState();
    if (!st || !this.commands) return false;
    if (action === 'delete') {
      const ok = this.commands.removeNode(st.nodeId).ok;
      if (ok) this.selected = null;
      return ok;
    }
    if (action === 'next' || action === 'previous') {
      const sorted = [...this.scene!.snapshot.nodes].sort((a, b) => a.ut - b.ut);
      const i = st.index + (action === 'next' ? 1 : -1);
      const n = sorted[(i + sorted.length) % sorted.length];
      if (n) this.selected = n.id;
      return n !== undefined;
    }
    if (st.period === null) return false;
    if (action === 'minusOrbit' && !st.canMinusOrbit) return false;
    return this.commands.setNode(st.nodeId, { ut: st.ut + (action === 'plusOrbit' ? st.period : -st.period) }).ok;
  }

  // ---------------------------------------------------------------------------------- scenes

  /**
   * The scene for a snapshot/camera pair: the cached one when it is what was drawn (same objects or same
   * camera pose and time), else a fresh build. `cssSize` is the display size in CSS px.
   */
  sceneFor(snapshot: SimSnapshot, camera: CameraState, cssSize: [number, number], deviceSize?: [number, number]): MapScene {
    const k = deviceSize ? deviceSize[0] / Math.max(1, cssSize[0]) : this.pxScale;
    const w = Math.round(cssSize[0] * k);
    const h = Math.round(cssSize[1] * k);
    const s = this.scene;
    if (
      s &&
      s.proj.width === w &&
      s.proj.height === h &&
      s.options.atIntercept === this.atIntercept &&
      (s.snapshot === snapshot || sameTime(s.snapshot, snapshot)) &&
      (s.camera === camera || sameCamera(s.camera, camera))
    ) {
      return s;
    }
    this.pxScale = k;
    this.scene = this.builder.build(snapshot, camera, { width: w, height: h, pxScale: k }, { atIntercept: this.atIntercept });
    return this.scene;
  }

  /** Build (or reuse) the scene of the frame being rendered and its draw list. */
  frame(snapshot: SimSnapshot, camera: CameraState, deviceSize: [number, number]): DrawList | null {
    if (!this.active) return null;
    const css: [number, number] = this.sceneCssSize[0] > 0 ? this.sceneCssSize : deviceSize;
    const scene = this.sceneFor(snapshot, camera, css, deviceSize);
    this.lastDraw = this.buildDrawList(scene);
    return this.lastDraw;
  }

  get currentScene(): MapScene | null {
    return this.scene;
  }

  stats(): MapStats {
    const s = this.scene;
    const d = this.lastDraw;
    return {
      lines: s ? s.lines.map((l) => ({ id: l.id, kind: l.kind, vertices: l.count, visibleVertices: l.visibleVertices, capped: l.capped, evaluations: l.evaluations })) : [],
      markers: s?.markers.length ?? 0,
      nodes: s?.nodes.length ?? 0,
      targets: s?.targets.length ?? 0,
      icons: d ? d.icons[0].length + d.icons[1].length : 0,
      glyphs: d ? d.texts[0].reduce((n, t) => n + t.text.length, 0) + d.texts[1].reduce((n, t) => n + t.text.length, 0) : 0,
    };
  }

  // ---------------------------------------------------------------------------- interaction

  handleLayout(n: NodeItem, scene: MapScene): HandleLayout[] {
    const k = scene.proj.pxScale;
    const drag = this.drag?.type === 'handle' && this.drag.nodeId === n.id ? this.drag : null;
    return HANDLES.map((h) => {
      const axis = h.comp === 'prograde' ? n.axes.prograde : h.comp === 'normal' ? n.axes.normal : n.axes.radial;
      const dx = axis.dx * h.sign;
      const dy = axis.dy * h.sign;
      let dist = HANDLE_DISTANCE_PX * Math.max(axis.extent, HANDLE_MIN_FORESHORTEN);
      if (drag && drag.handle === h.name) dist += Math.max(-dist + NODE_RADIUS_PX + 4, Math.min(HANDLE_TRAVEL_PX, drag.travel));
      return { name: h.name, comp: h.comp, sign: h.sign, dx, dy, x: n.x + dx * dist * k, y: n.y + dy * dist * k };
    });
  }

  /**
   * Nearest interactive element within HIT_TOLERANCE_PX of (px, py) device px, measured to the drawn edge
   * of each element (icon radius, half line width); on a tie the point element wins over the line it sits
   * on, so a node on its orbit is grabbed rather than a new node added. Bodies are a fallback (a large disc
   * must not swallow clicks on the orbits drawn over it). `withMarkers` adds passive markers (tooltips).
   */
  hitTest(scene: MapScene, px: number, py: number, withLines: boolean, withBodies = true, withMarkers = false): Hit | null {
    const k = scene.proj.pxScale;
    const tol = HIT_TOLERANCE_PX * k;
    let best: Hit | null = null;
    const consider = (h: Hit): void => {
      if (h.d <= tol && (!best || h.d < best.d)) best = h;
    };
    const edge = (x: number, y: number, r: number): number => Math.max(0, Math.hypot(x - px, y - py) - r * k);
    const sel = this.selected ? scene.nodes.find((n) => n.id === this.selected) : undefined;
    if (sel && sel.front) for (const h of this.handleLayout(sel, scene)) consider({ type: 'handle', d: edge(h.x, h.y, HANDLE_RADIUS_PX), handle: h, node: sel });
    for (const n of scene.nodes) if (n.front && n.hidden < 0.5) consider({ type: 'node', d: edge(n.x, n.y, NODE_RADIUS_PX), node: n });
    for (const v of scene.vessels) if (v.front && v.hidden < 0.5) consider({ type: 'vessel', d: edge(v.x, v.y, v.active ? 7 : 4), id: v.vesselId });
    if (withMarkers) {
      scene.markers.forEach((m, index) => {
        if (m.front && m.hidden < 0.5 && m.details.length > 0) consider({ type: 'marker', d: edge(m.x, m.y, MARKER_RADIUS_PX), index });
      });
    }
    if (withLines) {
      for (const line of scene.lines) {
        if (!line.patchKey) continue;
        const h = this.lineHit(scene, line, px, py, tol + line.width / 2);
        if (h) consider({ ...h, d: Math.max(0, h.d - line.width / 2) });
      }
    }
    if (best || !withBodies) return best;
    // Fallback: bodies (small icons by distance, discs by containment).
    let body: Hit | null = null;
    for (const b of scene.bodies) {
      if (!b.front || b.hidden >= 0.5) continue;
      const d = Math.hypot(b.x - px, b.y - py);
      const reach = Math.max(b.radiusPx, tol);
      if (d <= reach && (!body || d - b.radiusPx < body.d)) body = { type: 'body', d: Math.max(0, d - b.radiusPx), id: b.bodyId };
    }
    return body;
  }

  private lineHit(scene: MapScene, line: LineRecord, px: number, py: number, tol: number): Hit | null {
    const v = scene.verts;
    let bestD = Infinity;
    let bestU = 0;
    let bestI = -1;
    let bestT = 0;
    for (let i = line.start; i < line.start + line.count - 1; i++) {
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const bx = v.sx[i + 1]!;
      const by = v.sy[i + 1]!;
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      // cheap reject
      if (Math.min(ax, bx) - tol > px || Math.max(ax, bx) + tol < px || Math.min(ay, by) - tol > py || Math.max(ay, by) + tol < py) continue;
      const t = closestParam2D(px, py, ax, ay, bx, by);
      const d = Math.hypot(px - (ax + (bx - ax) * t), py - (ay + (by - ay) * t));
      if (d < bestD) {
        bestD = d;
        bestI = i;
        bestT = t;
        bestU = v.u[i]! + (v.u[i + 1]! - v.u[i]!) * t;
      }
    }
    if (bestI < 0 || bestD > tol) return null;
    // Occluded parts of a trajectory cannot be clicked.
    const p = {
      x: v.vx[bestI]! + (v.vx[bestI + 1]! - v.vx[bestI]!) * bestT,
      y: v.vy[bestI]! + (v.vy[bestI + 1]! - v.vy[bestI]!) * bestT,
      z: v.vz[bestI]! + (v.vz[bestI + 1]! - v.vz[bestI]!) * bestT,
    };
    if (occlusionWeight(p, scene.occluders, scene.proj.focal, 6 * scene.proj.pxScale) >= 0.5) return null;
    return { type: 'line', d: bestD, line, u: bestU };
  }

  /** Closest point on a line to the pointer (no tolerance), for sliding a node along its orbit. */
  private nearestOnLine(scene: MapScene, line: LineRecord, px: number, py: number): number | null {
    const v = scene.verts;
    let bestD = Infinity;
    let bestU: number | null = null;
    for (let i = line.start; i < line.start + line.count - 1; i++) {
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const bx = v.sx[i + 1]!;
      const by = v.sy[i + 1]!;
      if (!Number.isFinite(ax) || !Number.isFinite(bx)) continue;
      const t = closestParam2D(px, py, ax, ay, bx, by);
      const d = Math.hypot(px - (ax + (bx - ax) * t), py - (ay + (by - ay) * t));
      if (d < bestD) {
        bestD = d;
        bestU = v.u[i]! + (v.u[i + 1]! - v.u[i]!) * t;
      }
    }
    return bestU;
  }

  private startPress(scene: MapScene, hit: Hit | null, pointer: PointerState, px: number, py: number, tMs: number): void {
    const s = scene.snapshot;
    if (!hit || hit.type === 'marker') {
      this.pending = { type: 'empty', x: px, y: py, moved: 0 };
      return;
    }
    switch (hit.type) {
      case 'handle': {
        const node = s.nodes.find((n) => n.id === hit.node.loc.node.id);
        if (!node) return;
        this.drag = {
          type: 'handle',
          nodeId: node.id,
          comp: hit.handle.comp,
          sign: hit.handle.sign,
          dirX: hit.handle.dx,
          dirY: hit.handle.dy,
          value: node.dv[hit.handle.comp],
          travel: 0,
          rampSince: null,
          lastMs: tMs,
          handle: hit.handle.name,
        };
        // Movement already contained in this frame's events counts.
        this.applyDrag(scene, pointer, px, py, tMs);
        return;
      }
      case 'node':
        this.selected = hit.node.id;
        this.pending = { type: 'node', nodeId: hit.node.id, x: px, y: py, moved: 0 };
        return;
      case 'line':
        this.pending = { type: 'line', line: hit.line, u: hit.u, x: px, y: py, moved: 0 };
        return;
      case 'vessel':
        this.pending = { type: 'empty', x: px, y: py, moved: 0 };
        return;
      case 'body':
        this.pending = { type: 'body', id: hit.id, x: px, y: py, moved: 0 };
        return;
    }
  }

  private advancePending(scene: MapScene, pointer: PointerState, px: number, py: number, tMs: number): void {
    const p = this.pending!;
    p.moved = Math.max(p.moved, Math.hypot(px - p.x, py - p.y));
    const slop = CLICK_SLOP_PX * scene.proj.pxScale;
    if (p.type === 'node' && p.moved > slop && (pointer.buttons & 1) !== 0) {
      const node = scene.snapshot.nodes.find((n) => n.id === p.nodeId);
      this.pending = null;
      if (node) {
        this.drag = { type: 'node', nodeId: node.id, lastUt: node.ut };
        this.applyDrag(scene, pointer, px, py, tMs);
      }
      return;
    }
    if (!pointer.released && (pointer.buttons & 1) !== 0) return;
    this.pending = null;
    if (p.moved > slop || !this.commands) return; // that was a camera drag
    const s = scene.snapshot;
    switch (p.type) {
      case 'line': {
        const patch = p.line.patch;
        const curve = p.line.curve;
        if (!patch || !curve) return;
        const nu = curve.uToNu(p.u);
        const ut = utAtTrueAnomaly(patch, nu);
        if (ut > s.ut) {
          const id = this.commands.addNode(ut);
          if (id) this.selectNode(id);
        }
        return;
      }
      case 'body': {
        const active = s.vessels.find((v) => v.id === s.activeVesselId);
        if (active && active.bodyId === p.id) {
          if (s.readouts.targetBodyId !== null) this.commands.setTarget(null);
        } else if (s.readouts.targetBodyId !== p.id) this.commands.setTarget(p.id);
        return;
      }
      case 'empty':
        this.selected = null;
        return;
      case 'node':
        return;
    }
  }

  private applyDrag(scene: MapScene, pointer: PointerState, px: number, py: number, tMs: number): void {
    const d = this.drag;
    if (!d || !this.commands) return;
    if (d.type === 'handle') {
      const factor = modifierFactor(pointer);
      const along = pointer.dx * d.dirX + pointer.dy * d.dirY;
      let value = d.value + dragDelta(pointer.dx, pointer.dy, d.dirX, d.dirY, d.sign, factor);
      d.travel += along;
      const dt = Math.max(0, (tMs - d.lastMs) / 1000);
      d.lastMs = tMs;
      if (Math.abs(d.travel) > HANDLE_TRAVEL_PX) {
        if (d.rampSince === null) d.rampSince = tMs;
        else {
          const held = (tMs - d.rampSince) / 1000;
          const rate = Math.min(RAMP_MAX_RATE, RAMP_START_RATE * Math.pow(2, held / RAMP_DOUBLING_S));
          value += d.sign * Math.sign(d.travel) * rate * dt * factor;
        }
      } else d.rampSince = null;
      if (value !== d.value) {
        d.value = value;
        this.commands.setNode(d.nodeId, { dv: { [d.comp]: value } });
      }
      return;
    }
    // node: slide along the pre-node conic in time
    const item = scene.nodes.find((n) => n.id === d.nodeId);
    if (!item) return;
    const line = scene.lines.find((l) => l.patchKey && l.patchKey.list === item.loc.key.list && l.patchKey.index === item.loc.key.index);
    if (!line) return;
    const u = this.nearestOnLine(scene, line, px, py);
    if (u === null || !line.curve) return;
    const nu = line.curve.uToNu(u);
    let ut = utAtTrueAnomaly(item.loc.patch, nu, d.lastUt);
    const minUt = scene.snapshot.ut + 1;
    if (ut < minUt) ut = utAtTrueAnomaly(item.loc.patch, nu, d.lastUt + (item.loc.patch.conic.period ?? 0));
    if (ut < minUt || !Number.isFinite(ut)) return;
    if (Math.abs(ut - d.lastUt) > 1e-6) {
      d.lastUt = ut;
      this.commands.setNode(d.nodeId, { ut });
    }
  }

  // ------------------------------------------------------------------------------- draw list

  private buildDrawList(scene: MapScene): DrawList {
    const k = scene.proj.pxScale;
    const tm = this.metrics(k);
    const icons: IconInstance[] = [];
    const top: IconInstance[] = [];
    const texts: TextRun[] = [];
    const topTexts: TextRun[] = [];
    const s = scene.snapshot;
    const labels: { box: LabelBox; lines: string[]; color: Rgba; alpha: number }[] = [];
    const clearIcons: { x: number; y: number; r: number }[] = [];
    const visible = (x: number, y: number, front: boolean): boolean => front && scene.proj.onScreen(x, y, 24 * k);
    const addLabel = (ax: number, ay: number, clear: number, lines: string[], priority: number, color: Rgba, alpha: number): void => {
      if (lines.length === 0 || alpha < 0.05) return;
      const width = Math.max(...lines.map((l) => l.length)) * tm.advance;
      labels.push({ box: { ax, ay, clear, width, height: lines.length * tm.lineHeight, priority, x: 0, y: 0, placed: false }, lines, color, alpha });
    };
    const icon = (x: number, y: number, r: number, shape: IconId, color: Rgba, alpha: number, rot = 0, list = icons): void => {
      if (alpha < 0.01) return;
      list.push({ x, y, hx: r * k, hy: r * k, rot, shape, color, alpha });
      clearIcons.push({ x, y, r: r * k * 0.9 });
    };

    // Surface targets, once their body is big enough on screen to place them meaningfully.
    const bodyPx = new Map(scene.bodies.filter((b) => !b.ghost).map((b) => [b.bodyId, b.radiusPx / k]));
    for (const t of scene.targets) {
      if (!visible(t.x, t.y, t.front)) continue;
      const rPx = bodyPx.get(t.target.bodyId) ?? 0;
      if (rPx < TARGET_MIN_BODY_PX) continue;
      const a = (1 - t.hidden) * Math.min(1, (rPx - TARGET_MIN_BODY_PX) / 10);
      const shape = t.shape === 'pin' ? ICON.pin : t.shape === 'pad' ? ICON.pad : ICON.zone;
      const r = t.shape === 'pin' ? 9 : t.shape === 'pad' ? 6.5 : 3.5;
      icon(t.x, t.shape === 'pin' ? t.y - 9 * k : t.y, r, shape, t.color, a);
      if (rPx >= TARGET_LABEL_BODY_PX || t.target.kind === 'landing') addLabel(t.x, t.y, r * k, [t.target.name], t.target.kind === 'landing' ? 7 : 1, COLORS.textDim, a);
    }
    // Small bodies (icon + label) and ghost bodies.
    for (const b of scene.bodies) {
      if (!visible(b.x, b.y, b.front)) continue;
      const a = 1 - b.hidden;
      if (b.small) {
        icon(b.x, b.y, 6, ICON.bodyRing, b.ghost ? COLORS.ghost : COLORS.body, a);
        addLabel(b.x, b.y, 6 * k, [b.label], b.ghost ? 2 : 4, COLORS.text, a);
      } else if (b.ghost) {
        addLabel(b.x, b.y - b.radiusPx, 4 * k, [b.label], 2, COLORS.textDim, a);
      }
    }
    // Vessels.
    for (const v of scene.vessels) {
      if (!visible(v.x, v.y, v.front)) continue;
      const a = 1 - v.hidden;
      if (v.active) {
        icon(v.x, v.y, 7, ICON.vessel, COLORS.vessel, a);
        addLabel(v.x, v.y, 7 * k, [v.name], 5, COLORS.text, a);
      } else if (v.debris) {
        // Debris dots stay out of the label-avoidance set: labels may pass over them.
        if (a >= 0.01) icons.push({ x: v.x, y: v.y, hx: 3 * k, hy: 3 * k, rot: 0, shape: ICON.debris, color: COLORS.debris, alpha: a });
      } else {
        icon(v.x, v.y, 5.5, ICON.vessel, COLORS.otherVessel, a * 0.85);
        addLabel(v.x, v.y, 5.5 * k, [v.name], 1, COLORS.textDim, a);
      }
    }
    // Markers.
    scene.markers.forEach((m) => {
      if (!visible(m.x, m.y, m.front)) return;
      const a = 1 - m.hidden;
      icon(m.x, m.y, m.shape === 'surfacePoint' ? 5 : MARKER_RADIUS_PX, shapeIcon(m.shape), m.color, a);
      addLabel(m.x, m.y, MARKER_RADIUS_PX * k, m.label, m.priority, COLORS.text, a);
    });
    // Nodes (+ gizmo of the selected one).
    const sortedNodes = [...s.nodes].sort((a, b) => a.ut - b.ut);
    for (const n of scene.nodes) {
      if (!visible(n.x, n.y, n.front)) continue;
      const a = Math.max(0.35, 1 - n.hidden);
      const node = s.nodes.find((x) => x.id === n.id)!;
      const total = Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial);
      const isSel = n.id === this.selected;
      if (isSel) {
        for (const h of this.handleLayout(n, scene)) {
          const def = HANDLES.find((x) => x.name === h.name)!;
          const len = Math.hypot(h.x - n.x, h.y - n.y);
          if (len > (NODE_RADIUS_PX + HANDLE_RADIUS_PX) * k) {
            const r0 = NODE_RADIUS_PX * k;
            const r1 = len - HANDLE_RADIUS_PX * k;
            const cx = n.x + h.dx * (r0 + r1) * 0.5;
            const cy = n.y + h.dy * (r0 + r1) * 0.5;
            icons.push({ x: cx, y: cy, hx: (r1 - r0) / 2, hy: 0.75 * k, rot: Math.atan2(h.dy, h.dx), shape: ICON.bar, color: def.color, alpha: 0.55 * a });
          }
          const hovered = this.hover?.type === 'handle' && this.hover.handle.name === h.name;
          const dragging = this.drag?.type === 'handle' && this.drag.handle === h.name;
          icon(h.x, h.y, HANDLE_RADIUS_PX * (hovered || dragging ? 1.15 : 1), def.icon, def.color, a);
        }
      }
      icon(n.x, n.y, NODE_RADIUS_PX * (isSel ? 1.1 : 1), ICON.node, COLORS.node, a);
      const idx = sortedNodes.findIndex((x) => x.id === n.id);
      addLabel(n.x, n.y, (isSel ? HANDLE_DISTANCE_PX * 0.5 : NODE_RADIUS_PX) * k, [`Node ${idx + 1}  Δv ${formatDv(total)}`, formatTimeTo(node.ut - s.ut)], 9, COLORS.text, a);
    }
    // Add-maneuver preview where the pointer hovers a trajectory.
    if (this.hover?.type === 'line' && this.hoverPos && !this.drag && this.commands) {
      const line = this.hover.line;
      const p = this.pointAt(scene, line, this.hover.u);
      if (p && line.curve && line.patch) {
        icon(p.x, p.y, NODE_RADIUS_PX, ICON.addGhost, COLORS.hover, 0.9);
        const nu = line.curve.uToNu(this.hover.u);
        const ut = utAtTrueAnomaly(line.patch, nu);
        addLabel(p.x, p.y, NODE_RADIUS_PX * k, ['Add maneuver', formatTimeTo(ut - s.ut)], 10, COLORS.text, 1);
      }
    }

    // De-clutter and emit labels.
    declutter(
      labels.map((l) => l.box),
      clearIcons,
      scene.proj,
      LABEL_GAP_PX * k,
    );
    for (const l of labels) {
      if (!l.box.placed) continue;
      l.lines.forEach((line, i) => {
        texts.push({ x: l.box.x, y: l.box.y + i * tm.lineHeight, text: line, color: i === 0 ? l.color : COLORS.textDim, alpha: l.alpha });
      });
    }

    // Hover tooltip with details (markers, nodes, bodies).
    const tip = this.tooltipLines(scene);
    if (tip && this.hoverPos) {
      const width = Math.max(...tip.map((t) => t.length)) * tm.advance + 16 * k;
      const height = tip.length * tm.lineHeight + 10 * k;
      let x = this.hoverPos.x + 18 * k;
      let y = this.hoverPos.y + 18 * k;
      if (x + width > scene.proj.width) x = this.hoverPos.x - 18 * k - width;
      if (y + height > scene.proj.height) y = this.hoverPos.y - 18 * k - height;
      x = Math.round(Math.max(0, x));
      y = Math.round(Math.max(0, y));
      top.push({ x: x + width / 2, y: y + height / 2, hx: width / 2, hy: height / 2, rot: 0, shape: ICON.roundRect, color: COLORS.tooltipBg, alpha: 1 });
      tip.forEach((line, i) => topTexts.push({ x: x + 8 * k, y: y + 5 * k + i * tm.lineHeight, text: line, color: i === 0 ? COLORS.text : COLORS.textDim, alpha: 1 }));
    }
    return { scene, icons: [icons, top], texts: [texts, topTexts] };
  }

  private pointAt(scene: MapScene, line: LineRecord, u: number): { x: number; y: number } | null {
    const v = scene.verts;
    for (let i = line.start; i < line.start + line.count - 1; i++) {
      const u0 = v.u[i]!;
      const u1 = v.u[i + 1]!;
      if (u >= u0 && u <= u1) {
        const t = u1 > u0 ? (u - u0) / (u1 - u0) : 0;
        const x = v.sx[i]! + (v.sx[i + 1]! - v.sx[i]!) * t;
        const y = v.sy[i]! + (v.sy[i + 1]! - v.sy[i]!) * t;
        return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : null;
      }
    }
    return null;
  }

  private tooltipLines(scene: MapScene): string[] | null {
    const h = this.hover;
    if (!h) return null;
    const s = scene.snapshot;
    if (h.type === 'marker') return scene.markers[h.index]?.details ?? null;
    if (h.type === 'node' || h.type === 'handle') {
      const node = s.nodes.find((n) => n.id === h.node.id);
      if (!node) return null;
      const lines = [
        'Maneuver node',
        `Prograde ${formatDv(node.dv.prograde)}`,
        `Normal   ${formatDv(node.dv.normal)}`,
        `Radial   ${formatDv(node.dv.radial)}`,
        `Total    ${formatDv(Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial))}`,
        `In ${formatDuration(node.ut - s.ut)}`,
      ];
      if (h.type === 'handle') lines.splice(1, 0, `Drag: ${h.handle.name} (Shift fine, Ctrl coarse)`);
      return lines;
    }
    if (h.type === 'vessel') {
      const v = s.vessels.find((x) => x.id === h.id);
      if (!v) return null;
      const body = this.defs.bodies[v.bodyId];
      const alt = body ? Math.hypot(v.r.x, v.r.y, v.r.z) - body.radius : NaN;
      return [v.name, `${v.controllable ? 'Vessel' : 'Debris'} around ${body?.name ?? v.bodyId}`, `Altitude ${formatDistance(alt)}`];
    }
    return null;
  }
}

function shapeIcon(s: MarkerShape): IconId {
  switch (s) {
    case 'apsis':
      return ICON.apsis;
    case 'inclination':
      return ICON.inclination;
    case 'soi':
      return ICON.soi;
    case 'impact':
      return ICON.impact;
    case 'entry':
      return ICON.entry;
    case 'closest':
      return ICON.closest;
    case 'node':
      return ICON.node;
    case 'surfacePoint':
      return ICON.surfacePoint;
    case 'pin':
      return ICON.pin;
    case 'pad':
      return ICON.pad;
    case 'zone':
      return ICON.zone;
  }
}

function sameTime(a: SimSnapshot, b: SimSnapshot): boolean {
  return a.ut === b.ut && a.tick === b.tick && a.nodes.length === b.nodes.length && a.nodes.every((n, i) => {
    const m = b.nodes[i]!;
    return n.id === m.id && n.ut === m.ut && n.dv.prograde === m.dv.prograde && n.dv.normal === m.dv.normal && n.dv.radial === m.dv.radial;
  }) && a.patches.current.length === b.patches.current.length && a.patches.planned.length === b.patches.planned.length && a.readouts.targetBodyId === b.readouts.targetBodyId;
}

function sameCamera(a: CameraState, b: CameraState): boolean {
  return (
    a.positionRoot.x === b.positionRoot.x &&
    a.positionRoot.y === b.positionRoot.y &&
    a.positionRoot.z === b.positionRoot.z &&
    a.qViewToRoot.x === b.qViewToRoot.x &&
    a.qViewToRoot.y === b.qViewToRoot.y &&
    a.qViewToRoot.z === b.qViewToRoot.z &&
    a.qViewToRoot.w === b.qViewToRoot.w &&
    a.fovY === b.fovY
  );
}
