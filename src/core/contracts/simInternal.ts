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
 *
 * The environment describes the START of the step it is passed to: `ut`, `qFixedToInertial`, the sun and
 * the swell behind `ocean.waterHeight` are those of the state the step integrates FROM. Vessels a step
 * spawns (stage separation, debris) are returned in that same start-of-step state and must be stepped once
 * with the same environment in the same tick, so that every vessel is at `ut + dt` afterwards.
 */
export interface VesselEnvironment {
  ut: number;
  bodyId: string;
  /**
   * v2 (ARCHITECTURE section 4): the island's reference-orbit point, as its position and velocity in
   * BCI(bodyId) at `ut`. When present, the vessel's translational state is the OFFSET from this point and
   * gravity enters as the difference between the acceleration at the vessel and at the origin, evaluated
   * without cancellation (Encke's method). Absent = the state is in BCI(bodyId), exactly as in v1. Like
   * everything here it describes the START of the step. Contact with other vessels does not go through the
   * environment.
   */
  origin?: { r: Vec3; v: Vec3 };
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
  /**
   * Solid-surface height above the reference radius under a body-fixed direction. With `lambdaMin` omitted this
   * is the collision surface (identical to the rendered max-level mesh; cached and cheap near a vessel) - use
   * it for contact probes. Pass a band limit in metres (e.g. max(0.3, 0.02 * altitude)) for altimetry and
   * look-ahead queries far from the ground, which are evaluated analytically without fine detail.
   */
  terrainHeight(dirFixed: Vec3, lambdaMin?: number): number;
  /** Unit outward surface normal in the body-fixed frame by central differences over `baseline` metres (default 1). */
  terrainNormal(dirFixed: Vec3, baseline?: number): Vec3;
  surfaceKind(dirFixed: Vec3): SurfaceKind;
  surfaceFriction: number;
  /** Ocean: null when the body has none. waterHeight includes swell (src/core/geo/oceanSwell.ts). */
  ocean: null | { density: number; waterHeight(dirFixed: Vec3): number };
  /** Unit direction to the star in BCI axes and the visible fraction of its disc (eclipses). */
  sunDir: Vec3;
  sunVisibility: number;
}
