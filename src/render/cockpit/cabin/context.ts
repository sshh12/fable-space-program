/**
 * Shared state of one cockpit build: the mesh builder, material indices, the registry of animated / lit
 * controls, label-atlas allocations and the metadata the feature needs at run time (display quads, the
 * navball instrument, windows, floodlights).
 */
import type { CapsuleMouldLineDef } from '@/core/contracts/defs';
import { v3, type Vec3 } from '@/core/math';
import type { CockpitLayoutDef, InstrumentBinding, LampDef, ReadoutDef } from '../layout';
import { MeshBuilder, type Attr, type Frame, local } from '../mesh';
import { mouldOf, type Mould } from '../mould';

/** Detail level of a build pass: 0 = inside (full), 1 = outside near, 2 = outside far. */
export type Detail = 0 | 1 | 2;

export type ControlKind = 'toggle' | 'guard' | 'rotary' | 'lamp' | 'digit' | 'rhc' | 'thc' | 'throttle' | 'flood';

export interface ControlMeta {
  /** 1-based index written to the vertices (0 = static geometry). */
  index: number;
  key: string;
  kind: ControlKind;
  /** Rotation pivot and rest axis (part frame). */
  pivot: Vec3;
  axis: Vec3;
  binding: InstrumentBinding;
  /** Angles (rad) for the positions of a switch / rotary (index = position). */
  angles?: number[];
  lamp?: LampDef;
  readout?: ReadoutDef;
  /** Digit position within its readout (0 = leftmost). */
  digit?: number;
  /** Seat of a hand controller. */
  seat?: string;
  /** Floodlight index (kind 'flood'). */
  flood?: number;
  /** Fixed position for controls whose binding is 'none'. */
  fixed?: number;
}

export interface DisplayMeta {
  index: number;
  /** Centre of the active area and its axes (x right, y up on the image, n out of the screen). */
  frame: Frame;
  width: number;
  height: number;
}

export interface PaneMeta {
  /** Planar pane: centre, axes and outline (points in the part frame, counter-clockwise seen from inside). */
  frame: Frame;
  outline: Vec3[];
  /** Which side faces the cabin: frame.n points INTO the cabin. */
  depth: number;
}

export interface WindowMeta {
  id: string;
  kind: 'window' | 'hatchWindow';
  /** Inner opening outline (on the inner wall) and its centre / inward normal. */
  outline: Vec3[];
  centre: Vec3;
  inward: Vec3;
  area: number;
  panes: PaneMeta[];
  aperture: ApertureMeta;
}

/**
 * The opening as the sun sees it: a straight prism of the shared rounded rectangle (half sizes hw, hh,
 * corner radius rc; a circle when rc = hw = hh) along the inward normal, from the outer mould line to the
 * inner edge of the bezel. `centre` is the outer end's centre (on the mean plane of the curved outer
 * outline), t and g its axes (tangential, along the generator), `innerDepth` the prism's length.
 */
export interface ApertureMeta {
  centre: Vec3;
  inward: Vec3;
  t: Vec3;
  g: Vec3;
  hw: number;
  hh: number;
  rc: number;
  innerDepth: number;
}

export interface CouchMeta {
  seat: string;
  /** Centre of the head cushion surface and of the back cushion's plane, the plane's normal (toward the occupant). */
  headrest: Vec3;
  backCentre: Vec3;
  backNormal: Vec3;
}

export interface FloodMeta {
  /** Emitting strip from p0 to p1, facing `n`; aim point; luminous flux and colour. */
  p0: Vec3;
  p1: Vec3;
  n: Vec3;
  lumens: number;
  color: [number, number, number];
  control: number;
}

export interface LabelAlloc {
  text: string;
  /** Atlas rectangle in pixels and the style the painter uses. */
  px: [number, number, number, number];
  style: LabelStyle;
}

export interface LabelStyle {
  weight: number;
  align: 'center' | 'left';
  /** Box around the text (stencilled placard frame). */
  box?: boolean;
  /** Stripe pattern instead of text (hazard placards). */
  stripes?: boolean;
}

/** Label palette (index -> linear colour) shared with the shader. */
export const LABEL_COLORS: [number, number, number][] = [
  [0.82, 0.83, 0.82], // 0 white legend on dark panels
  [0.02, 0.02, 0.02], // 1 black on light panels
  [0.72, 0.52, 0.02], // 2 caution yellow
  [0.55, 0.04, 0.03], // 3 warning red
  [0.3, 0.32, 0.33], // 4 grey (secondary)
  [0.04, 0.3, 0.12], // 5 green
];

