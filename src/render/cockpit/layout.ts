/**
 * Cockpit layout definitions: data/defs/visuals/cockpits/<id>.json, keyed by VehicleDef.cockpit and found
 * with listSections(defs, 'visuals/cockpits/'). A layout holds INTERIOR-ONLY parameters: the capsule's
 * mould line, wall thickness, windows, hatch and seat eye points come from the shared mould-line section it
 * names, never from here.
 *
 * Coordinates: panel positions are in metres in the frame of the surface they sit on (console: x across
 * the cabin = part +X, u = up the panel; wall panels: u = tangential arc length, v = along the generator).
 */
import type { CapsuleMouldLineDef, DefLibrary } from '@/core/contracts/defs';
import type { MfdPage } from '@/core/contracts/ui';
import { DefError, getSection, listSections } from '@/core/defs/loader';

export type MaterialDetail = 'none' | 'paint' | 'brushed' | 'quilt' | 'weave' | 'upholstery' | 'webbing' | 'velcro' | 'ribbed' | 'knurl' | 'rubber' | 'cast';

export interface CockpitMaterialDef {
  shading: 'standard' | 'cloth';
  /** Linear-sRGB base colour. */
  albedo: [number, number, number];
  roughness: number;
  metallic?: number;
  anisotropy?: number;
  clearcoat?: number;
  /**
   * Surface detail and its strength 0..1: a baked detail texture (public/assets/cockpit, tools/cockpit)
   * and, for quilt / ribbed / knurl, a procedural pattern that follows the geometry.
   */
  detail?: MaterialDetail;
  detailStrength?: number;
  /** Cloth only: thin-surface translucency. */
  translucency?: number;
  /** Edge wear: share of the chamfered edges worn through (0..1) and what shows there (linear colour, metallic). */
  wear?: { amount: number; albedo: [number, number, number]; metallic: number };
  /** Grime in occluded corners and cavities (0..1) and the part-to-part variation of tone and gloss (0..1). */
  grime?: number;
  variation?: number;
}

/** Detail texture layer (by name in public/assets/cockpit/detail.json) and procedural pattern of each kind. */
export const DETAIL_KINDS: Record<Exclude<MaterialDetail, 'none'>, { layer: string; pattern: 0 | 1 | 2 | 3 | 4 }> = {
  paint: { layer: 'paint', pattern: 0 },
  brushed: { layer: 'brushed', pattern: 0 },
  quilt: { layer: 'nomex', pattern: 1 },
  weave: { layer: 'fabric', pattern: 0 },
  upholstery: { layer: 'fabric', pattern: 4 },
  webbing: { layer: 'webbing', pattern: 0 },
  velcro: { layer: 'velcro', pattern: 0 },
  ribbed: { layer: 'rubber', pattern: 2 },
  knurl: { layer: 'cast', pattern: 3 },
  rubber: { layer: 'rubber', pattern: 0 },
  cast: { layer: 'cast', pattern: 0 },
};

/** Snapshot facts that lamps, switches and readouts can show (src/render/cockpit/instruments.ts). */
export type InstrumentBinding =
  | 'sas'
  | 'rcs'
  | 'gear'
  | 'lights'
  | 'fine'
  | 'engineArmed'
  | 'engineFiring'
  | 'chuteArmed'
  | 'drogueDeployed'
  | 'mainDeployed'
  | 'masterAlarm'
  | 'overheat'
  | 'gLimit'
  | 'stagingLocked'
  | 'abortArmed'
  | 'liftUp'
  | 'plasma'
  | 'warp'
  | 'terrainLoading'
  | 'heatShield'
  | 'lowRcs'
  | 'landed'
  | 'navballMode'
  | 'sasMode'
  | 'none';

export type ReadoutBinding = 'met' | 'eventTimer' | 'gLoad' | 'deltaV' | 'altitudeKm' | 'speed';

export interface LampDef {
  label: string;
  binding: InstrumentBinding;
  /** Lens colour when lit (linear sRGB, normalised) and its luminance in cd/m^2. */
  color: [number, number, number];
  luminance?: number;
  /** Flash at this rate (Hz) while lit (master alarm). */
  flashHz?: number;
}

export interface SwitchDef {
  label: string;
  binding: InstrumentBinding;
  kind: 'toggle' | 'guarded' | 'momentary';
  /** Position labels top / bottom. */
  up?: string;
  down?: string;
  /** Position (0 = up, 1 = down) of a switch whose binding is 'none'. */
  fixed?: number;
}

export interface RotaryDef {
  label: string;
  binding: InstrumentBinding;
  positions: string[];
  /** Fixed position when the binding is 'none'. */
  fixed?: number;
}

