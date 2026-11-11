/**
 * CPU-side description of one overlay frame, consumed by the GPU renderer (gpu/overlayRenderer.ts).
 * Lines reference the scene's float64 vertex arrays; icons and text are positioned in device pixels.
 */
import type { Rgba } from './constants';
import type { MapScene } from './scene';

/** Icon shapes understood by the icon shader (gpu/shaders.ts keeps the same numbering). */
export const ICON = {
  apoapsis: 0,
  inclination: 1,
  soiEnter: 2,
  impact: 3,
  entry: 4,
  closest: 5,
  node: 6,
  surfacePoint: 7,
  pin: 8,
  pad: 9,
  zone: 10,
  vessel: 11,
  debris: 12,
  bodyRing: 13,
  prograde: 14,
  retrograde: 15,
  normal: 16,
  antinormal: 17,
  radialOut: 18,
  radialIn: 19,
  bar: 20,
  roundRect: 21,
  addGhost: 22,
  plate: 23,
  periapsis: 24,
  soiExit: 25,
  nodeHidden: 26,
  /** A body drawn as an icon: a disc in its own colour, shaded from its sun (aux = the sun's view-space z). */
  bodyDisc: 27,
  /** Ring around the hovered object. */
  hoverRing: 28,
} as const;
export type IconId = (typeof ICON)[keyof typeof ICON];

export interface IconInstance {
  /** Centre and half extents in device px; rotation (radians, screen space, clockwise because y is down). */
  x: number;
  y: number;
  hx: number;
  hy: number;
  rot: number;
  shape: IconId;
  color: Rgba;
  /** Multiplies color alpha (occlusion and fades). */
  alpha: number;
  /** Shape parameter (bodyDisc: view-space z of the sun direction; the rotation points at the sun on screen). */
  aux: number;
}

export interface TextRun {
  /** Top-left corner in device px (snapped to whole pixels by the renderer). */
  x: number;
  y: number;
  text: string;
  color: Rgba;
  alpha: number;
  /** Extra advance after every glyph, device px (tracked capitals of body names; 0 otherwise). */
  tracking: number;
}

/**
 * One frame's overlay. Its arrays and icon / text objects are pooled by the controller: a draw list is valid
 * until the next one is built (the renderer uploads it in the same prepare()).
 */
export interface DrawList {
  scene: MapScene;
  /**
   * Layer 0, in drawing order: debris dots, label plates and leaders, icons, the gizmo (labels' text after
   * them); layer 1: the hover tooltip on top of everything.
   */
  icons: [IconInstance[], IconInstance[]];
  texts: [TextRun[], TextRun[]];
}

/** Text metrics in device px (the glyph atlas supplies the real ones in the browser). */
export interface TextMetricsLike {
  /** Pen advance of a UTF-16 code unit. */
  advance(code: number): number;
  lineHeight: number;
}

/** Width of a single-line string in device px (sum of the advances plus tracking, as the renderer lays it out). */
export function measureText(m: TextMetricsLike, text: string, tracking = 0): number {
  let w = 0;
  for (let i = 0; i < text.length; i++) w += m.advance(text.charCodeAt(i));
  return w + tracking * Math.max(0, text.length - 1);
}

/** Whitespace code units the renderer advances over without drawing a glyph. */
export const isBlank = (code: number): boolean => code === 32 || code === 0x202f || code === 0x2009 || code === 0xa0;
