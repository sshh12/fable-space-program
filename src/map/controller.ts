/**
 * The map view's CPU half: scene caching, hit-testing, maneuver-node editing, target/focus requests,
 * describe() and the per-frame draw list. No WebGPU and no DOM here, so all of it runs in vitest; the
 * GPU renderer (gpu/) and the DOM node panel (panel.ts) are thin layers on top (mapView.ts).
 *
 * Every edit goes through PlayerCommands (addNode / setNode / removeNode / setTarget). The map never
 * predicts a trajectory: the edited plan comes back as patches in the next snapshot.
 *
 * The draw list keeps the overview readable: icons closer than CLUSTER_PX collapse into one with a count badge
 * (a body always wins, so a marker never hides the planet it orbits), every label sits on a backing plate and
 * is placed off the drawn lines where it can be (lineGrid.ts) with a leader when it had to move further out,
 * the node panel and the tooltip are placed off the trajectory, the gizmo and each other, and the selected
 * node's gizmo is always drawn at full strength.
 */
import type { PlayerCommands, PointerState } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraState } from '@/core/contracts/render';
import type { ManeuverNode, Patch, SimSnapshot } from '@/core/contracts/sim';
import type { MapElementInfo, MapUpdateResult, MapView } from '@/core/contracts/ui';
import { utAtTrueAnomaly } from './anomalyTime';
import {
  ARM_ALPHA,
  ARM_WIDTH_PX,
  BODY_CLUSTER_MAX_RADIUS_PX,
  BODY_LABEL_MAX_RADIUS_PX,
  CLICK_SLOP_PX,
  CLUSTER_PX,
  COARSE_FACTOR,
  COLORS,
  DOUBLE_CLICK_MS,
  DV_PER_PX,
  FINE_FACTOR,
  GRID_CELL_PX,
  HANDLE_DISTANCE_PX,
  HANDLE_RADIUS_PX,
  HANDLE_TRAVEL_PX,
  HIT_TOLERANCE_PX,
  LABEL_GAP_PX,
  LABEL_LINE_PX,
  LEADER_WIDTH_PX,
  MARKER_MIN_PATCH_PX,
  MARKER_RADIUS_PX,
  NODE_RADIUS_PX,
  NODE_SMALL_RADIUS_PX,
  OCCLUSION_FADE_PX,
  PANEL_GAP_PX,
  PANEL_HEIGHT_PX,
  PANEL_WIDTH_PX,
  PLATE_PAD_X_PX,
  PLATE_PAD_Y_PX,
  RAMP_DOUBLING_S,
  RAMP_MAX_RATE,
  RAMP_START_RATE,
  SURFACE_TWIN_MIN_PX,
  TARGET_LABEL_BODY_PX,
  TARGET_MIN_BODY_PX,
  TOOLTIP_OFFSET_PX,
  WHEEL_DV,
  type Rgba,
} from './constants';
import { ICON, measureText, type DrawList, type IconId, type IconInstance, type TextMetricsLike, type TextRun } from './drawList';
import { formatDistance, formatDuration, formatDv, formatTimeTo } from './format';
import { layoutGizmo } from './gizmo';
import { declutter, FAR_RING_PX, markerLabels, type BlockedRect, type LabelBox } from './labels';
import { LineGrid } from './lineGrid';
import { occlusionWeight } from './occlusion';
import { closestParam2D } from './sampler';
import { SceneBuilder, type LineRecord, type MapScene, type MarkerItem, type MarkerShape, type NodeItem } from './scene';

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
  | { type: 'marker'; d: number; id: string };

/**
 * What the pointer hovers, kept across frames by id (the draw list of the next frame is built on a new scene:
 * line records and curve objects are not carried over).
 */
type Hover =
  | { type: 'handle'; nodeId: string; handle: HandleName }
  | { type: 'node'; nodeId: string }
  | { type: 'line'; lineId: string; u: number }
  | { type: 'vessel'; id: string }
  | { type: 'body'; id: string }
  | { type: 'marker'; id: string };

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
  /** A press on a trajectory: the patch and the true anomaly under the pointer, resolved at the press. */
  | { type: 'line'; patch: Patch; nu: number; x: number; y: number; moved: number }
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
  /** Top-left corner (CSS px), placed off the trajectory, the gizmo and the body, inside the viewport. */
  x: number;
  y: number;
}

/**
 * Typed fields of the node panel: the three components, the total (rescales the vector, keeping its
 * direction), the node time as UT and as time from now.
 */
export type PanelField = 'prograde' | 'normal' | 'radial' | 'total' | 'ut' | 'timeTo';

/** A screen rectangle in CSS px (x, y = top-left corner). */
export interface ScreenRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface MapControllerOptions {
  /** Milliseconds clock (default: performance.now when available). */
  now?: () => number;
  /** Text metrics in device px (default: an approximation of the HUD face at 13 px). */
  textMetrics?: (pxScale: number) => TextMetricsLike;
}

export interface MapStats {
  lines: { id: string; kind: string; vertices: number; visibleVertices: number; capped: boolean; evaluations: number }[];
  markers: number;
  nodes: number;
  targets: number;
  icons: number;
  glyphs: number;
  /** Lines of the last build drawn from kept breakpoints / sampled afresh (scene.ts, BreakpointCache). */
  reuse: { resampled: number; fresh: number };
}

/**
 * Advances of the 13 px semibold HUD face (Bahnschrift) without an atlas (vitest); the atlas reports the real
 * ones in the browser. Digits are tabular.
 */
export const defaultTextMetrics = (pxScale: number): TextMetricsLike => ({
  lineHeight: LABEL_LINE_PX * pxScale,
  advance: (c) => pxScale * (c === 32 ? 3.2 : c === 0x202f ? 1.9 : c >= 48 && c <= 57 ? 7.2 : c >= 65 && c <= 90 ? 7.6 : c >= 97 && c <= 122 ? 6.6 : 5),
});

/** One icon-with-label candidate of the draw list (bodies, vessels, markers, unselected nodes). */
/** A cluster of icons: the members' summaries (representative first) and how many debris folded in. */
interface ClusterGroup {
  summaries: string[];
  debris: number;
  /** Draw list the group belongs to (group objects are reused). */
  stamp: number;
}

/** What a point entry stands for (hover type): body, vessel, marker, node. */
type PointKind = 'b' | 'v' | 'm' | 'n';