export interface ReadoutDef {
  label: string;
  binding: ReadoutBinding;
  digits: number;
  /** Positions after which a colon / point is drawn (digit indices). */
  colons?: number[];
  points?: number[];
  color: [number, number, number];
  luminance: number;
}

export interface ConsoleSectionDef {
  id: string;
  /** Extent across the cabin (part x, m) and up the panel (u, m) in the console plane. */
  x: [number, number];
  u: [number, number];
  /** Extra distance of this section from the eyes (m, + = farther) and tilt about x (deg, + = top toward the crew). */
  offset?: number;
  tiltDeg?: number;
  /** Body depth behind the face for this section (default: the console's depth). */
  depth?: number;
}

export interface ConsoleDef {
  /** Distance of the console face from the eye points along the look direction, m. */
  distance: number;
  /** Depth of the console body behind the face, m. */
  depth: number;
  sections: ConsoleSectionDef[];
  displays: { x: number; u: number; activeWidth: number; activeHeight: number; border: number; keys: number }[];
  navball: { x: number; u: number; ballRadius: number; housing: number };
  annunciator: { x: number; u: number; columns: number; cell: [number, number]; lamps: LampDef[] };
  masterAlarms: { x: number; u: number; size: number }[];
  switchRows: { x: number; u: number; pitch: number; switches: SwitchDef[] }[];
  rotaries: { x: number; u: number; radius: number; selector: RotaryDef }[];
  readouts: { x: number; u: number; digitHeight: number; readout: ReadoutDef }[];
  lamps: { x: number; u: number; size: number; lamp: LampDef }[];
}

export interface WallPanelDef {
  id: string;
  /** Centre azimuth (deg) and y on the inner wall, size along u (tangential) and v (generator), m. */
  azDeg: number;
  y: number;
  width: number;
  height: number;
  /** Rows of circuit breakers (labels per row) and of switches. */
  breakers: { v: number; pitch: number; labels: string[] }[];
  switchRows: { v: number; pitch: number; switches: SwitchDef[] }[];
  title: string;
}

export interface SeatLayoutDef {
  /** Thigh direction from the back plane toward the look direction (deg; 90 = perpendicular to the back). */
  thighDeg: number;
  /** Interior knee angle (deg). */
  kneeDeg: number;
  /** Lateral shift of the knees toward the cabin centre (m) for the outboard couches. */
  kneeShift: number;
  /** Hand controllers on this couch: rotation on the right, translation and throttle on the left. */
  controllers: boolean;
  /** Half width of the back pan and of the leg pans (m), narrower for the outboard couches. */
  halfWidth: number;
  legHalfWidth: number;
  /** Length of the shin pan, m. */
  shinLength: number;
  /** Lateral position of the left / right armrests from the seat centre, m. */
  armrests: [number, number];
}

export interface CouchesDef {
  backOffset: number;
  cushion: number;
  pan: number;
  headrest: { width: number; height: number; depth: number };
  hipU: number;
  thighLength: number;
  seats: Record<string, SeatLayoutDef>;
}

export interface ShellDef {
  ringFramesY: number[];
  stringers: number;
  frame: { depth: number; width: number };
  stringer: { depth: number; width: number };
  closeoutTopY: number;
  blanket: { thickness: number; quilt: number; inset: number };
  openingMargin: number;
}

export interface WindowsDef {
  bezelWidth: number;
  bezelDepth: number;
  /** Pane depths into the cabin from the inner wall surface, m (outer pane first). */
  panes: number[];
  /** Per-pane transmittance colour at normal incidence (absorption tint) and refractive index. */
  tint: [number, number, number];
  ior: number;
  /** Dust / scratch density 0..1 on the cabin-side pane. */
  dust: number;
  scratches: number;
  /** Shade extension 0 (stowed) .. 1 (drawn) per window id. */
  shades: Record<string, number>;
  /**
   * Display cover glass: reflectance relative to bare glass (anti-reflection coating) and the roughness of
   * its anti-glare (etched) surface, which spreads reflected sources into a soft lobe.
   */
  coverGlass: { reflectance: number; roughness: number };
}

export interface HatchDef {
  thickness: number;
  latches: number;
  handleSide: number;
  dockingHatchY: number;
}

export interface FloodDef {
  /** Fixture centre: azimuth (deg) and y on the inner wall; aimed at a cabin point. */
  azDeg: number;
  y: number;
  length: number;
  aim: [number, number, number];
  /** Luminous flux (lm) and correlated colour temperature (K). */
  lumens: number;
  cct: number;
}

