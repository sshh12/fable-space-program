/**
 * Analytic occlusion by spherical bodies, the CPU twin of the WGSL `occlusion()` in gpu/shaders.ts.
 * A point is hidden when the ray from the eye hits a body sphere before reaching it; the hidden weight
 * ramps from 0 at the limb to 1 at the fade width inside it (OCCLUSION_FADE_PX, 1.5 px), so an occluded line
 * ends at the limb with a short soft edge instead of a hard cut. No depth buffer is involved.
 *
 * A body with an atmosphere occludes with its VISIBLE limb (`vis`, the top of the limb glow) every point that
 * lies above that shell: a line behind the planet ends where the glow ends, not inside it. A point inside the
 * shell (an entry trajectory, a low orbit) is tested against the solid sphere only: the glow is translucent.
 */
import type { Vec3 } from '@/core/math/vec3';

export interface Occluder {
  /** Sphere centre in view space (camera at the origin), metres, float64. */
  x: number;
  y: number;
  z: number;
  /** Solid (datum) radius, m. */
  radius: number;
  /** Radius of the visible limb, m (radius plus the visible atmosphere; equal to radius without one). */
  vis: number;
}

/** Distance tolerance below which a point on the near surface counts as on it (f32 rounding on the GPU). */
export function surfaceTolerance(radius: number, centreDistance: number): number {
  return Math.max(1e-3 * radius, 4e-7 * centreDistance);
}

/**
 * Hidden weight 0 (visible) .. 1 (hidden) of view-space point p.
 * `focalPx` converts angles to device pixels; `fadePx` is the soft ramp width in device pixels.
 * `slack` (m) is the radial depth below a surface that still counts as on it (points of a line lying on a
 * body): the point is then tested against each SOLID sphere shrunk by that much, which keeps the allowance the
 * same size all the way to the limb (an allowance along the view ray would grow without bound there).
 */
export function occlusionWeight(p: Vec3, occluders: readonly Occluder[], focalPx: number, fadePx: number, slack = 0): number {
  const tp = Math.sqrt(p.x * p.x + p.y * p.y + p.z * p.z);
  if (!(tp > 0)) return 0;
  const dx = p.x / tp;
  const dy = p.y / tp;
  const dz = p.z / tp;
  let w = 0;
  for (const o of occluders) {
    const L = Math.sqrt(o.x * o.x + o.y * o.y + o.z * o.z);
    if (!(L > o.radius)) continue; // eye inside the sphere: no meaningful occlusion
    const tc = dx * o.x + dy * o.y + dz * o.z;
    if (tc <= 0) continue; // body behind the eye
    let R = o.radius - slack;
    if (slack === 0 && o.vis > o.radius && L > o.vis) {
      // above the visible atmosphere: the glow hides it as the solid limb would
      const qx = p.x - o.x;
      const qy = p.y - o.y;
      const qz = p.z - o.z;
      if (qx * qx + qy * qy + qz * qz > o.vis * o.vis) R = o.vis;
    }
    // distance of the body centre from the ray, and the ray's first intersection with the (shrunk) sphere
    const cxv = dy * o.z - dz * o.y;
    const cyv = dz * o.x - dx * o.z;
    const czv = dx * o.y - dy * o.x;
    const dPerp = Math.sqrt(cxv * cxv + cyv * cyv + czv * czv);
    if (dPerp >= R) continue;
    const t1 = tc - Math.sqrt((R - dPerp) * (R + dPerp));
    if (tp <= t1 + (slack > 0 ? 0 : surfaceTolerance(R, L))) continue;
    // angular depth inside the limb, in pixels
    const inside = (Math.asin(R / L) - Math.atan2(dPerp, tc)) * focalPx;
    const s = Math.min(1, inside / fadePx);
    const k = s * s * (3 - 2 * s);
    if (k > w) w = k;
  }
  return w;
}

/**
 * Height (m) of the visible limb above the datum of a body with this atmosphere: where the optical depth of
 * the strongest Rayleigh channel along a ray grazing the shell falls to `tau` (the column along a tangent ray
 * at height h is about beta(h) sqrt(2 pi R H)). 0 without an atmosphere; never above the shell's top.
 */
export function visibleAtmosphereHeight(radius: number, atm: { topAltitude: number; rayleighScattering: readonly number[]; rayleighScaleHeight: number } | null | undefined, tau: number): number {
  if (!atm || !(atm.rayleighScaleHeight > 0) || !(radius > 0)) return 0;
  const beta = Math.max(...atm.rayleighScattering);
  const H = atm.rayleighScaleHeight;
  const grazing = beta * Math.sqrt(2 * Math.PI * radius * H);
  if (!(grazing > tau)) return 0;
  return Math.min(atm.topAltitude, H * Math.log(grazing / tau));
}
