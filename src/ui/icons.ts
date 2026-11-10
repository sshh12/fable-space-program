/**
 * Vector icons shared by the HUD (inline SVG), the navball marker atlas and the MFD pages (Canvas 2D through
 * Path2D). One source of truth: every icon is stroke geometry in a 24 x 24 box centred on (12, 12), drawn
 * with round caps; `fill` lists sub-paths that are filled instead (dots).
 */

export interface IconDef {
  /** Stroked path data (SVG syntax). */
  stroke: string;
  /** Filled path data (dots, arrow heads). */
  fill?: string;
  /** Stroke width in icon units (default 2). */
  width?: number;
}

const dot = (x: number, y: number, r = 1.6): string => `M${x - r},${y}a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
const circle = (r: number): string => `M${12 - r},12a${r},${r} 0 1,0 ${2 * r},0a${r},${r} 0 1,0 ${-2 * r},0`;
const ray = (angleDeg: number, r0: number, r1: number): string => {
  const a = (angleDeg * Math.PI) / 180;
  const c = Math.cos(a);
  const s = Math.sin(a);
  const f = (v: number): string => v.toFixed(3);
  return `M${f(12 + c * r0)},${f(12 + s * r0)}L${f(12 + c * r1)},${f(12 + s * r1)}`;
};

/** Navball markers (also the SAS mode buttons). Angles are screen angles: 0 = right, 90 = down. */
export const MARKER_ICONS = {
  prograde: { stroke: `${circle(5)}${ray(-90, 5, 10.5)}${ray(180, 5, 10.5)}${ray(0, 5, 10.5)}`, fill: dot(12, 12, 1.5) },
  retrograde: {
    stroke: `${circle(5)}${ray(45, 0, 5)}${ray(135, 0, 5)}${ray(225, 0, 5)}${ray(315, 0, 5)}${ray(-90, 5, 10.5)}${ray(30, 5, 10.5)}${ray(150, 5, 10.5)}`,
  },
  normal: { stroke: 'M12,4.2L19.2,16.6H4.8Z', fill: dot(12, 12.6, 1.5) },
  antinormal: { stroke: 'M12,19.8L19.2,7.4H4.8Z M12,19.8V23 M19.2,7.4L21.9,5.8 M4.8,7.4L2.1,5.8', fill: dot(12, 11.4, 1.5) },
  radialOut: { stroke: `${circle(4.2)}${ray(45, 6.2, 10.5)}${ray(135, 6.2, 10.5)}${ray(225, 6.2, 10.5)}${ray(315, 6.2, 10.5)}`, fill: dot(12, 12, 1.4) },
  radialIn: { stroke: `${circle(7)}${ray(45, 2.6, 6.2)}${ray(135, 2.6, 6.2)}${ray(225, 2.6, 6.2)}${ray(315, 2.6, 6.2)}` },
  maneuver: { stroke: `${circle(4.6)}${ray(-90, 6.5, 10.8)}${ray(30, 6.5, 10.8)}${ray(150, 6.5, 10.8)}M8.6,3.6L12,1.3L15.4,3.6`, fill: dot(12, 12, 1.4), width: 2.2 },
  target: { stroke: circle(6.5), fill: `${dot(12, 12, 1.5)}${dot(16.6, 7.4)}${dot(7.4, 7.4)}${dot(16.6, 16.6)}${dot(7.4, 16.6)}` },
  antiTarget: { stroke: `${circle(6.5)}${ray(45, 0, 6.5)}${ray(135, 0, 6.5)}${ray(225, 0, 6.5)}${ray(315, 0, 6.5)}`, fill: `${dot(19.4, 12)}${dot(4.6, 12)}${dot(12, 4.6)}${dot(12, 19.4)}` },
  liftVector: { stroke: `${circle(3.2)}M12,8.8V2.6M8.4,6.2L12,2.4L15.6,6.2M7.2,16.6H16.8`, width: 2.1 },
  stability: { stroke: `${circle(5.6)}${ray(0, 7.5, 11)}${ray(180, 7.5, 11)}${ray(-90, 7.5, 11)}${ray(90, 7.5, 11)}M9.2,12H14.8` },
} satisfies Record<string, IconDef>;

export type MarkerIconName = keyof typeof MARKER_ICONS;

/** Marker colours (sRGB hex) shared by the navball, the SAS buttons and the MFD. */
export const MARKER_COLORS: Record<MarkerIconName, string> = {
  prograde: '#d8f25a',
  retrograde: '#d8f25a',
  normal: '#d77cff',
  antinormal: '#d77cff',
  radialOut: '#46d6ff',
  radialIn: '#46d6ff',
  maneuver: '#4f8dff',
  target: '#ff5bd6',
  antiTarget: '#ff5bd6',
  liftVector: '#7dffa8',
  stability: '#e8eef6',
};

/** The fixed vessel reticle (orange wings), 48 x 24 box centred on (24, 12). */
export const RETICLE_ICON: IconDef = { stroke: 'M2,12H15.5L24,19L32.5,12H46 M24,4V8', fill: dot(24, 12, 1.9), width: 2.6 };
export const RETICLE_COLOR = '#ffa53a';

/** Stage and action icons; StageInfo.icon / actionKinds strings are mapped by `stageIconFor`. */
export const STAGE_ICONS = {
  engine: { stroke: 'M9,3H15V7.5H9Z M9.6,7.5L6.8,16.5H17.2L14.4,7.5 M9.5,19L8.6,21.5 M12,19V22 M14.5,19L15.4,21.5' },
  decoupler: { stroke: 'M4,8.5H20 M4,15.5H20 M12,6.5V2.8 M9.8,4.8L12,2.6L14.2,4.8 M12,17.5V21.2 M9.8,19.2L12,21.4L14.2,19.2' },
  parachute: { stroke: 'M3,11.5C3,6 7,3 12,3C17,3 21,6 21,11.5 M3,11.5L12,20 M21,11.5L12,20 M9,11.5L12,20 M15,11.5L12,20 M3,11.5C5,10.4 7,10.4 9,11.5C11,10.4 13,10.4 15,11.5C17,10.4 19,10.4 21,11.5', width: 1.7 },
  fairing: { stroke: 'M12,2.5C8,5 7,9 7,13V21 M12,2.5C16,5 17,9 17,13V21 M7,13L3.5,15 M17,13L20.5,15' },
  les: { stroke: 'M12,2V13 M9.5,5L12,2L14.5,5 M8,13H16L14.5,17H9.5Z M10,17L8.5,21 M14,17L15.5,21' },
  clamps: { stroke: 'M6,3V21 M18,3V21 M6,8H10 M18,8H14 M6,16H10 M18,16H14' },
  legs: { stroke: 'M8,5H16V12H8Z M8,12L4,20 M16,12L20,20 M2.5,20H5.5 M18.5,20H21.5 M12,12V17' },
  rcs: { stroke: 'M9,9H15V15H9Z M12,9V4.5 M12,15V19.5 M9,12H4.5 M15,12H19.5', width: 1.9 },
  separation: { stroke: 'M12,3L14.5,7V15H9.5V7Z M9.5,15L8,19 M14.5,15L16,19 M12,16V21' },
  shutdown: { stroke: `M9,3H15V7.5H9Z M9.6,7.5L6.8,16.5H17.2L14.4,7.5 M4,4L20,20` },
  cutChute: { stroke: 'M3,11.5C3,6 7,3 12,3C17,3 21,6 21,11.5 M3,11.5L12,20 M21,11.5L12,20 M15,15L21,21 M21,15L15,21', width: 1.7 },
  generic: { stroke: 'M12,3L19.8,7.5V16.5L12,21L4.2,16.5V7.5Z', fill: dot(12, 12, 2) },
} satisfies Record<string, IconDef>;

export type StageIconName = keyof typeof STAGE_ICONS;

const STAGE_ALIASES: Record<string, StageIconName> = {
  engine: 'engine',
  engines: 'engine',
  igniteengines: 'engine',
  ignite: 'engine',
  launch: 'engine',
  decoupler: 'decoupler',
  decouple: 'decoupler',
  separation: 'decoupler',
  parachute: 'parachute',
  chute: 'parachute',
  chutes: 'parachute',
  drogue: 'parachute',
  main: 'parachute',
  deployparachute: 'parachute',
  fairing: 'fairing',
  jettisonfairing: 'fairing',
  les: 'les',
  tower: 'les',
  jettisonles: 'les',
  abort: 'les',
  clamps: 'clamps',
  clamp: 'clamps',
  releaseclamps: 'clamps',
  launchclamp: 'clamps',
  legs: 'legs',
  gear: 'legs',
  deploylegs: 'legs',
  rcs: 'rcs',
  enablercs: 'rcs',
  motor: 'separation',
  motors: 'separation',
  ullage: 'separation',
  retro: 'separation',
  fireseparationmotors: 'separation',
  shutdown: 'shutdown',
  shutdownengines: 'shutdown',
  cutparachute: 'cutChute',
};

/** Icon for a StageInfo.icon or action-kind string (case and separators ignored); unknown names get `generic`. */
export function stageIconFor(name: string): StageIconName {
  return STAGE_ALIASES[name.toLowerCase().replace(/[^a-z]/g, '')] ?? 'generic';
}

/** Padlock (keyboard capture indicator). */
export const LOCK_ICON: IconDef = { stroke: 'M6.5,11H17.5V20.5H6.5Z M8.5,11V8A3.5,3.5 0 0,1 15.5,8V11', fill: dot(12, 15.5, 1.5) };
export const UNLOCK_ICON: IconDef = { stroke: 'M6.5,11H17.5V20.5H6.5Z M8.5,11V8A3.5,3.5 0 0,1 15.2,6.6', fill: dot(12, 15.5, 1.5) };

const SVG_NS = 'http://www.w3.org/2000/svg';

/** Inline SVG element for an icon (currentColor strokes unless `color` is given). */
export function svgIcon(icon: IconDef, opts: { size?: string; color?: string; viewBox?: string; className?: string } = {}): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', opts.viewBox ?? '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  if (opts.className) svg.setAttribute('class', opts.className);
  if (opts.size) {
    svg.style.width = opts.size;
    svg.style.height = opts.size;
  }
  const color = opts.color ?? 'currentColor';
  const s = document.createElementNS(SVG_NS, 'path');
  s.setAttribute('d', icon.stroke);
  s.setAttribute('fill', 'none');
  s.setAttribute('stroke', color);
  s.setAttribute('stroke-width', String(icon.width ?? 2));
  s.setAttribute('stroke-linecap', 'round');
  s.setAttribute('stroke-linejoin', 'round');
  svg.appendChild(s);
  if (icon.fill) {
    const f = document.createElementNS(SVG_NS, 'path');
    f.setAttribute('d', icon.fill);
    f.setAttribute('fill', color);
    svg.appendChild(f);
  }
  return svg;
}

type Ctx2D = CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D;

/**
 * Draw an icon with Canvas 2D centred at (x, y), `size` px for the 24-unit box, with an optional dark outline
 * for contrast over bright backgrounds.
 */
export function drawIcon(ctx: Ctx2D, icon: IconDef, x: number, y: number, size: number, color: string, outline: string | null = 'rgba(6,10,16,0.85)', box: [number, number] = [24, 24]): void {
  const k = size / box[1];
  ctx.save();
  ctx.translate(x - (box[0] / 2) * k, y - (box[1] / 2) * k);
  ctx.scale(k, k);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const stroke = new Path2D(icon.stroke);
  const fill = icon.fill ? new Path2D(icon.fill) : null;
  const w = icon.width ?? 2;
  if (outline) {
    ctx.strokeStyle = outline;
    ctx.lineWidth = w + 2.4;
    ctx.stroke(stroke);
    if (fill) {
      ctx.lineWidth = 2.4;
      ctx.stroke(fill);
    }
  }
  ctx.strokeStyle = color;
  ctx.lineWidth = w;
  ctx.stroke(stroke);
  if (fill) {
    ctx.fillStyle = color;
    ctx.fill(fill);
  }
  ctx.restore();
}
