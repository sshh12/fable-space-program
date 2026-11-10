/**
 * Analytic occlusion by spherical bodies, the CPU twin of the WGSL `occlusion()` in gpu/shaders.ts.
 * A point is hidden when the ray from the eye hits a body sphere before reaching it; the hidden weight
 * ramps from 0 at the limb to 1 at OCCLUSION_FADE_PX inside it, so lines and markers fade softly as they
 * pass behind a planet instead of being cut. No depth buffer is involved.
 */
import type { Vec3 } from '@/core/math/vec3';

export interface Occluder {
  /** Sphere centre in view space (camera at the origin), metres, float64. */
  x: number;
  y: number;
  z: number;
  radius: number;
}

/** Distance tolerance below which a point on the near surface counts as on it (f32 rounding on the GPU). */
export function surfaceTolerance(radius: number, centreDistance: number): number {
  return Math.max(1e-3 * radius, 4e-7 * centreDistance);
}

/**
 * Hidden weight 0 (visible) .. 1 (hidden) of view-space point p.
 * `focalPx` converts angles to device pixels; `fadePx` is the soft ramp width in device pixels.
 */
export function occlusionWeight(p: Vec3, occluders: readonly Occluder[], focalPx: number, fadePx: number): number {
  const tp = Math.hypot(p.x, p.y, p.z);
  if (!(tp > 0)) return 0;
  const dx = p.x / tp;
  const dy = p.y / tp;
  const dz = p.z / tp;
  let w = 0;
  for (const o of occluders) {
    const L = Math.hypot(o.x, o.y, o.z);
    if (!(L > o.radius)) continue; // eye inside the sphere: no meaningful occlusion
    const tc = dx * o.x + dy * o.y + dz * o.z;
    if (tc <= 0) continue; // body behind the eye
    // angle between the ray and the body centre, and the body's angular radius
    const cxv = dy * o.z - dz * o.y;
    const cyv = dz * o.x - dx * o.z;
    const czv = dx * o.y - dy * o.x;
    const theta = Math.atan2(Math.hypot(cxv, cyv, czv), tc);
    const alpha = Math.asin(o.radius / L);
    if (theta >= alpha) continue;
    const dPerp2 = Math.max(0, L * L - tc * tc);
    const t1 = tc - Math.sqrt(Math.max(0, o.radius * o.radius - dPerp2));
    if (tp <= t1 + surfaceTolerance(o.radius, L)) continue;
    const inside = (alpha - theta) * focalPx;
    const s = Math.min(1, inside / fadePx);
    const k = s * s * (3 - 2 * s);
    if (k > w) w = k;
  }
  return w;
}
