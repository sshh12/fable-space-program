/**
 * Reduced fidelity tier for distant debris (sim-design section 14): a 3-DoF point mass with a
 * tumbling-average drag area and one lumped thermal node. Attitude is left untouched. The step may be
 * long (the orchestrator calls it at about 2 Hz of simulation time).
 */
import type { VesselEnvironment } from '@/core/contracts/simInternal';
import { quat } from '@/core/math/quat';
import { vesselMass } from '../vessel/massProps';
import { structureOf } from '../vessel/structure';
import type { Vessel } from '../vessel/types';
import { environmentTemperature, stagnationFlux, STEFAN_BOLTZMANN } from './thermal';

export interface ReducedStepResult {
  /** Set when the vessel is gone: burned up in the atmosphere or hit the ground / sea. */
  removed: 'burnedUp' | 'impact' | null;
  /** Body-fixed unit direction of the impact point (when removed === 'impact'). */
  impactDirFixed: { x: number; y: number; z: number } | null;
}

const acc = [0, 0, 0];

function accel(env: VesselEnvironment, bc: number, px: number, py: number, pz: number, vx: number, vy: number, vz: number): void {
  const r2 = px * px + py * py + pz * pz;
  const r1 = Math.sqrt(r2);
  const k = -env.mu / (r2 * r1);
  let ax = k * px;
  let ay = k * py;
  let az = k * pz;
  const rho = env.atmosphereAt(r1 - env.radius).density;
  if (rho > 0) {
    const sp = env.spin;
    const ux = vx - (sp.y * pz - sp.z * py);
    const uy = vy - (sp.z * px - sp.x * pz);
    const uz = vz - (sp.x * py - sp.y * px);
    const s = Math.sqrt(ux * ux + uy * uy + uz * uz);
    const d = -0.5 * rho * s * bc;
    ax += d * ux;
    ay += d * uy;
    az += d * uz;
  }
  acc[0] = ax;
  acc[1] = ay;
  acc[2] = az;
}

/** Advance a debris vessel by dt as a point mass. The vessel's `r`/`v` are those of its origin (attitude frozen). */
export function stepVesselReduced(vessel: Vessel, env: VesselEnvironment, dt: number): ReducedStepResult {
  const st = structureOf(vessel);
  const mass = vesselMass(vessel);
  vessel.age += dt;
  if (!(mass > 0) || vessel.hold !== null) return { removed: null, impactDirFixed: null };
  // Inverse ballistic coefficient CdA / m.
  const bc = st.cdAAverage / mass;
  const r = vessel.r;
  const v = vessel.v;
  const h2 = dt / 2;
  accel(env, bc, r.x, r.y, r.z, v.x, v.y, v.z);
  const k1x = acc[0]!;
  const k1y = acc[1]!;
  const k1z = acc[2]!;
  const v2x = v.x + k1x * h2;
  const v2y = v.y + k1y * h2;
  const v2z = v.z + k1z * h2;
  accel(env, bc, r.x + v.x * h2, r.y + v.y * h2, r.z + v.z * h2, v2x, v2y, v2z);
  const k2x = acc[0]!;
  const k2y = acc[1]!;
  const k2z = acc[2]!;
  const v3x = v.x + k2x * h2;
  const v3y = v.y + k2y * h2;
  const v3z = v.z + k2z * h2;
  accel(env, bc, r.x + v2x * h2, r.y + v2y * h2, r.z + v2z * h2, v3x, v3y, v3z);
  const k3x = acc[0]!;
  const k3y = acc[1]!;
  const k3z = acc[2]!;
  const v4x = v.x + k3x * dt;
  const v4y = v.y + k3y * dt;
  const v4z = v.z + k3z * dt;
  accel(env, bc, r.x + v3x * dt, r.y + v3y * dt, r.z + v3z * dt, v4x, v4y, v4z);
  const s6 = dt / 6;
  r.x += s6 * (v.x + 2 * v2x + 2 * v3x + v4x);
  r.y += s6 * (v.y + 2 * v2y + 2 * v3y + v4y);
  r.z += s6 * (v.z + 2 * v2z + 2 * v3z + v4z);
  v.x += s6 * (k1x + 2 * k2x + 2 * k3x + acc[0]!);
  v.y += s6 * (k1y + 2 * k2y + 2 * k3y + acc[1]!);
  v.z += s6 * (k1z + 2 * k2z + 2 * k3z + acc[2]!);

  const rl = Math.sqrt(r.x * r.x + r.y * r.y + r.z * r.z);
  const alt = rl - env.radius;
  const atm = env.atmosphereAt(alt);
  const sp = env.spin;
  const ux = v.x - (sp.y * r.z - sp.z * r.y);
  const uy = v.y - (sp.z * r.x - sp.x * r.z);
  const uz = v.z - (sp.x * r.y - sp.y * r.x);
  const speed = Math.sqrt(ux * ux + uy * uy + uz * uz);
  vessel.aero.q = 0.5 * atm.density * speed * speed;
  vessel.aero.mach = atm.speedOfSound > 0 ? speed / atm.speedOfSound : 0;
  vessel.aero.density = atm.density;
  vessel.aero.pressure = atm.pressure;
  vessel.aero.temperature = atm.temperature;
  vessel.aero.airVelocity.x = ux;
  vessel.aero.airVelocity.y = uy;
  vessel.aero.airVelocity.z = uz;

  // Lumped thermal node: half the stagnation flux of a body of the vessel's size, in sub-steps short
  // enough for the explicit update to stay stable.
  const flux = env.heating ? 0.5 * stagnationFlux(env.heating, atm.density, speed, Math.max(0.5, st.boundingRadius / 2)) : 0;
  vessel.aero.heatFlux = flux;
  vessel.aero.plasmaIntensity = Math.min(1, Math.max(0, (flux - 0.05e6) / 0.95e6));
  const tEnv = environmentTemperature(env, atm.density, atm.temperature);
  let T = vessel.parts[0]?.temps[0] ?? 290;
  const steps = Math.max(1, Math.ceil(dt / 0.05));
  const hs = dt / steps;
  for (let i = 0; i < steps; i++) {
    T += ((flux - st.lumpEmissivity * STEFAN_BOLTZMANN * (T ** 4 - tEnv ** 4)) * hs) / st.lumpHeatCap;
  }
  for (const p of vessel.parts) for (let k = 0; k < p.temps.length; k++) p.temps[k] = T;
  if (T > st.lumpMaxTemp) return { removed: 'burnedUp', impactDirFixed: null };

  // Ground or sea.
  if (alt < 30000) {
    const d = quat.rotateInv(env.qFixedToInertial, { x: r.x / rl, y: r.y / rl, z: r.z / rl });
    let surface = env.terrainHeight(d, Math.max(0.3, 0.02 * Math.max(alt, 0)));
    if (env.ocean !== null && env.surfaceKind(d) === 'water') surface = Math.max(surface, env.ocean.waterHeight(d));
    if (alt <= surface) return { removed: 'impact', impactDirFixed: d };
  }
  return { removed: null, impactDirFixed: null };
}
