/**
 * Which bodies are in the presented frame (for the specs' check that the chase view's default framing shows
 * the Earth or the Moon, request app-integration-10). Pure geometry on the camera's view space: x right, y up,
 * the eye looks down -z; a body is a disc of angular radius asin(radius / distance) about its direction.
 */

export interface DiscInFrame {
  /** The disc reaches into the frame. */
  inFrame: boolean;
  /** Centre in normalised device coordinates (-1..1 inside); null when the centre is behind the image plane. */
  x: number | null;
  y: number | null;
  /** Angular radius of the disc as a share of the frame's vertical half-angle (1 = the disc spans the height). */
  heightShare: number;
}

/** Sample directions per axis for discs too large for the small-disc test (their limb crosses the frame). */
const GRID = 9;

/**
 * Whether a disc of angular radius `angularRadius` (rad) about view-space direction `d` (any length) reaches
 * into a frame with half-angle tangents `tanX`, `tanY`.
 *  - A small disc (the Moon from the Earth, the Earth from the Moon) is tested as a circle about its projected
 *    centre against the frame's rectangle.
 *  - A large one (the planet under a low orbit: its centre is 90 degrees off the view axis and may be behind the
 *    image plane while its limb crosses the picture) is tested by the angle from its centre to a grid of
 *    directions across the frame: in the frame when any of them lies inside the disc.
 */
export function discInFrame(d: { x: number; y: number; z: number }, angularRadius: number, tanX: number, tanY: number): DiscInFrame {
  const len = Math.hypot(d.x, d.y, d.z);
  const heightShare = angularRadius / Math.atan(tanY);
  const front = d.z < 0;
  const x = front ? d.x / (-d.z * tanX) : null;
  const y = front ? d.y / (-d.z * tanY) : null;
  if (len === 0) return { inFrame: false, x: null, y: null, heightShare };
  // Small disc: circle about the projected centre.
  if (front && angularRadius < 0.35) {
    const r = Math.tan(angularRadius);
    if (Math.abs(x!) < 1 + r / tanX && Math.abs(y!) < 1 + r / tanY) return { inFrame: true, x, y, heightShare };
  }
  // Any size: a direction of the frame inside the disc.
  const cosR = Math.cos(angularRadius);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const fx = (-1 + (2 * i) / (GRID - 1)) * tanX;
      const fy = (-1 + (2 * j) / (GRID - 1)) * tanY;
      const cos = (d.x * fx + d.y * fy - d.z) / (len * Math.hypot(fx, fy, 1));
      if (cos >= cosR) return { inFrame: true, x, y, heightShare };
    }
  }
  return { inFrame: false, x, y, heightShare };
}