interface PointEntry {
  /** Hover identity: kind and the body / vessel / marker / node id. */
  kind: PointKind;
  id: string;
  x: number;
  y: number;
  /** Icon radius, device px (0 = no icon: a body large enough to be seen). */
  r: number;
  shape: IconId;
  color: Rgba;
  alpha: number;
  rot: number;
  priority: number;
  label: string[];
  labelColor: Rgba;
  labelAlpha: number;
  clear: number;
  /** Takes part in clustering. */
  cluster: boolean;
  /** Preference as a cluster's representative: a body, then the active vessel, then the label priority. */
  rank: number;
  /** A debris dot: folds into clusters silently (counted in the tooltip, not in the badge). */
  debris: boolean;
  /** One line for a cluster tooltip. */
  summary: string;
  /** Its cluster (the members' summaries for the tooltip), or null. */
  group: ClusterGroup | null;
  /** Members of its cluster besides itself (representative), or -1 when it is folded into another. */
  others: number;
}

interface LabelEntry {
  box: LabelBox;
  lines: string[];
  color: Rgba;
  alpha: number;
}

const NO_LINES: string[] = [];
/** Count badges "+1" .. "+31" (no per-frame strings). */
const BADGES = Array.from({ length: 32 }, (_, i) => `+${i}`);

/** The drawn line of patch `index` of a list (null when it is not drawn). */
function patchLine(scene: MapScene, list: 'current' | 'planned', index: number): LineRecord | null {
  for (const l of scene.lines) if (l.patchKey && l.patchKey.list === list && l.patchKey.index === index) return l;
  return null;
}

const rectsOverlap = (a: BlockedRect, b: BlockedRect): number => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));

export class MapController implements MapView {
  private active = false;
  private atIntercept = false;
  private debrisOrbits = false;
  private readonly builder: SceneBuilder;
  private scene: MapScene | null = null;
  private sceneCssSize: [number, number] = [0, 0];
  private pxScale = 1;
  private selected: string | null = null;
  private selectedMissing = 0;
  private drag: DragState | null = null;
  private pending: Pending | null = null;
  private hover: Hover | null = null;
  private hoverPos: { x: number; y: number } | null = null;
  /** A body click waiting out the double-click interval before it sets the target. */
  private pendingTarget: { bodyId: string | null; due: number } | null = null;
  private commands: PlayerCommands | null = null;
  private panelFocused = false;
  private panelHovered = false;
  /** CSS px size of the node panel (reported by the DOM panel once it is shown). */
  private panelSize: [number, number] = [PANEL_WIDTH_PX, PANEL_HEIGHT_PX];
  /** Panel placement of the last draw list (CSS px) and the candidate side it took (kept during drags). */
  private panelAt: { x: number; y: number } | null = null;
  private panelSide = -1;
  /** Screen areas other UI covers (CSS px): labels, the panel and the tooltip keep clear of them. */
  private obstacles: BlockedRect[] = [];
  /** Measured label widths (device px) by text, for the pixel scale `widthScale`. */
  private readonly widths = new Map<string, number>();
  private widthScale = 0;
  /** One-line label arrays of bodies and vessels, by text (kept: no per-frame arrays). */
  private readonly oneLine = new Map<string, string[]>();
  /** Label text of each node, kept while the node object and the time are unchanged. */
  private readonly nodeLabels = new Map<string, { node: ManeuverNode; ut: number; idx: number; text: string[] }>();
  private readonly grid = new LineGrid();
  /** Objects and arrays of the draw list, reused from list to list (no per-frame garbage). */
  private readonly pool = {
    icons: [] as IconInstance[],
    nIcons: 0,
    texts: [] as TextRun[],
    nTexts: 0,
    discs: [] as { x: number; y: number; r: number }[],
    nDiscs: 0,
    entries: [] as LabelEntry[],
    nBoxes: 0,
    points: [] as PointEntry[],
    nPoints: 0,
    pts: [] as PointEntry[],
    parent: new Int32Array(64),
    size: new Int32Array(64),
    rep: new Int32Array(64),
    px: new Float64Array(64),
    py: new Float64Array(64),
    pi: new Int32Array(64),
    groups: [] as ClusterGroup[],
    stamp: 0,
    /** icons, gizmo, top layer, plates, and layer 0 in drawing order (plates, icons, gizmo) */
    icons0: [] as IconInstance[],
    gizmo: [] as IconInstance[],
    top: [] as IconInstance[],
    plates: [] as IconInstance[],
    all: [] as IconInstance[],
    texts0: [] as TextRun[],
    topTexts: [] as TextRun[],
    labels: [] as LabelEntry[],
    boxes: [] as LabelBox[],
    clearIcons: [] as { x: number; y: number; r: number }[],
  };
  /** Hover tooltip of the last draw list (CSS px), for tests. */
  private tooltip: ScreenRect | null = null;
  private consumed = false;
  private lastDraw: DrawList | null = null;
  private readonly now: () => number;
  private readonly metrics: (pxScale: number) => TextMetricsLike;
  private readonly sortedNodes: ManeuverNode[] = [];

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
      this.pendingTarget = null;
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

  /** Draw every debris orbit (default off: debris are dots and the hovered one shows its orbit). */
  setDebrisOrbits(on: boolean): void {
    if (this.debrisOrbits !== on) {
      this.debrisOrbits = on;
      this.scene = null;
    }
  }

  get debrisOrbitsShown(): boolean {
    return this.debrisOrbits;
  }

  /** Screen areas covered by other UI (CSS px), e.g. the HUD panels: map labels, the panel and tooltips avoid them. */
  setObstacles(rects: readonly ScreenRect[]): void {
    this.obstacles = rects.map((r) => ({ x0: r.x, y0: r.y, x1: r.x + r.width, y1: r.y + r.height }));
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

    // ---- double click on a body or vessel: one focus request on that frame. Its first click never acts
    // as a target click (that one is still waiting out the double-click interval).
    if (pointer.doubleClick && !pointer.overUi) {
      this.pendingTarget = null;
      const hit = this.hitTest(scene, px, py, false, true);
      if (hit?.type === 'body') focus = { bodyId: hit.id };
      else if (hit?.type === 'vessel') focus = { vesselId: hit.id };
    }
    // ---- a single body click: the target changes once no second click followed
    const t = this.pendingTarget;
    if (t && tMs >= t.due && !pointer.released && !pointer.doubleClick && this.pending?.type !== 'body') {
      this.pendingTarget = null;
      if (snapshot.readouts.targetBodyId !== t.bodyId) commands.setTarget(t.bodyId);
    }

    // ---- hover (for consumption, tooltips and the add-maneuver preview)
    this.hoverPos = pointer.overUi ? null : { x: px, y: py };
    const hover = pointer.overUi || this.drag ? null : this.hitTest(scene, px, py, true, true, true);
    this.hover = hover ? toHover(hover) : null;
    const hoverInteractive = hover !== null && (hover.type === 'handle' || hover.type === 'node');
    this.consumed = consumedNow || this.drag !== null || hoverInteractive || this.panelFocused || this.panelHovered || this.pending?.type === 'node';
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
    for (const t of scene.targets) push('surfaceTarget', t.id, t.x, t.y, vis(t.x, t.y, t.front, t.hidden) && this.bodyRadiusCss(scene, t.target.bodyId) >= TARGET_MIN_BODY_PX);
    return out;
  }

