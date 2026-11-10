/**
 * CPU-side description of one overlay frame, consumed by the GPU renderer (gpu/overlayRenderer.ts).
 * Lines reference the scene's float64 vertex arrays; icons and text are positioned in device pixels.
 */
import type { Rgba } from './constants';
import type { MapScene } from './scene';

/** Icon shapes understood by the icon shader (gpu/shaders.ts keeps the same numbering). */
export const ICON = {
  apsis: 0,
  inclination: 1,
  soi: 2,
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
  dot: 23,
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
}

export interface TextRun {
  /** Top-left corner in device px (snapped to whole pixels by the renderer). */
  x: number;
  y: number;
  text: string;
  color: Rgba;
  alpha: number;
}

export interface DrawList {
  scene: MapScene;
  /** Layer 0: everything; layer 1: hover tooltip on top of everything. */
  icons: [IconInstance[], IconInstance[]];
  texts: [TextRun[], TextRun[]];
}

/** Monospace text metrics in device px (the atlas supplies the real ones in the browser). */
export interface TextMetricsLike {
  advance: number;
  lineHeight: number;
}