export interface LightingDef {
  floods: FloodDef[];
  /** Display luminance at full brightness (cd/m^2) and the night floor of the auto dimming (fraction). */
  displayLuminance: number;
  displayMinBrightness: number;
  /** Ambient illuminance (lux) at which the displays reach full brightness. */
  displayFullAmbient: number;
  /** Integral lighting of the attitude indicator (luminance of its white at night, cd/m^2). */
  fdaiLighting: number;
  /** Back-lit legends of the panels (cd/m^2) and their colour. */
  legendLuminance: number;
  legendColor: [number, number, number];
  /** Mean diffuse reflectance of the cabin and its inner surface area (m^2) for the inter-reflection term. */
  cabinAlbedo: number;
  cabinArea: number;
  /** Shock-layer radiance seen through a window at plasmaIntensity 1 (cd/m^2) and its colour. */
  plasmaLuminance: number;
  plasmaColor: [number, number, number];
}

export interface ExperienceDef {
  /** g-induced tunnel vision: onset and full effect (g), response time constant (s). */
  tunnel: { onsetG: number; fullG: number; tau: number; maxDarken: number };
  /**
   * Structure-borne vibration: displacement amplitude per (m/s^2) of thrust acceleration and per kPa of q;
   * the q term is multiplied by 1 + peak exp(-((M - mach) / width)^2) (transonic buffet).
   */
  vibration: { perAccel: number; perKpa: number; maxAmplitude: number; frequencies: number[]; buffet: { peak: number; mach: number; width: number } };
}

/** Thresholds of the caution and warning lamps (fractions of the snapshot's own limits, g). */
export interface AlarmsDef {
  /** Hottest part above this fraction of its temperature limit: OVER HEAT and the master alarm. */
  overheatFraction: number;
  /** Sustained g above this (g), or the g dose above this fraction of its limit: G LIMIT and the master alarm. */
  gLimit: number;
  gDoseFraction: number;
  /** Plasma intensity above which the comm blackout lamp lights. */
  plasmaBlackout: number;
  /** Ablator and RCS propellant fractions below which their lamps light. */
  ablatorLow: number;
  rcsLow: number;
}

export interface DisplaysDef {
  width: number;
  height: number;
  rateHz: number;
  pages: MfdPage[];
  /** Screen pixels per display texel at which the RGB stripe structure starts and is fully resolved. */
  pixelStructure: [number, number];
  /**
   * Share of the screen width over which the MFD painter lays its page tabs (left-aligned, one per page):
   * the bezel's page keys sit above them. Mirrors the tab row of src/ui/mfd/mfdPainter.ts.
   */
  tabSpan: number;
}

/** Occlusion bake (occlusion.ts) and the cabin's own sun shadow map (sunmap.ts). */
export interface LightTransportDef {
  /** Longest flat-face edge at full detail (m), so baked occlusion has vertices to live on. */
  maxEdge: number;
  /** Ambient occlusion: rays per vertex and the distance beyond which geometry does not occlude (m). */
  aoRays: number;
  aoDistance: number;
  /** Rays per vertex towards each window, display and flood light. */
  sourceRays: number;
  /** Cabin sun shadow map: resolution (texels) and the extra radius around the interior's bounds (m). */
  sunMapSize: number;
  sunMapMargin: number;
  /** Cabin probe (probe.ts): texels per side of a cube face. */
  probeSize: number;
}

export interface CockpitLayoutDef {
  /** Section key of the capsule mould line this interior is built inside. */
  mouldLine: string;
  materials: Record<string, CockpitMaterialDef>;
  shell: ShellDef;
  couches: CouchesDef;
  console: ConsoleDef;
  wallPanels: WallPanelDef[];
  windows: WindowsDef;
  hatch: HatchDef;
  lighting: LightingDef;
  transport: LightTransportDef;
  alarms: AlarmsDef;
  experience: ExperienceDef;
  displays: DisplaysDef;
  /** Projected size (px) of the capsule below which the outside LOD gives way to the far LOD. */
  farLodPixels: number;
}

const MFD_PAGE_NAMES: readonly MfdPage[] = ['flight', 'orbit', 'systems', 'staging', 'entry', 'landing'];

/** All cockpit layouts in the library, keyed by layout id (the file name). */
export function cockpitLayouts(defs: DefLibrary): Record<string, CockpitLayoutDef> {
  return listSections<CockpitLayoutDef>(defs, 'visuals/cockpits/');
}

