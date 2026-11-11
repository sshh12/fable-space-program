/**
 * Screen layout of the maneuver gizmo's three axes. Each node-frame axis (prograde, normal, radial) projects
 * to a screen direction and a foreshortening ("extent", 1 = in the screen plane, 0 = along the view ray). Used
 * as they are, two axes can land on one screen line: seen from above the orbit, the normal axis points at the
 * eye and its projected direction is the direction from the screen centre to the node, which with the planet
 * centred is the radial direction, so four handles and two bars share a line. The layout therefore
 *  1. turns the most foreshortened axis toward the middle of the widest gap between the other two lines as its
 *     extent falls (a fixed fan-out position; blended so nothing pops), and
 *  2. pushes the three axis lines apart until every pair is at least GIZMO_MIN_SEPARATION apart (lines, so
 *     the plus handle of one axis and the minus handle of another are kept apart too), moving foreshortened
 *     axes more than axes that lie in the screen plane, and
 *  3. keeps every handle at least GIZMO_MIN_REACH of the full handle distance from the node.
 * With 40 degrees between lines and the handles at least 0.55 x 58 px out, handle centres are more than a
 * handle diameter apart and no handle touches another axis' bar.
 */

/** Smallest angle between two axis lines of the gizmo (radians). */
export const GIZMO_MIN_SEPARATION = (40 * Math.PI) / 180;
/** Smallest handle distance as a fraction of the full distance; an axis turned to its fan-out position sits further out. */
export const GIZMO_MIN_REACH = 0.55;
const FANNED_REACH = 0.7;
/** Extent below which an axis starts turning to its fan-out position, and above which it is left alone. */
const FAN_START = 0.6;
const FAN_END = 0.25;

export interface AxisIn {
  /** Unit screen direction of the axis' plus end (device px space, y down). */
  dx: number;
  dy: number;
  /** sin of the angle between the axis and the view ray. */
  extent: number;
}

export interface AxisOut {
  /** Unit screen direction of the plus handle (the minus handle is opposite). */
  dx: number;
  dy: number;
  /** Handle distance as a fraction of the full distance. */
  reach: number;
}

const HALF = Math.PI;
/** a - b as lines (mod pi), in (-pi/2, pi/2]. */
const lineDiff = (a: number, b: number): number => {
  let d = (a - b) % HALF;
  if (d > HALF / 2) d -= HALF;
  else if (d <= -HALF / 2) d += HALF;
  return d;
};

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/** Layout of three axes (any order); the result is in the same order. */
export function layoutGizmo(axes: readonly [AxisIn, AxisIn, AxisIn]): [AxisOut, AxisOut, AxisOut] {
  const ang = axes.map((a) => Math.atan2(a.dy, a.dx));
  const ext = axes.map((a) => Math.min(1, Math.max(0, a.extent)));
  const fan = [1, 1, 1];
  // 1. the most foreshortened axis turns toward the middle of the wider gap between the other two lines
  let m = 0;
  for (let i = 1; i < 3; i++) if (ext[i]! < ext[m]!) m = i;
  const w = smooth(FAN_END, FAN_START, ext[m]!);
  fan[m] = w;
  if (w < 1) {
    const a = ang[(m + 1) % 3]!;
    const b = ang[(m + 2) % 3]!;
    // the two bisectors of lines a and b; take the one in the wider gap
    const half = lineDiff(b, a) / 2;
    const bis1 = a + half;
    const bis2 = bis1 + HALF / 2;
    const gap1 = Math.abs(half) * 2;
    const fallback = gap1 >= HALF - gap1 ? bis1 : bis2;
    ang[m] = fallback + w * lineDiff(ang[m]!, fallback);
  }
  // 2. push the lines apart; foreshortened axes move more (mobility 0.15 in the screen plane .. 1.15 along the ray)
  const mob = ext.map((e) => 1.15 - e * e);
  for (let iter = 0; iter < 8; iter++) {
    let moved = false;
    for (let i = 0; i < 3; i++) {
      for (let j = i + 1; j < 3; j++) {
        const d = lineDiff(ang[j]!, ang[i]!);
        const deficit = GIZMO_MIN_SEPARATION - Math.abs(d);
        if (deficit <= 1e-9) continue;
        const dir = d >= 0 ? 1 : -1;
        const share = mob[j]! / (mob[i]! + mob[j]!);
        ang[i] = ang[i]! - dir * deficit * (1 - share) * 1.0001;
        ang[j] = ang[j]! + dir * deficit * share * 1.0001;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // 3. the plus handle takes the end of its line nearest the projected plus direction
  return axes.map((a, i) => {
    let dx = Math.cos(ang[i]!);
    let dy = Math.sin(ang[i]!);
    if (dx * a.dx + dy * a.dy < 0) {
      dx = -dx;
      dy = -dy;
    }
    const reach = Math.max(ext[i]!, GIZMO_MIN_REACH + (1 - fan[i]!) * (FANNED_REACH - GIZMO_MIN_REACH));
    return { dx, dy, reach };
  }) as [AxisOut, AxisOut, AxisOut];
}
