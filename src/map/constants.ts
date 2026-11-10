/**
 * Tunables of the map view. Pixel values are CSS pixels unless the name says "Device"; the scene builder
 * multiplies them by the viewport's pxScale (device pixels per CSS pixel).
 */

/** Maximum screen-space distance (device px) between a sampled polyline and the exact conic. */
export const CHORD_ERROR_PX = 0.3;
/**
 * The sampler refines until the chord error of every piece is below this. The error is computed exactly
 * (projected rational-Bezier form of the conic arc, see sampler.ts), so the actual error approaches this
 * value; the 0.01 px margin covers float64 rounding of the projection.
 */
export const CHORD_TOLERANCE_PX = 0.29;
/**
 * Bound for the faint reference lines that are not predicted patches (debris and other vessels' orbits,
 * recovery-zone circles): 1.5 px wide at 20-45 % alpha, where under a pixel of chord error is invisible.
 */
export const FAINT_CHORD_TOLERANCE_PX = 0.9;
/** Hard cap on the vertices of one sampled conic. */
export const MAX_POINTS_PER_CURVE = 2048;

/** Trajectory line width and the analytic anti-aliasing ramp. */
export const LINE_WIDTH_PX = 2.5;
export const FAINT_LINE_WIDTH_PX = 1.5;
/** Soft fade where a line or marker passes behind a body limb. */
export const OCCLUSION_FADE_PX = 6;
/** Dashes of patches downstream of a maneuver node: period and lit length. */
export const DASH_PERIOD_PX = 14;
export const DASH_ON_PX = 8;

/** Hit-testing tolerance for every interactive element. */
export const HIT_TOLERANCE_PX = 10;
/** A press that moves less than this before release is a click, not a drag. */
export const CLICK_SLOP_PX = 4;
/**
 * A click on a body sets the target only after this long without a second click (ms): the first click of a
 * double click (focus) must not retarget. 500 ms is the Windows default double-click time and the longest
 * interval browsers use for dblclick.
 */
export const DOUBLE_CLICK_MS = 500;

/** Node panel: nominal size (the DOM panel reports its real size once shown) and offset from the node. */
export const PANEL_WIDTH_PX = 232;
export const PANEL_HEIGHT_PX = 262;
export const PANEL_OFFSET_X_PX = 92;
export const PANEL_OFFSET_Y_PX = 28;

/** Icons drawn for bodies and vessels whose projected diameter is below this. */
export const SMALL_OBJECT_PX = 6;
/** Surface targets appear once their body's projected radius reaches this; their labels from the second value. */
export const TARGET_MIN_BODY_PX = 18;
export const TARGET_LABEL_BODY_PX = 70;

/** Maneuver-node editing: 1 m/s per 10 px of drag along a handle, Shift x0.1, Ctrl x10. */
export const DV_PER_PX = 0.1;
export const FINE_FACTOR = 0.1;
export const COARSE_FACTOR = 10;
/** Wheel step over a handle, m/s (before modifiers). */
export const WHEEL_DV = 0.1;
/** Handle travel along its axis; beyond it the handle sits at its end stop and the rate ramp runs. */
export const HANDLE_TRAVEL_PX = 120;
/** Rate ramp at the end stop: starts at this many m/s per second and doubles every RAMP_DOUBLING_S. */
export const RAMP_START_RATE = 2;
export const RAMP_DOUBLING_S = 0.75;
export const RAMP_MAX_RATE = 500;

/** Gizmo geometry. */
export const HANDLE_DISTANCE_PX = 58;
export const HANDLE_MIN_FORESHORTEN = 0.38;
export const HANDLE_RADIUS_PX = 9;
export const NODE_RADIUS_PX = 8;
export const MARKER_RADIUS_PX = 6.5;

/** Fade of trajectories with time ahead: alpha falls toward FADE_FLOOR with this time constant (times the reference span). */
export const FADE_FLOOR = 0.32;
/** Current trajectory after the first maneuver node is drawn at this fraction of its alpha. */
export const AFTER_NODE_DIM = 0.45;

/** Label text. */
export const FONT_PX = 12;
export const LABEL_LINE_PX = 15;
export const LABEL_GAP_PX = 9;

/** Colours (display-referred sRGB, 0..1) and alphas. */
export type Rgba = readonly [number, number, number, number];

const hex = (h: string, a = 1): Rgba => {
  const n = parseInt(h.slice(1), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
};

export const COLORS = {
  current: [hex('#4fc3f7'), hex('#ffb74d'), hex('#ba8cf2'), hex('#81c784')] as readonly Rgba[],
  planned: [hex('#ffd166'), hex('#ff8a65'), hex('#f48fb1'), hex('#c5e1a5')] as readonly Rgba[],
  vesselOrbit: hex('#b8c4d6', 0.45),
  debrisOrbit: hex('#7d879a', 0.2),
  bodyOrbit: hex('#9aa6e0', 0.55),
  soi: hex('#9aa6e0', 0.28),
  ghost: hex('#9aa6e0', 0.6),
  recovery: hex('#5fd38d', 0.9),
  landing: hex('#ff6b6b'),
  site: hex('#ffd54f'),
  apsis: hex('#8fd3ff'),
  node: hex('#38d9e8'),
  nodeLine: hex('#38d9e8', 0.6),
  inclination: hex('#d59cf5'),
  soiMarker: hex('#ffd54f'),
  impact: hex('#ff5252'),
  entry: hex('#ff9e40'),
  closest: hex('#69f0ae'),
  prograde: hex('#d7e85a'),
  normal: hex('#e35cf5'),
  radial: hex('#47c8ff'),
  vessel: hex('#ffffff'),
  otherVessel: hex('#c9d3e0'),
  debris: hex('#8a94a6', 0.85),
  body: hex('#c9d3e0'),
  text: hex('#e8eef7'),
  textDim: hex('#aab6c8'),
  halo: hex('#05070b', 0.85),
  tooltipBg: hex('#0d131c', 0.9),
  tooltipEdge: hex('#3a4a60', 0.95),
  hover: hex('#ffffff', 0.9),
} as const;