/** One layout, validated, with the mould line it names. Throws a DefError naming the file. */
export function loadCockpitLayout(defs: DefLibrary, id: string): { layout: CockpitLayoutDef; mould: CapsuleMouldLineDef } {
  const file = `visuals/cockpits/${id}.json`;
  const layout = cockpitLayouts(defs)[id];
  if (!layout) throw new DefError(file, `no cockpit layout "${id}" (looked for ${file})`);
  const mould = getSection<CapsuleMouldLineDef>(defs, layout.mouldLine);
  validateLayout(layout, mould, file);
  return { layout, mould };
}

export function validateLayout(l: CockpitLayoutDef, mould: CapsuleMouldLineDef, file: string): void {
  const fail = (msg: string): never => {
    throw new DefError(file, msg);
  };
  const mats = l.materials;
  for (const [name, m] of Object.entries(mats)) {
    if (m.albedo.length !== 3 || m.albedo.some((c) => !(c >= 0 && c <= 1))) fail(`material "${name}": albedo must be three values in 0..1`);
    if (!(m.roughness >= 0 && m.roughness <= 1)) fail(`material "${name}": roughness must be in 0..1`);
    if (m.detail && m.detail !== 'none' && !DETAIL_KINDS[m.detail]) fail(`material "${name}": unknown detail "${m.detail}"`);
    if (m.wear && !(m.wear.amount >= 0 && m.wear.amount <= 1 && m.wear.albedo.length === 3)) fail(`material "${name}": wear.amount in 0..1 and a wear.albedo colour`);
  }
  if (Object.keys(mats).length > 48) fail('at most 48 materials');
  for (const seat of mould.seats) if (!l.couches.seats[seat.id]) fail(`couches.seats has no entry for seat "${seat.id}" of the mould line`);
  for (const id of Object.keys(l.couches.seats)) if (!mould.seats.some((s) => s.id === id)) fail(`couches.seats."${id}" is not a seat of the mould line`);
  for (const id of Object.keys(l.windows.shades)) if (!mould.windows.some((w) => w.id === id)) fail(`windows.shades."${id}" is not a window of the mould line`);
  if (l.displays.pages.length !== l.console.displays.length) fail('displays.pages needs one default page per console display');
  for (const p of l.displays.pages) if (!MFD_PAGE_NAMES.includes(p)) fail(`displays.pages: unknown MFD page "${p}"`);
  if (l.windows.panes.length < 1 || l.windows.panes.length > 3) fail('windows.panes: one to three panes');
  if (!(l.lighting.cabinAlbedo > 0 && l.lighting.cabinAlbedo < 0.95)) fail('lighting.cabinAlbedo must be in (0, 0.95)');
  if (l.experience.vibration.frequencies.length === 0) fail('experience.vibration.frequencies: at least one frequency');
  if (mould.windows.length + 1 > MAX_WINDOWS) fail(`at most ${MAX_WINDOWS - 1} windows besides the hatch window (occlusion slots)`);
  if (l.console.displays.length > MAX_DISPLAYS) fail(`at most ${MAX_DISPLAYS} displays (occlusion slots)`);
  const t = l.transport;
  if (!(t.maxEdge > 0.005) || !(t.aoRays >= 4 && t.aoRays <= 256) || !(t.sourceRays >= 1 && t.sourceRays <= 64) || !(t.aoDistance > 0)) fail('transport: maxEdge > 5 mm, aoRays 4..256, sourceRays 1..64, aoDistance > 0');
  if (!Number.isInteger(Math.log2(t.sunMapSize)) || t.sunMapSize < 256 || t.sunMapSize > 4096) fail('transport.sunMapSize: a power of two in 256..4096');
  if (!Number.isInteger(Math.log2(t.probeSize)) || t.probeSize < 32 || t.probeSize > 512) fail('transport.probeSize: a power of two in 32..512');
  const cg = l.windows.coverGlass;
  if (!(cg.reflectance >= 0 && cg.reflectance <= 1) || !(cg.roughness >= 0 && cg.roughness <= 1)) fail('windows.coverGlass: reflectance and roughness in 0..1');
  const [p0, p1] = l.displays.pixelStructure;
  if (!(p0 > 0 && p1 > p0)) fail('displays.pixelStructure: two increasing positive values');
  if (!(l.displays.tabSpan > 0.2 && l.displays.tabSpan <= 1)) fail('displays.tabSpan: the share of the screen width the page tabs span, in (0.2, 1]');
}

/** Occlusion slots per vertex (occlusion.ts): windows including the hatch window, and displays. */
export const MAX_WINDOWS = 8;
export const MAX_DISPLAYS = 4;
/** Flood lights with a baked visibility of their own. */
export const MAX_FLOODS = 8;
