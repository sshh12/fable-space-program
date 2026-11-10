import type { Vec3 } from '../math/vec3';
import { TWO_PI } from '../math/scalar';

/**
 * Deterministic long-wave ocean swell shared by physics (buoyancy, splashdown) and the ocean renderer.
 * The renderer adds FFT wind waves on top for looks; these components are the part of the sea surface
 * that a floating capsule actually rides, so both sides MUST evaluate this exact function.
 *
 * Each component is a plane wave in body-fixed 3-D space intersected with the sphere:
 *   eta_i(p, t) = A_i * w_i * cos(k_i * dot(d_i, p) - omega_i * t + phi_i)
 * with p the body-fixed position on the reference sphere (metres), d_i a unit body-fixed direction,
 * k_i = 2 pi / lambda_i, deep-water dispersion omega_i = sqrt(g k_i), and
 *   w_i = smoothstep(0.15, 0.5, |d_i x n|)
 * fading the component out where its wave vector is nearly parallel to the local vertical n (there the
 * surface wavelength stretches to infinity). Components are data: BodyDef.ocean.swell.
 */
export interface SwellComponent {
  /** Unit propagation direction in the body-fixed frame. */
  dir: [number, number, number];
  /** Wavelength, m. */
  wavelength: number;
  /** Amplitude, m. */
  amplitude: number;
  /** Phase at t = 0, rad. */
  phase: number;
}

const smooth = (e0: number, e1: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

/**
 * Sea-surface elevation above the body's sea level, metres.
 * @param swell components from the body definition
 * @param gravity surface gravity, m/s^2
 * @param radius sea-level radius of the body, m
 * @param n unit body-fixed direction of the query point
 * @param t simulation time `ut`, s
 */
export function oceanSwellHeight(swell: readonly SwellComponent[], gravity: number, radius: number, n: Vec3, t: number): number {
  let eta = 0;
  for (const c of swell) {
    const dn = c.dir[0] * n.x + c.dir[1] * n.y + c.dir[2] * n.z;
    const sinAng = Math.sqrt(Math.max(0, 1 - dn * dn));
    const w = smooth(0.15, 0.5, sinAng);
    if (w === 0) continue;
    const k = TWO_PI / c.wavelength;
    const omega = Math.sqrt(gravity * k);
    eta += c.amplitude * w * Math.cos(k * radius * dn - omega * t + c.phase);
  }
  return eta;
}