export const ATLAS_WIDTH = 2048;
export const ATLAS_HEIGHT = 2048;
/** Atlas pixels per metre of label height. */
export const ATLAS_PX_PER_M = 4200;

export class CabinContext {
  readonly mould: Mould;
  readonly b = new MeshBuilder();
  readonly matIndex: Record<string, number> = {};
  readonly controls: ControlMeta[] = [];
  private readonly controlByKey = new Map<string, ControlMeta>();
  readonly displays: DisplayMeta[] = [];
  navball: { frame: Frame; radius: number } | null = null;
  readonly windows: WindowMeta[] = [];
  readonly floods: FloodMeta[] = [];
  readonly couches: CouchMeta[] = [];
  readonly labels: LabelAlloc[] = [];
  private readonly labelByKey = new Map<string, LabelAlloc>();
  private shelfX = 0;
  private shelfY = 0;
  private shelfH = 0;
  detail: Detail = 0;

  constructor(
    readonly layout: CockpitLayoutDef,
    readonly def: CapsuleMouldLineDef,
  ) {
    this.mould = mouldOf(def);
    Object.keys(layout.materials).forEach((name, i) => (this.matIndex[name] = i));
  }

  /** Attributes for a named material (throws on an unknown name so a typo cannot silently fall back). */
  m(name: string, extra: Omit<Attr, 'mat'> = {}): Attr {
    const i = this.matIndex[name];
    if (i === undefined) throw new Error(`cockpit layout: material "${name}" is not defined`);
    return { mat: i, ...extra };
  }

  /** Register (or find, across LOD passes) a control by stable key. */
  control(key: string, make: () => Omit<ControlMeta, 'index' | 'key'>): ControlMeta {
    const found = this.controlByKey.get(key);
    if (found) return found;
    const c: ControlMeta = { ...make(), index: this.controls.length + 1, key };
    this.controls.push(c);
    this.controlByKey.set(key, c);
    return c;
  }

  /** Allocate (or reuse) a label in the atlas; returns its normalised atlas rectangle. */
  label(text: string, heightM: number, widthM: number, style: Partial<LabelStyle> = {}): [number, number, number, number] {
    const st: LabelStyle = { weight: style.weight ?? 600, align: style.align ?? 'center', box: style.box, stripes: style.stripes };
    const hPx = Math.max(12, Math.round(heightM * ATLAS_PX_PER_M));
    const wPx = Math.max(12, Math.round(widthM * ATLAS_PX_PER_M));
    const key = `${text}|${hPx}|${wPx}|${st.weight}|${st.align}|${st.box ? 1 : 0}|${st.stripes ? 1 : 0}`;
    let a = this.labelByKey.get(key);
    if (!a) {
      const pad = 2;
      if (this.shelfX + wPx + pad > ATLAS_WIDTH) {
        this.shelfX = 0;
        this.shelfY += this.shelfH + pad;
        this.shelfH = 0;
      }
      if (this.shelfY + hPx > ATLAS_HEIGHT) throw new Error(`cockpit label atlas is full (label "${text}")`);
      a = { text, px: [this.shelfX, this.shelfY, wPx, hPx], style: st };
      this.shelfX += wPx + pad;
      this.shelfH = Math.max(this.shelfH, hPx);
      this.labels.push(a);
      this.labelByKey.set(key, a);
    }
    const [x, y, w, h] = a.px;
    return [x / ATLAS_WIDTH, y / ATLAS_HEIGHT, (x + w) / ATLAS_WIDTH, (y + h) / ATLAS_HEIGHT];
  }

