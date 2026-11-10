/**
 * Seams inside the simulation, so orbital mechanics (src/sim/orbit, frames, bodies, nav), vessel dynamics
 * (src/sim/vessel, dynamics, control) and the world orchestrator (src/sim/world) can be built in parallel.
 */
import type { Quat } from '../math/quat';
import type { Vec3 } from '../math/vec3';
import type { AtmosphereHeatingDef } from './defs';
import type { SurfaceKind } from './terrain';

export interface StateVector {
  r: Vec3;
  v: Vec3;
}

export interface AtmosphereSample {
  /** kg/m^3 */
  density: number;
  /** Pa */
  pressure: number;
  /** K */
  temperature: number;
  /** m/s */
  speedOfSound: number;
}

export const VACUUM: Readonly<AtmosphereSample> = Object.freeze({ density: 0, pressure: 0, temperature: 4, speedOfSound: 275 });

/**
 * Everything the vessel dynamics need to know about the world for one integration step. Built by the
 * world orchestrator from the body system and the terrain provider; trivially faked in unit tests
 * (uniform gravity, flat ground, exponential atmosphere).
 *
 * Vessel translational state is in BCI(bodyId); "fixed" means the body-fixed frame of that body.
 */
export interface VesselEnvironment {
  ut: number;
  bodyId: string;
  /** Central body: gravitational parameter and reference radius. */
  mu: number;
  radius: number;
  /** BCBF -> BCI orientation at `ut` and spin vector in BCI axes (rad/s). */
  qFixedToInertial: Quat;
  spin: Vec3;
  /** Atmosphere at an altitude above the reference radius (VACUUM when the body has none). */
  atmosphereAt(altitude: number): AtmosphereSample;
  /** Aerothermal constants, null when there is no atmosphere. */
  heating: AtmosphereHeatingDef | null;
  /** Solid-surface height above the reference radius and unit normal (body-fixed) under a body-fixed direction. */
  terrainHeight(dirFixed: Vec3): number;
  terrainNormal(dirFixed: Vec3): Vec3;
  surfaceKind(dirFixed: Vec3): SurfaceKind;
  surfaceFriction: number;
  /** Ocean: null when the body has none. waterHeight includes swell (src/core/geo/oceanSwell.ts). */
  ocean: null | { density: number; waterHeight(dirFixed: Vec3): number };
  /** Unit direction to the star in BCI axes and the visible fraction of its disc (eclipses). */
  sunDir: Vec3;
  sunVisibility: number;
}
