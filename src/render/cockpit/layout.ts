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

export type MaterialDetail = 'none' | 'paint' | 'brushed' | 'quilt' | 'weave' | 'webbing' | 'velcro' | 'ribbed' | 'knurl' | 'rubber' | 'cast' | 'foil';

export interface CockpitMaterialDef {
  shading: 'standard' | 'cloth';
  /** Linear-sRGB base colour. */
  albedo: [number, number, number];
  roughness: number;
  metallic?: number;
  anisotropy?: number;
  clearcoat?: number;
  /** Procedural surface detail evaluated in the interior shader, and its strength 0..1. */
  detail?: MaterialDetail;
  detailStrength?: number;
  /** Cloth only: thin-surface translucency. */
  translucency?: number;
}

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
  /** Structure-borne vibration: displacement amplitude per (m/s^2) of thrust acceleration and per kPa of q. */
  vibration: { perAccel: number; perKpa: number; maxAmplitude: number; frequencies: number[] };
}

export interface DisplaysDef {
  width: number;
  height: number;
  rateHz: number;
  pages: MfdPage[];
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
}