  /**
   * A label quad on a face: centred at (a, b) of frame f, lifted `lift` off the face, size w x h (m).
   * `color` indexes LABEL_COLORS; `backlit` legends glow with the panel lighting; `mat` is the face material
   * underneath (the label shows that material where the atlas has no ink). The text reads left to right
   * and upright along +y seen from the side +n points to, whatever the handedness of f.
   */
  labelQuad(f: Frame, a: number, b: number, w: number, h: number, text: string, mat: string, opts: { color?: number; backlit?: boolean; lift?: number; style?: Partial<LabelStyle> } = {}): void {
    if (this.detail > 0) return;
    const rect = this.label(text, h, w, opts.style);
    const lift = opts.lift ?? 0.0004;
    const attr = this.m(mat, { ink: opts.color ?? 0, flags: opts.backlit ? FLAG_BACKLIT : 0, label: { rect, origin: [-w / 2, -h / 2], size: [w, h] } });
    const c = local(f, a, b, lift);
    const xr = readingRight(f);
    const at = (su: number, sv: number): Vec3 => v3.add(c, v3.add(v3.scale(xr, su), v3.scale(f.y, sv)));
    const bld = this.b;
    bld.part();
    const i0 = bld.vertex(at(-w / 2, -h / 2), f.n, xr, [-w / 2, -h / 2], attr);
    const i1 = bld.vertex(at(w / 2, -h / 2), f.n, xr, [w / 2, -h / 2], attr);
    const i2 = bld.vertex(at(w / 2, h / 2), f.n, xr, [w / 2, h / 2], attr);
    const i3 = bld.vertex(at(-w / 2, h / 2), f.n, xr, [-w / 2, h / 2], attr);
    bld.quad(i0, i1, i2, i3);
  }

  /**
   * A label printed on an annulus (r0..r1) around (0, 0) of frame f: the atlas image covers the square of
   * side 2 r1, so dial scales can be printed around an opening without covering it. Reads like labelQuad.
   */
  labelRing(f: Frame, r0: number, r1: number, text: string, mat: string, opts: { color?: number; backlit?: boolean; lift?: number } = {}): void {
    if (this.detail > 0) return;
    const rect = this.label(text, 2 * r1, 2 * r1);
    const attr = this.m(mat, { ink: opts.color ?? 0, flags: opts.backlit ? FLAG_BACKLIT : 0, label: { rect, origin: [-r1, -r1], size: [2 * r1, 2 * r1] } });
    const lift = opts.lift ?? 0.0004;
    const xr = readingRight(f);
    const c = local(f, 0, 0, lift);
    const n = 64;
    this.b.part();
    const base = this.b.vertexCount;
    for (let i = 0; i <= n; i++) {
      const a = (i / n) * 2 * Math.PI;
      for (const r of [r0, r1]) {
        const x = Math.cos(a) * r;
        const y = Math.sin(a) * r;
        this.b.vertex(v3.add(c, v3.add(v3.scale(xr, x), v3.scale(f.y, y))), f.n, xr, [x, y], attr);
      }
    }
    for (let i = 0; i < n; i++) this.b.quad(base + i * 2, base + i * 2 + 2, base + i * 2 + 3, base + i * 2 + 1);
  }
}

/** The direction text runs in on face f seen from +n: f.x for a right-handed frame, -f.x for a left-handed one. */
export function readingRight(f: Frame): Vec3 {
  return v3.dot(v3.cross(f.x, f.y), f.n) >= 0 ? f.x : v3.neg(f.x);
}

/** Vertex flag: the label's ink glows with the panel lighting. */
export const FLAG_BACKLIT = 4;
/** Vertex flag: emissive surface driven by its control (lamp lens, LED strip, lit segment). */
export const FLAG_EMISSIVE = 8;
/** Vertex flag: seven-segment segment (lit when bit `sub` of the digit mask is set). */
export const FLAG_SEGMENT = 16;
/**
 * Vertex flag: part of the cabin's enclosure (pressure wall, floor, tunnel, window bezels): the light that
 * enters through a window is bounded by the window's analytic aperture, so these surfaces stay out of the
 * cabin's sun map (sunmap.ts), which holds the interior's occluders only.
 */
export const FLAG_ENCLOSURE = 32;

export interface SeatFrame {
  id: string;
  eye: Vec3;
  /** Look direction, head-up direction and right (= look x up). */
  L: Vec3;
  U: Vec3;
  R: Vec3;
}

export function seatFrames(def: CapsuleMouldLineDef): SeatFrame[] {
  return def.seats.map((s) => {
    const L = v3.normalize(v3.fromTuple(s.lookDir));
    const U = v3.normalize(v3.reject(v3.fromTuple(s.upDir), L));
    return { id: s.id, eye: v3.fromTuple(s.pos), L, U, R: v3.cross(L, U) };
  });
}

/** Point in a seat frame: a along R, b along U, c along L. */
export const seatPoint = (s: SeatFrame, a: number, b: number, c: number): Vec3 => v3.add(s.eye, v3.add(v3.add(v3.scale(s.R, a), v3.scale(s.U, b)), v3.scale(s.L, c)));