  // ------------------------------------------------------------------------------ panel actions

  setPanelFocus(focused: boolean): void {
    this.panelFocused = focused;
  }

  setPanelHover(hovered: boolean): void {
    this.panelHovered = hovered;
  }

  /** The DOM panel reports its size (CSS px) once shown; placement and label de-cluttering use it. */
  setPanelSize(width: number, height: number): void {
    if (width > 0 && height > 0) this.panelSize = [width, height];
  }

  /** State of the node editor panel for the selected node (null: no panel). */
  panelState(): PanelState | null {
    const scene = this.scene;
    if (!this.active || !scene || !this.selected) return null;
    const s = scene.snapshot;
    const node = s.nodes.find((n) => n.id === this.selected);
    if (!node) return null;
    const item = scene.nodes.find((n) => n.id === this.selected);
    const at = this.panelAt ?? this.dockedPanel(scene);
    const period = item?.loc.patch.conic.period ?? null;
    const sorted = this.nodesByTime(s);
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
      x: at.x,
      y: at.y,
    };
  }

  /**
   * Apply a typed value from the numeric panel. Returns false when the value is not acceptable (not finite,
   * a time not in the future, a negative total) or the command was refused.
   */
  panelSetValue(field: PanelField, value: number): boolean {
    const st = this.panelState();
    const s = this.scene?.snapshot;
    if (!st || !s || !this.commands || !Number.isFinite(value)) return false;
    switch (field) {
      case 'ut':
        return value > s.ut && this.commands.setNode(st.nodeId, { ut: value }).ok;
      case 'timeTo':
        return value > 0 && this.commands.setNode(st.nodeId, { ut: s.ut + value }).ok;
      case 'total': {
        if (value < 0) return false;
        // Rescale the vector, keeping its direction; a zero burn becomes a prograde one.
        const dv = st.total > 1e-9 ? { prograde: (st.dv.prograde * value) / st.total, normal: (st.dv.normal * value) / st.total, radial: (st.dv.radial * value) / st.total } : { prograde: value, normal: 0, radial: 0 };
        return this.commands.setNode(st.nodeId, { dv }).ok;
      }
      default:
        return this.commands.setNode(st.nodeId, { dv: { [field]: value } }).ok;
    }
  }

  /** Nudge one component of the selected node by `sign` x 1 m/s x `factor` (the panel's axis-glyph buttons). */
  panelNudge(comp: DvComponent, sign: 1 | -1, factor: number): boolean {
    const st = this.panelState();
    if (!st || !this.commands) return false;
    return this.commands.setNode(st.nodeId, { dv: { [comp]: st.dv[comp] + sign * factor } }).ok;
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
      const sorted = this.nodesByTime(this.scene!.snapshot);
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

  /** The vessel whose orbit is drawn because the pointer is on it (debris orbits are otherwise hidden). */
  private highlightVessel(): string | null {
    return this.hover?.type === 'vessel' ? this.hover.id : null;
  }

  /**
   * The scene for a snapshot/camera pair: the cached one when it is what was drawn (same objects or same
   * camera pose and time), else a fresh build. `cssSize` is the display size in CSS px.
   */
  sceneFor(snapshot: SimSnapshot, camera: CameraState, cssSize: [number, number], deviceSize?: [number, number]): MapScene {
    const k = deviceSize ? deviceSize[0] / Math.max(1, cssSize[0]) : this.pxScale;
    const w = Math.round(cssSize[0] * k);
    const h = Math.round(cssSize[1] * k);
    const s = this.scene;
    const highlight = this.highlightVessel();
    if (
      s &&
      s.proj.width === w &&
      s.proj.height === h &&
      s.options.atIntercept === this.atIntercept &&
      s.options.debrisOrbits === this.debrisOrbits &&
      s.options.highlightVesselId === highlight &&
      (s.snapshot === snapshot || sameTime(s.snapshot, snapshot)) &&
      (s.camera === camera || sameCamera(s.camera, camera))
    ) {
      return s;
    }
    this.pxScale = k;
    this.scene = this.builder.build(snapshot, camera, { width: w, height: h, pxScale: k }, { atIntercept: this.atIntercept, debrisOrbits: this.debrisOrbits, highlightVesselId: highlight });
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

  /** The hover tooltip's rectangle in the last draw list (CSS px), or null when none is shown (tests). */
  get tooltipRect(): ScreenRect | null {
    return this.tooltip;
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
      reuse: { ...this.builder.reuse },
    };
  }

  // ---------------------------------------------------------------------------- interaction

  /** Handle positions of a node's gizmo (device px): the axis layout of gizmo.ts, the dragged handle moved out. */
  handleLayout(n: NodeItem, scene: MapScene): HandleLayout[] {
    const k = scene.proj.pxScale;
    const drag = this.drag?.type === 'handle' && this.drag.nodeId === n.id ? this.drag : null;
    const axes = layoutGizmo([n.axes.prograde, n.axes.normal, n.axes.radial]);
    return HANDLES.map((h) => {
      const axis = h.comp === 'prograde' ? axes[0] : h.comp === 'normal' ? axes[1] : axes[2];
      const dx = axis.dx * h.sign;
      const dy = axis.dy * h.sign;
      let dist = HANDLE_DISTANCE_PX * axis.reach;
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
    for (const n of scene.nodes) if (n.front && (n.hidden < 0.5 || n.id === this.selected)) consider({ type: 'node', d: edge(n.x, n.y, n.id === this.selected ? NODE_RADIUS_PX : NODE_SMALL_RADIUS_PX + 1), node: n });
    for (const v of scene.vessels) if (v.front && v.hidden < 0.5) consider({ type: 'vessel', d: edge(v.x, v.y, v.active ? 7 : 4), id: v.vesselId });
    if (withMarkers) {
      for (const m of scene.markers) {
        if (m.front && m.hidden < 0.5 && m.details.length > 0) consider({ type: 'marker', d: edge(m.x, m.y, MARKER_RADIUS_PX), id: m.id });
      }
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
      if (v.seg[i] !== 1) continue;
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const bx = v.sx[i + 1]!;
      const by = v.sy[i + 1]!;
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
    if (occlusionWeight(p, scene.occluders, scene.proj.focal, OCCLUSION_FADE_PX * scene.proj.pxScale) >= 0.5) return null;
    return { type: 'line', d: bestD, line, u: bestU };
  }

  /** Closest point on a line to the pointer (no tolerance), for sliding a node along its orbit. */
  private nearestOnLine(scene: MapScene, line: LineRecord, px: number, py: number): number | null {
    const v = scene.verts;
    let bestD = Infinity;
    let bestU: number | null = null;
    for (let i = line.start; i < line.start + line.count - 1; i++) {
      if (v.seg[i] !== 1) continue;
      const ax = v.sx[i]!;
      const ay = v.sy[i]!;
      const bx = v.sx[i + 1]!;
      const by = v.sy[i + 1]!;
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
      case 'line': {
        const { patch, curve } = hit.line;
        if (patch && curve) this.pending = { type: 'line', patch, nu: curve.uToNu(hit.u), x: px, y: py, moved: 0 };
        else this.pending = { type: 'empty', x: px, y: py, moved: 0 };
        return;
      }
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
        const ut = utAtTrueAnomaly(p.patch, p.nu);
        if (ut > s.ut) {
          const id = this.commands.addNode(ut);
          if (id) this.selectNode(id);
        }
        return;
      }
      case 'body': {
        // Clicking the body being orbited clears the target, any other body becomes it. Deferred by the
        // double-click interval: a double click focuses the body and must leave the target alone.
        const active = s.vessels.find((v) => v.id === s.activeVesselId);
        const bodyId = active && active.bodyId === p.id ? null : p.id;
        if (!this.pendingTarget || this.pendingTarget.bodyId !== bodyId) this.pendingTarget = { bodyId, due: tMs + DOUBLE_CLICK_MS };
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

  private nodesByTime(s: SimSnapshot): ManeuverNode[] {
    const out = this.sortedNodes;
    out.length = 0;
    for (const n of s.nodes) out.push(n);
    return out.sort((a, b) => a.ut - b.ut);
  }

  private bodyRadiusCss(scene: MapScene, bodyId: string): number {
    for (const b of scene.bodies) if (!b.ghost && b.bodyId === bodyId) return b.radiusPx / scene.proj.pxScale;
    return 0;
  }

  private cssSize(scene: MapScene): [number, number] {
    const k = scene.proj.pxScale;
    return this.sceneCssSize[0] > 0 ? this.sceneCssSize : [scene.proj.width / k, scene.proj.height / k];
  }

  /** The panel's place when its node is off screen: the top-right corner. */
  private dockedPanel(scene: MapScene): { x: number; y: number } {
    const [w] = this.cssSize(scene);
    return { x: Math.max(8, w - this.panelSize[0] - 16), y: 24 };
  }

  /**
   * Where the node panel goes (CSS px): the best of eight places around the node, just outside the gizmo,
   * clamped into the viewport. A place is penalised for every drawn line it covers (the trajectory downstream of
   * the node is what changes while the player drags), for covering a handle or the gizmo, other UI or the
   * body's centre, and for lying toward the body; changing sides costs a little, and during a drag the side is
   * kept so the panel does not jump.
   */
  private placePanel(scene: MapScene, sel: NodeItem | undefined, handles: readonly HandleLayout[], obstacles: readonly BlockedRect[]): { x: number; y: number } {
    if (!sel) {
      this.panelSide = -1;
      return this.dockedPanel(scene);
    }
    const k = scene.proj.pxScale;
    const [W, H] = this.cssSize(scene);
    const [pw, ph] = this.panelSize;
    const nx = sel.x / k;
    const ny = sel.y / k;
    const G = PANEL_GAP_PX;
    const D = G * 0.72;
    const raw: [number, number][] = [
      [nx + G, ny - ph / 2],
      [nx - G - pw, ny - ph / 2],
      [nx + D, ny + D],
      [nx + D, ny - D - ph],
      [nx - D - pw, ny + D],
      [nx - D - pw, ny - D - ph],
      [nx - pw / 2, ny + G],
      [nx - pw / 2, ny - G - ph],
    ];
    const body = scene.bodies.find((b) => !b.ghost && b.bodyId === sel.loc.patch.bodyId);
    const bx = body && body.front ? body.x / k : NaN;
    const by = body && body.front ? body.y / k : NaN;
    const toBody = Math.hypot(bx - nx, by - ny);
    let best = Infinity;
    let pick = 0;
    let at: [number, number] = [8, 8];
    const dragging = this.drag !== null && this.panelSide >= 0;
    for (let c = 0; c < raw.length; c++) {
      if (dragging && c !== this.panelSide) continue;
      const x = Math.max(8, Math.min(W - pw - 8, raw[c]![0]));
      const y = Math.max(8, Math.min(H - ph - 8, raw[c]![1]));
      const r: BlockedRect = { x0: x * k, y0: y * k, x1: (x + pw) * k, y1: (y + ph) * k };
      let score = this.grid.cost(r.x0, r.y0, r.x1, r.y1);
      // the gizmo (a disc around the node) and every handle must stay uncovered
      const cx = Math.max(x, Math.min(nx, x + pw));
      const cy = Math.max(y, Math.min(ny, y + ph));
      const inGizmo = G - 4 - Math.hypot(cx - nx, cy - ny);
      if (inGizmo > 0) score += 1e4 + 100 * inGizmo;
      for (const h of handles) {
        const hx = h.x / k;
        const hy = h.y / k;
        if (hx > x - HANDLE_RADIUS_PX - 4 && hx < x + pw + HANDLE_RADIUS_PX + 4 && hy > y - HANDLE_RADIUS_PX - 4 && hy < y + ph + HANDLE_RADIUS_PX + 4) score += 1e4;
      }
      for (const o of obstacles) score += (5000 * rectsOverlap(r, o)) / (pw * ph * k * k);
      if (toBody > 1) {
        if (bx > x && bx < x + pw && by > y && by < y + ph) score += 300;
        const ux = x + pw / 2 - nx;
        const uy = y + ph / 2 - ny;
        score += (40 * (ux * (bx - nx) + uy * (by - ny))) / (Math.hypot(ux, uy) * toBody + 1e-9);
      }
      if (c !== this.panelSide) score += 25;
      if (score < best) {
        best = score;
        pick = c;
        at = [x, y];
      }
    }
    this.panelSide = pick;
    return { x: at[0], y: at[1] };
  }

  /** Pooled icon of the draw list being built (valid until the next draw list). */
  private icon(list: IconInstance[], x: number, y: number, hx: number, hy: number, rot: number, shape: IconId, color: Rgba, alpha: number): void {
    const p = this.pool;
    let o = p.icons[p.nIcons];
    if (!o) p.icons.push((o = { x, y, hx, hy, rot, shape, color, alpha }));
    p.nIcons++;
    o.x = x;
    o.y = y;
    o.hx = hx;
    o.hy = hy;
    o.rot = rot;
    o.shape = shape;
    o.color = color;
    o.alpha = alpha;
    list.push(o);
  }

  private text(list: TextRun[], x: number, y: number, text: string, color: Rgba, alpha: number): void {
    const p = this.pool;
    let o = p.texts[p.nTexts];
    if (!o) p.texts.push((o = { x, y, text, color, alpha }));
    p.nTexts++;
    o.x = x;
    o.y = y;
    o.text = text;
    o.color = color;
    o.alpha = alpha;
    list.push(o);
  }

  /** A disc labels keep clear of (pooled). */
  private clear(x: number, y: number, r: number): void {
    const p = this.pool;
    let o = p.discs[p.nDiscs];
    if (!o) p.discs.push((o = { x, y, r }));
    p.nDiscs++;
    o.x = x;
    o.y = y;
    o.r = r;
    p.clearIcons.push(o);
  }

  /**
   * The draw list of a scene. Its arrays and the icon and text objects in them are pooled: a draw list is valid
   * until the next one is built (the renderer uploads it in the same prepare()).
   */
  private buildDrawList(scene: MapScene): DrawList {
    const proj = scene.proj;
    const k = proj.pxScale;
    const tm = this.metrics(k);
    const s = scene.snapshot;
    const pool = this.pool;
    pool.nIcons = 0;
    pool.nTexts = 0;
    pool.nDiscs = 0;
    pool.nBoxes = 0;
    const { icons0: icons, gizmo, top, plates, all, texts0: texts, topTexts } = pool;
    for (const l of [icons, gizmo, top, plates, all]) l.length = 0;
    texts.length = 0;
    topTexts.length = 0;
    const labels = pool.labels;
    labels.length = 0;
    const boxes = pool.boxes;
    boxes.length = 0;
    const clearIcons = pool.clearIcons;
    clearIcons.length = 0;
    const onScreen = (x: number, y: number, front: boolean): boolean => front && proj.onScreen(x, y, 24 * k);
    const padX = PLATE_PAD_X_PX * k;
    const padY = PLATE_PAD_Y_PX * k;
    // label widths by text (the strings come from caches, so the same ones recur frame after frame)
    if (this.widthScale !== k || this.widths.size > 1024) {
      this.widths.clear();
      this.widthScale = k;
    }
    const widthOf = (text: string): number => {
      let w = this.widths.get(text);
      if (w === undefined) this.widths.set(text, (w = measureText(tm, text)));
      return w;
    };
    const addLabel = (ax: number, ay: number, clear: number, lines: string[], priority: number, color: Rgba, alpha: number): void => {
      if (lines.length === 0 || alpha < 0.05) return;
      let width = 0;
      for (const l of lines) width = Math.max(width, widthOf(l));
      let e = pool.entries[pool.nBoxes];
      if (!e) pool.entries.push((e = { box: { ax, ay, clear, width: 0, height: 0, priority, x: 0, y: 0, placed: false, far: false }, lines, color, alpha }));
      pool.nBoxes++;
      const box = e.box;
      box.ax = ax;
      box.ay = ay;
      box.clear = clear;
      box.width = width + 2 * padX;
      box.height = lines.length * tm.lineHeight + 2 * padY;
      box.priority = priority;
      box.placed = false;
      box.far = false;
      e.lines = lines;
      e.color = color;
      e.alpha = alpha;
      boxes.push(box);
      labels.push(e);
    };
    this.grid.build(scene, GRID_CELL_PX * k);

    // ---- other UI (HUD panels) the map keeps clear of
    const rects: BlockedRect[] = this.obstacles.map((o) => ({ x0: o.x0 * k, y0: o.y0 * k, x1: o.x1 * k, y1: o.y1 * k }));

    // ---- the selected node: gizmo layout, then the node panel placed off it and off the trajectory
    const selNode = this.selected ? s.nodes.find((n) => n.id === this.selected) : undefined;
    const sel = selNode ? scene.nodes.find((n) => n.id === selNode.id) : undefined;
    const selShown = sel !== undefined && onScreen(sel.x, sel.y, sel.front);
    const handles = selShown ? this.handleLayout(sel, scene) : [];
    let panel: BlockedRect | null = null;
    this.panelAt = null;
    if (selNode) {
      const at = this.placePanel(scene, selShown ? sel : undefined, handles, rects);
      this.panelAt = at;
      panel = { x0: at.x * k, y0: at.y * k, x1: (at.x + this.panelSize[0]) * k, y1: (at.y + this.panelSize[1]) * k };
      rects.push(panel);
    }
    const underPanel = (x: number, y: number): boolean => panel !== null && x > panel.x0 && x < panel.x1 && y > panel.y0 && y < panel.y1;
    // Icons the selected node's disc covers are left out (their tooltip is unreachable there anyway).
    const selX = selShown ? sel.x : NaN;
    const selY = selShown ? sel.y : NaN;
    const selR2 = ((NODE_RADIUS_PX + 3) * k) ** 2;
    const underSelected = (x: number, y: number): boolean => selShown && (x - selX) ** 2 + (y - selY) ** 2 < selR2;

    // ---- point entries: bodies, vessels, markers, unselected nodes (pooled objects, no per-frame strings)
    const pts = pool.pts;
    pts.length = 0;
    pool.nPoints = 0;
    const point = (kind: PointKind, id: string, x: number, y: number, r: number, shape: IconId, color: Rgba, alpha: number, rank: number, summary: string): PointEntry => {
      let e = pool.points[pool.nPoints];
      if (!e) pool.points.push((e = { kind, id, x, y, r, shape, color, alpha, rot: 0, priority: 0, label: NO_LINES, labelColor: COLORS.text, labelAlpha: 0, clear: 0, cluster: true, rank, debris: false, summary, others: 0, group: null }));
      e.kind = kind;
      e.id = id;
      e.x = x;
      e.y = y;
      e.r = r;
      e.shape = shape;
      e.color = color;
      e.alpha = alpha;
      e.rot = 0;
      e.priority = 0;
      e.label = NO_LINES;
      e.labelColor = COLORS.text;
      e.labelAlpha = 0;
      e.clear = r;
      e.cluster = true;
      e.rank = rank;
      e.debris = false;
      e.summary = summary;
      e.others = 0;
      e.group = null;
      return e;
    };
    const commit = (e: PointEntry): void => {
      if (underPanel(e.x, e.y) || (e.rank < 1000 && underSelected(e.x, e.y))) return;
      pool.nPoints++;
      pts.push(e);
    };
    const oneLine = (text: string): string[] => {
      let l = this.oneLine.get(text);
      if (!l) {
        if (this.oneLine.size > 512) this.oneLine.clear();
        this.oneLine.set(text, (l = [text]));
      }
      return l;
    };
    for (const b of scene.bodies) {
      if (!onScreen(b.x, b.y, b.front)) continue;
      const a = 1 - b.hidden;
      if (a < 0.05) continue;
      const named = b.radiusPx < BODY_LABEL_MAX_RADIUS_PX * k;
      if (!b.small && !named && !b.ghost) continue;
      const r = b.small ? 6 * k : 0;
      const e = point('b', b.bodyId, b.x, b.y, r, ICON.bodyRing, b.ghost ? COLORS.ghost : COLORS.body, a, 1000, b.label);
      e.priority = b.ghost ? 2 : 9.5;
      e.label = oneLine(b.label);
      e.labelColor = b.ghost ? COLORS.textDim : COLORS.text;
      e.labelAlpha = a;
      e.clear = Math.max(r, b.radiusPx + 2 * k);
      // A body takes part while it is a speck: what sits on it then folds into it instead of hiding it.
      e.cluster = b.radiusPx < BODY_CLUSTER_MAX_RADIUS_PX * k;
      commit(e);
    }
    for (const v of scene.vessels) {
      if (!onScreen(v.x, v.y, v.front)) continue;
      const a = 1 - v.hidden;
      if (v.debris) {
        // Debris are dots (their orbit is drawn on hover); labels may pass over them.
        const e = point('v', v.vesselId, v.x, v.y, 3 * k, ICON.debris, COLORS.debris, a, 0, v.name);
        e.clear = 0;
        e.debris = true;
        commit(e);
        continue;
      }
      const r = (v.active ? 7.5 : 6) * k;
      const e = point('v', v.vesselId, v.x, v.y, r, ICON.vessel, v.active ? COLORS.vessel : COLORS.otherVessel, v.active ? a : a * 0.85, v.active ? 500 : 1, v.name);
      e.rot = v.dirX === 0 && v.dirY === 0 ? -Math.PI / 2 : Math.atan2(v.dirY, v.dirX);
      e.priority = v.active ? 5 : 1;
      e.label = oneLine(v.name);
      e.labelAlpha = e.alpha;
      commit(e);
    }
    for (const m of scene.markers) {
      if (!onScreen(m.x, m.y, m.front)) continue;
      const a = 1 - m.hidden;
      if (a < 0.01) continue;
      // Apsis and node-line markers of a patch a few pixels across say nothing and bury its body.
      if (m.kind === 'apoapsis' || m.kind === 'periapsis' || m.kind === 'ascendingNode' || m.kind === 'descendingNode') {
        const line = patchLine(scene, m.patchKey.list, m.patchKey.index);
        if (line && line.span < MARKER_MIN_PATCH_PX * k) continue;
      }
      const surface = m.kind === 'impactSurface' || m.kind === 'entrySurface';
      if (surface) {
        const parent = m.parent;
        if (parent && parent.front && parent.hidden < 0.5 && (parent.x - m.x) ** 2 + (parent.y - m.y) ** 2 < (SURFACE_TWIN_MIN_PX * k) ** 2) continue;
      }
      const r = (surface ? 5 : MARKER_RADIUS_PX) * k;
      const e = point('m', m.id, m.x, m.y, r, shapeIcon(m.shape), m.color, a, m.priority, m.label[0] ?? m.details[0] ?? m.kind);
      e.priority = m.priority;
      e.label = m.label;
      e.labelAlpha = a;
      commit(e);
    }
    const sortedNodes = this.nodesByTime(s);
    const nodeLabel = (n: NodeItem): string[] => {
      const node = n.loc.node;
      const idx = sortedNodes.findIndex((x) => x.id === n.id);
      const c = this.nodeLabels.get(node.id);
      if (c && c.node === node && c.ut === s.ut && c.idx === idx) return c.text;
      const text = [`Node ${idx + 1}  Δv ${formatDv(Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial))}`, formatTimeTo(node.ut - s.ut)];
      this.nodeLabels.set(node.id, { node, ut: s.ut, idx, text });
      if (this.nodeLabels.size > 2 * s.nodes.length + 8) this.nodeLabels.clear();
      return text;
    };
    for (const n of scene.nodes) {
      if (n.id === this.selected || !onScreen(n.x, n.y, n.front)) continue;
      const a = Math.max(0.35, 1 - n.hidden);
      const label = nodeLabel(n);
      const e = point('n', n.id, n.x, n.y, NODE_SMALL_RADIUS_PX * k, n.hidden >= 0.5 ? ICON.nodeHidden : ICON.node, COLORS.node, a, 9, label[0]!);
      e.priority = 9;
      e.label = label;
      e.labelAlpha = a;
      commit(e);
    }

    // ---- clusters: icons closer than CLUSTER_PX collapse into one (a body wins, else the highest priority)
    const n = pts.length;
    if (pool.parent.length < n) {
      pool.parent = new Int32Array(2 * n);
      pool.size = new Int32Array(2 * n);
      pool.rep = new Int32Array(2 * n);
    }
    const parent = pool.parent;
    const size = pool.size;
    const rep = pool.rep;
    for (let i = 0; i < n; i++) {
      parent[i] = i;
      size[i] = 0;
      rep[i] = i;
    }
    const find = (i: number): number => {
      while (parent[i] !== i) i = parent[i] = parent[parent[i]!]!;
      return i;
    };
    const reach = CLUSTER_PX * k;
    const reach2 = reach * reach;
    // positions of the clustering entries, packed (the pair loop runs on typed arrays)
    if (pool.px.length < n) {
      pool.px = new Float64Array(2 * n);
      pool.py = new Float64Array(2 * n);
      pool.pi = new Int32Array(2 * n);
    }
    const qx = pool.px;
    const qy = pool.py;
    const qi = pool.pi;
    let m = 0;
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      if (!p.cluster) continue;
      qx[m] = p.x;
      qy[m] = p.y;
      qi[m] = i;
      m++;
    }
    for (let a = 0; a < m; a++) {
      const ax = qx[a]!;
      const ay = qy[a]!;
      for (let b = a + 1; b < m; b++) {
        const dx = ax - qx[b]!;
        const dy = ay - qy[b]!;
        if (dx * dx + dy * dy < reach2) {
          const ra = find(qi[a]!);
          const rb = find(qi[b]!);
          if (ra !== rb) parent[rb] = ra;
        }
      }
    }
    for (let i = 0; i < n; i++) {
      if (!pts[i]!.cluster) continue;
      const r = find(i);
      size[r]!++;
      if (pts[i]!.rank > pts[rep[r]!]!.rank) rep[r] = i;
    }
    // group objects by root index, reused from list to list (a stamp marks this list's)
    const groups = pool.groups;
    while (groups.length < n) groups.push({ summaries: [], debris: 0, stamp: -1 });
    const stamp = ++pool.stamp;
    for (let i = 0; i < n; i++) {
      const p = pts[i]!;
      if (!p.cluster) continue;
      const r = find(i);
      if (size[r]! < 2) continue;
      const repI = rep[r]!;
      const g = groups[r]!;
      if (g.stamp !== stamp) {
        g.stamp = stamp;
        g.summaries.length = 0;
        g.summaries.push(pts[repI]!.summary);
        g.debris = 0;
      }
      if (i !== repI) {
        p.others = -1;
        if (p.debris) g.debris++;
        else g.summaries.push(p.summary);
      }
      p.group = g;
    }
    for (let i = 0; i < n; i++) {
      const g = groups[i]!;
      if (g.stamp === stamp && parent[i] === i) pts[rep[i]!]!.others = size[i]! - 1 - g.debris;
    }

    // ---- icons and labels of what is left; a count badge on each cluster
    for (const p of pts) {
      if (p.others < 0) continue;
      if (p.r > 0 && p.alpha >= 0.01) {
        this.icon(icons, p.x, p.y, p.r, p.r, p.rot, p.shape, p.color, p.alpha);
        if (!p.debris) this.clear(p.x, p.y, p.r * 0.95);
      }
      if (p.others > 0) {
        const text = BADGES[p.others] ?? `+${p.others}`;
        const w = widthOf(text) + 6 * k;
        const h = tm.lineHeight - 2 * k;
        const bx = p.x + Math.max(p.r, 3 * k) + 2 * k;
        const by = p.y - Math.max(p.r, 3 * k) - h + 4 * k;
        this.icon(icons, bx + w / 2, by + h / 2, w / 2, h / 2, 0, ICON.roundRect, COLORS.tooltipBg, 1);
        this.text(texts, bx + 3 * k, by - 1 * k, text, COLORS.node, 1);
        rects.push({ x0: bx, y0: by, x1: bx + w, y1: by + h });
      }
      addLabel(p.x, p.y, p.clear, p.label, p.priority, p.labelColor, p.labelAlpha);
    }

    // ---- surface targets, once their body is big enough on screen to place them meaningfully
    for (const t of scene.targets) {
      if (!onScreen(t.x, t.y, t.front) || underPanel(t.x, t.y)) continue;
      const rPx = this.bodyRadiusCss(scene, t.target.bodyId);
      if (rPx < TARGET_MIN_BODY_PX) continue;
      const a = (1 - t.hidden) * Math.min(1, (rPx - TARGET_MIN_BODY_PX) / 10);
      if (a < 0.01) continue;
      const shape = t.shape === 'pin' ? ICON.pin : t.shape === 'pad' ? ICON.pad : ICON.zone;
      const r = (t.shape === 'pin' ? 9 : t.shape === 'pad' ? 6.5 : 3.5) * k;
      const y = t.shape === 'pin' ? t.y - 9 * k : t.y;
      this.icon(icons, t.x, y, r, r, 0, shape, t.color, a);
      this.clear(t.x, y, r * 0.9);
      if (rPx >= TARGET_LABEL_BODY_PX || t.target.kind === 'landing') addLabel(t.x, t.y, r, [t.target.name], t.target.kind === 'landing' ? 7 : 1, COLORS.text, a);
    }

    // ---- the selected node: an interface control, always on top at full strength. That it lies behind a
    // body shows on the node icon alone (a dashed ring).
    if (sel && selShown && selNode) {
      for (const h of handles) {
        const def = HANDLES.find((x) => x.name === h.name)!;
        const len = Math.hypot(h.x - sel.x, h.y - sel.y);
        if (len > (NODE_RADIUS_PX + HANDLE_RADIUS_PX) * k) {
          const r0 = NODE_RADIUS_PX * k;
          const r1 = len - HANDLE_RADIUS_PX * k;
          this.icon(gizmo, sel.x + h.dx * (r0 + r1) * 0.5, sel.y + h.dy * (r0 + r1) * 0.5, (r1 - r0) / 2, (ARM_WIDTH_PX / 2) * k, Math.atan2(h.dy, h.dx), ICON.bar, def.color, ARM_ALPHA);
          // labels keep off the arm too (a chain of small discs along it)
          for (let d = r0 + 6 * k; d < r1; d += 8 * k) this.clear(sel.x + h.dx * d, sel.y + h.dy * d, 3 * k);
        }
      }
      for (const h of handles) {
        const def = HANDLES.find((x) => x.name === h.name)!;
        const hot = (this.hover?.type === 'handle' && this.hover.handle === h.name) || (this.drag?.type === 'handle' && this.drag.handle === h.name);
        this.icon(gizmo, h.x, h.y, HANDLE_RADIUS_PX * (hot ? 1.15 : 1) * k, HANDLE_RADIUS_PX * (hot ? 1.15 : 1) * k, 0, def.icon, def.color, 1);
        this.clear(h.x, h.y, HANDLE_RADIUS_PX * k);
      }
      const r = NODE_RADIUS_PX * 1.1 * k;
      this.icon(gizmo, sel.x, sel.y, r, r, 0, sel.hidden >= 0.5 ? ICON.nodeHidden : ICON.node, COLORS.node, 1);
      this.clear(sel.x, sel.y, r);
      addLabel(sel.x, sel.y, r, nodeLabel(sel), 9.5, COLORS.text, 1);
    }

    // ---- add-maneuver preview where the pointer hovers a trajectory
    const hv = this.hover;
    if (hv?.type === 'line' && this.hoverPos && !this.drag && this.commands) {
      const line = scene.lines.find((l) => l.id === hv.lineId);
      const p = line ? this.pointAt(scene, line, hv.u) : null;
      if (line && p && line.curve && line.patch) {
        const r = NODE_RADIUS_PX * k;
        this.icon(gizmo, p.x, p.y, r, r, 0, ICON.addGhost, COLORS.hover, 0.9);
        this.clear(p.x, p.y, r);
        const ut = utAtTrueAnomaly(line.patch, line.curve.uToNu(hv.u));
        addLabel(p.x, p.y, r, ['Add maneuver', formatTimeTo(ut - s.ut)], 10, COLORS.text, 1);
      }
    }

    // ---- hover tooltip: in the quadrant around the pointer that covers neither the panel, nor a handle, nor
    // other UI; labels then keep clear of it (none is cut through)
    this.tooltip = null;
    const tip = this.tooltipLines(scene);
    if (tip && this.hoverPos) {
      let tw = 0;
      for (const t of tip) tw = Math.max(tw, measureText(tm, t));
      const width = tw + 16 * k;
      const height = tip.length * tm.lineHeight + 10 * k;
      const off = TOOLTIP_OFFSET_PX * k;
      const hx = this.hoverPos.x;
      const hy = this.hoverPos.y;
      let best = Infinity;
      let tx = 0;
      let ty = 0;
      // The four quadrants beside the pointer, then further out (past a gizmo the pointer is inside of).
      for (const reach of [off, off + 40 * k, off + 80 * k]) {
        for (const [qx, qy] of [
          [hx + reach, hy + off],
          [hx - reach - width, hy + off],
          [hx + reach, hy - off - height],
          [hx - reach - width, hy - off - height],
          [hx + off, hy + reach],
          [hx - off - width, hy - reach - height],
        ] as const) {
          const x = Math.round(Math.max(0, Math.min(proj.width - width, qx)));
          const y = Math.round(Math.max(0, Math.min(proj.height - height, qy)));
          const r: BlockedRect = { x0: x, y0: y, x1: x + width, y1: y + height };
          // clamping that moved the box over the pointer counts against it
          let cover = hx > x - 4 * k && hx < x + width + 4 * k && hy > y - 4 * k && hy < y + height + 4 * k ? 1e6 : 0;
          for (const o of rects) cover += rectsOverlap(r, o);
          for (const h of handles) cover += rectsOverlap(r, { x0: h.x - 12 * k, y0: h.y - 12 * k, x1: h.x + 12 * k, y1: h.y + 12 * k });
          if (cover < best) {
            best = cover;
            tx = x;
            ty = y;
          }
        }
        if (best === 0) break;
      }
      this.tooltip = { x: tx / k, y: ty / k, width: width / k, height: height / k };
      this.icon(top, tx + width / 2, ty + height / 2, width / 2, height / 2, 0, ICON.roundRect, COLORS.tooltipBg, 1);
      tip.forEach((line, i) => this.text(topTexts, tx + 8 * k, ty + 5 * k + i * tm.lineHeight, line, i === 0 ? COLORS.text : COLORS.textDim, 1));
      rects.push({ x0: tx, y0: ty, x1: tx + width, y1: ty + height });
    }

    // ---- de-clutter: labels keep clear of icons, of each other and of every blocked rectangle, and off the lines
    declutter(boxes, clearIcons, proj, LABEL_GAP_PX * k, rects, (x0, y0, x1, y1) => this.grid.cost(x0, y0, x1, y1), FAR_RING_PX * k);
    for (const l of labels) {
      const b = l.box;
      if (!b.placed) continue;
      this.icon(plates, b.x + b.width / 2, b.y + b.height / 2, b.width / 2, b.height / 2, 0, ICON.plate, COLORS.plate, l.alpha);
      if (b.far) {
        // Leader from the anchor's edge to the nearest point of the plate.
        const nx = Math.max(b.x, Math.min(b.ax, b.x + b.width));
        const ny = Math.max(b.y, Math.min(b.ay, b.y + b.height));
        const dx = nx - b.ax;
        const dy = ny - b.ay;
        const d = Math.hypot(dx, dy);
        const r0 = b.clear + 2 * k;
        if (d > r0 + 2 * k) {
          const ux = dx / d;
          const uy = dy / d;
          this.icon(plates, b.ax + ux * (r0 + d) * 0.5, b.ay + uy * (r0 + d) * 0.5, (d - r0) / 2, (LEADER_WIDTH_PX / 2) * k, Math.atan2(uy, ux), ICON.bar, COLORS.leader, l.alpha);
        }
      }
      for (let i = 0; i < l.lines.length; i++) {
        this.text(texts, b.x + padX, b.y + padY + i * tm.lineHeight, l.lines[i]!, i === 0 ? l.color : COLORS.textDim, l.alpha);
      }
    }
    for (const o of plates) all.push(o);
    for (const o of icons) all.push(o);
    for (const o of gizmo) all.push(o);
    return { scene, icons: [all, top], texts: [texts, topTexts] };
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

  /**
   * Tooltip of what the pointer is on. None for the selected node and its handles (the panel shows those
   * values); a list of the members when the element is part of an icon cluster.
   */
  private tooltipLines(scene: MapScene): string[] | null {
    const h = this.hover;
    if (!h) return null;
    const s = scene.snapshot;
    if ((h.type === 'node' || h.type === 'handle') && h.nodeId === this.selected) return null;
    const kind: PointKind | null = h.type === 'marker' ? 'm' : h.type === 'node' ? 'n' : h.type === 'vessel' ? 'v' : h.type === 'body' ? 'b' : null;
    const id = h.type === 'node' || h.type === 'handle' ? h.nodeId : h.type === 'line' ? '' : h.id;
    let cluster: ClusterGroup | null = null;
    if (kind) for (const p of this.pool.pts) if (p.kind === kind && p.id === id) cluster = p.group;
    if (cluster) {
      const lines = [`${cluster.summaries.length + cluster.debris} objects here`, ...cluster.summaries];
      if (cluster.debris > 0) lines.push(`${cluster.debris} debris`);
      return lines;
    }
    if (h.type === 'marker') return scene.markers.find((m) => m.id === h.id)?.details ?? null;
    if (h.type === 'node' || h.type === 'handle') {
      const node = s.nodes.find((n) => n.id === h.nodeId);
      if (!node) return null;
      return [
        'Maneuver node',
        `Prograde ${formatDv(node.dv.prograde)}`,
        `Normal ${formatDv(node.dv.normal)}`,
        `Radial ${formatDv(node.dv.radial)}`,
        `Total ${formatDv(Math.hypot(node.dv.prograde, node.dv.normal, node.dv.radial))}`,
        `In ${formatDuration(node.ut - s.ut)}`,
        'Click to edit',
      ];
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

function toHover(h: Hit): Hover {
  switch (h.type) {
    case 'handle':
      return { type: 'handle', nodeId: h.node.id, handle: h.handle.name };
    case 'node':
      return { type: 'node', nodeId: h.node.id };
    case 'line':
      return { type: 'line', lineId: h.line.id, u: h.u };
    case 'vessel':
      return { type: 'vessel', id: h.id };
    case 'body':
      return { type: 'body', id: h.id };
    case 'marker':
      return { type: 'marker', id: h.id };
  }
}

function shapeIcon(s: MarkerShape): IconId {
  switch (s) {
    case 'apoapsis':
      return ICON.apoapsis;
    case 'periapsis':
      return ICON.periapsis;
    case 'inclination':
      return ICON.inclination;
    case 'soiEnter':
      return ICON.soiEnter;
    case 'soiExit':
      return ICON.soiExit;
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
