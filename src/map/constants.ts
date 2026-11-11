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
 * Bound for the faint reference lines that are not predicted patches (other vessels' orbits, the hovered
 * debris' orbit): 1.5 px wide at 45 % alpha, where under a pixel of chord error is invisible. Recovery-zone
 * rings, drawn bright on the body, use CHORD_TOLERANCE_PX.
 */
export const FAINT_CHORD_TOLERANCE_PX = 0.9;
/**
 * Debris orbits drawn all at once (the debris filter, setDebrisOrbits): 1.5 px wide at 20 % alpha. The hovered
 * debris' orbit is drawn as a vessel orbit (0.9 px, 45 % alpha).
 */
export const DEBRIS_CHORD_TOLERANCE_PX = 1.5;
/** Hard cap on the vertices of one sampled conic. */
export const MAX_POINTS_PER_CURVE = 2048;
/**
 * Lines are cut in float64 where they pass behind the eye: a vertex counts as in front when its depth exceeds
 * this fraction of its distance (and twice the near plane), and a segment that crosses that depth gets a new
 * end exactly there. Float32 rounding of a camera-relative position is 6e-8 of its distance, so every vertex
 * the GPU receives lies safely in front of the eye (a clip on the GPU at the 5 cm near plane cannot be
 * resolved in float32 for points 1e8 m away and threw mirrored lines across the screen).
 */
export const CLIP_DEPTH_REL = 1e-5;

/** Trajectory line width and the analytic anti-aliasing ramp. */
export const LINE_WIDTH_PX = 2.5;
export const FAINT_LINE_WIDTH_PX = 1.5;
/** Zone outlines lying on a body. */
export const ZONE_LINE_WIDTH_PX = 2;
/** Dark casing on both sides of every line (keeps it legible over a lit planet), width and peak alpha. */
export const CASING_PX = 1.25;
export const CASING_ALPHA = 0.6;
/** Soft fade where a line or marker passes behind a body limb (kept short: an occluded line ends at the limb). */
export const OCCLUSION_FADE_PX = 1.5;
/**
 * Lines lying on a body surface (zone outlines) are tested against the sphere shrunk by their chords' depth
 * below the surface plus this fraction of the radius (float32 rounding of the vertices).
 */
export const SURFACE_SLACK_MARGIN = 1e-4;
/** Dashes of patches downstream of a maneuver node: period and lit length (phase anchored at the node). */
export const DASH_PERIOD_PX = 20;
export const DASH_ON_PX = 12;

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

/**
 * Node panel: nominal size (the DOM panel reports its real size once shown) and the clearance between the node
 * and the panel's nearest edge (outside the gizmo: handle distance + handle radius + margin).
 */
export const PANEL_WIDTH_PX = 236;
export const PANEL_HEIGHT_PX = 286;
export const PANEL_GAP_PX = 86;
/** Hover tooltip offset from the pointer. */
export const TOOLTIP_OFFSET_PX = 18;

/** Icons drawn for bodies and vessels whose projected diameter is below this. */
export const SMALL_OBJECT_PX = 6;
/** Bodies are named while their projected radius is below this (above it the planet itself is recognisable). */
export const BODY_LABEL_MAX_RADIUS_PX = 40;
/** Surface targets appear once their body's projected radius reaches this; their labels from the second value. */
export const TARGET_MIN_BODY_PX = 18;
export const TARGET_LABEL_BODY_PX = 70;

/**
 * Clutter control. Icons closer than CLUSTER_PX collapse into one (a body wins, else the highest priority) with
 * a count badge and a combined tooltip; apsis and node-line markers are left out on a patch whose screen span is
 * under MARKER_MIN_PATCH_PX; the ground twin of an impact / entry marker is left out within SURFACE_TWIN_MIN_PX
 * of it; unselected nodes are drawn small so a node at periapsis does not cover a small planet.
 */
export const CLUSTER_PX = 11;
/** A body takes part in clustering while its projected radius is below this (a speck, not a disc). */
export const BODY_CLUSTER_MAX_RADIUS_PX = 6;
export const MARKER_MIN_PATCH_PX = 40;
export const SURFACE_TWIN_MIN_PX = 12;
export const NODE_SMALL_RADIUS_PX = 5.5;
/** Line occupancy grid cell for label and panel placement. */
export const GRID_CELL_PX = 10;
/** Label plate padding (horizontal, vertical) and leader line width. */
export const PLATE_PAD_X_PX = 4;
export const PLATE_PAD_Y_PX = 1;
export const LEADER_WIDTH_PX = 1;

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

/** Gizmo geometry (the axis layout is in gizmo.ts). Arms: width and alpha. */
export const HANDLE_DISTANCE_PX = 58;
export const HANDLE_RADIUS_PX = 9;
export const ARM_WIDTH_PX = 2;
export const ARM_ALPHA = 0.85;
export const NODE_RADIUS_PX = 8;
export const MARKER_RADIUS_PX = 6.5;

/**
 * Fade of trajectories with time ahead: alpha falls toward FADE_FLOOR while the colour moves FADE_TINT of the
 * way toward white, so a far-future patch keeps its hue (a lighter, quieter tint) instead of turning muddy.
 */
export const FADE_FLOOR = 0.5;
export const FADE_TINT = 0.45;
/** Current trajectory after the first maneuver node is drawn at this fraction of its alpha. */
export const AFTER_NODE_DIM = 0.45;

/** Label text (HUD type family, theme.ts). */
export const FONT_PX = 13;
export const LABEL_LINE_PX = 15;
export const LABEL_GAP_PX = 8;

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
  text: hex('#eef4fb'),
  textDim: hex('#aab6c8'),
  halo: hex('#05070b', 0.85),
  /** Backing plate of every label: masks the lines behind the text. */
  plate: hex('#070b11', 0.7),
  leader: hex('#aab6c8', 0.55),
  tooltipBg: hex('#0a0f16', 0.96),
  tooltipEdge: hex('#3a4a60', 0.95),
  hover: hex('#ffffff', 0.9),
} as const;
