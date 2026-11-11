/**
 * The quilting of the insulation blankets, shared by the mesh (cabin/shell.ts displaces the blanket's
 * vertices by it) and the interior shader (which shades every pixel with the same relief): diamond cells
 * whose fill bulges between stitched seams.
 *
 * Quilt coordinates q count cells: the cell lattice is q turned by 45 degrees, a = (q.x + q.y, q.x - q.y) /
 * sqrt(2), with the seams where a.x or a.y is an integer and a cell's crown where both are an integer plus
 * one half. A blanket's vertices carry q as their surface coordinates (uv0), so each bay may turn, shift and
 * bend its quilting freely and the shader follows.
 */
export const QUILT = {
  /** Side of a diamond cell, m. */
  cell: 0.068,
  /** Height of a cell's crown above its seams, m. */
  height: 0.0075,
  /** Exponent of the pillow profile (below 1: the cloth dives into the seam at a crease). */
  power: 0.62,
} as const;

/** Channelled upholstery of the couch pads: the cover stitched down across the pad at this pitch. */
export const UPHOLSTERY = {
  /** Distance between two rows of stitching, m. */
  pitch: 0.105,
  /** Height of a channel's crown above its seams, m. */
  height: 0.0045,
  power: 0.7,
} as const;

/** Height (m) of the channels' relief at the pad's surface coordinate y (m) across the channels. */
export function upholsteryHeight(y: number): number {
  const a = y / UPHOLSTERY.pitch;
  const f = a - Math.floor(a) - 0.5;
  return UPHOLSTERY.height * Math.max(0, Math.cos(Math.PI * f)) ** UPHOLSTERY.power;
}

/** Height (m) of the quilt's relief at quilt coordinates q: 0 on the seams, QUILT.height on a cell's crown. */
export function quiltHeight(qx: number, qy: number): number {
  const ax = (qx + qy) * Math.SQRT1_2;
  const ay = (qx - qy) * Math.SQRT1_2;
  const fx = ax - Math.floor(ax) - 0.5;
  const fy = ay - Math.floor(ay) - 0.5;
  return QUILT.height * Math.max(0, Math.cos(Math.PI * fx) * Math.cos(Math.PI * fy)) ** QUILT.power;
}
