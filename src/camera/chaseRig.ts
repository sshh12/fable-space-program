/**
 * Chase rig (mode 'chase', kind 'external'): orbits the active vessel's centre of mass.
 *
 * Reference frame (the "level" of the camera): up = the local vertical of the body whose sphere of influence
 * the vessel is in (away from its centre), so that body is always below the camera; the azimuth follows the
 * navball mode:
 *  - surface: measured from local north;
 *  - orbit:   measured from the horizontal part of the orbital velocity, so the camera keeps its place
 *    relative to the track around the orbit.
 * A change of navball mode re-expresses the azimuth (the view does not move). A change of body (leaving or
 * entering a sphere of influence) keeps the camera's angles and swings it to them in the new body's frame over
 * CHASE_BODY_BLEND_SECONDS with the C-infinity smooth step.
 *
 * Framing (request app-integration-10). The camera's elevation is the reference elevation plus the player's
 * pitch. The reference elevation keeps the body in the frame where the geometry allows it
 * (`chaseReferenceElevation`): near the body the view runs along the horizon with the limb below the vehicle
 * (12 degrees of elevation, as on the pad); as the vessel climbs away the camera rises over it, so that the
 * body stays in the lower part of the picture behind the vehicle. A body that has become a disc (far out: the
 * Earth from beyond 16,000 km, the Moon from beyond 4,500 km) is put beside the vehicle, in the lower left of
 * the frame, by rolling the default view (`chaseReferenceRoll`): straight below the vehicle is where a flight
 * display's instruments are, and a small disc there is hidden. The roll belongs to the default framing: it
 * eases out when the player turns or tilts the camera, whose frame is then level again. In orbit mode the default azimuth puts the eye on the sunward side of the vessel, CHASE_SUN_OFFSET
 * off the sun's line: the vehicle is lit and the sun is behind the camera, not a starburst over the vehicle;
 * it follows the sun around the orbit (once per revolution) until the player turns the camera. On a surface
 * the default azimuth is the vessel's (behind the nose; from starboard while it stands). The distance is the
 * default distance for the vessel as it is now (`chaseAutoDistance`: the vehicle's
 * `cameras.chase.defaultDistance`, or less for what is left of it after staging) times the player's zoom.
 *
 * The player's input always wins and persists: yaw, pitch and zoom are kept as the azimuth, the offset from
 * the reference elevation and the factor on the default distance, through view switches (cockpit, map and
 * back), navball modes, staging and spheres of influence; only another active vessel starts from the defaults.
 * `resetView()` returns to them.
 *
 * Distance limits: VehicleDef.cameras.chase (min, max). Vessels without a vehicle definition (debris of an
 * unknown vehicle, the FakeSim) use multiples of their bounding radius: default 2.4 r, min 1.15 r, max 60 r.
 * The minimum is always kept above 1.05 x the bounding radius.
 *
 * Terrain: with a TerrainProvider the eye stays `clearance` metres above the collision surface (or above the
 * sea where the body has an ocean); without one, above the body's datum sphere (and its sea level).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraState } from '@/core/contracts/render';
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat, type Quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { activeVessel, approach, bodyById, bodyDef, enuAt, lookRotation, slerpDir, smoothBlend, vesselComRoot, type FlightCameraRig } from './cameraMath';

export interface ChaseRigOptions {
  defs: DefLibrary;
  terrain?: TerrainProvider;
  /** Vertical field of view, rad (55 deg). */
  fovY?: number;
  /** Minimum eye height above the ground, m (2.5). */
  clearance?: number;
  /** Elevation of the camera above the horizontal plane near a body, rad (12 deg). */
  elevation?: number;
  /**
   * Keep the vessel's body in the frame and, in orbit mode, the sun behind the camera by default (default
   * true). False pins the framing of before: `elevation` at every altitude, the azimuth from the vessel's nose.
   */
  frameBody?: boolean;
  /**
   * Default distance in radii of the vessel about its centre of mass (default CHASE_DISTANCE_PER_RADIUS),
   * never more than the vehicle's `cameras.chase.defaultDistance`. Infinity: always the vehicle's default.
   */
  distanceRadii?: number;
  /**
   * On a switch from another flight view start behind that view's direction (default false: the rig keeps the
   * placement the player left it with; the view manager blends the switch either way).
   */
  startBehindPreviousView?: boolean;
}

/** Seconds of the swing when the reference body changes (sphere of influence) or the view is reset. */
export const CHASE_BODY_BLEND_SECONDS = 3;
/** @deprecated The navball modes share their vertical since the body framing: a mode change needs no blend. Kept for importers. */
export const CHASE_FRAME_BLEND_SECONDS = 1.6;
/** Default distance in radii of the vessel about its centre of mass: a vessel fills about three fifths of the frame's height. */
export const CHASE_DISTANCE_PER_RADIUS = 3.2;
/** Time constant with which the default distance follows a change of the vessel's size (staging), s. */
export const CHASE_AUTO_SECONDS = 0.8;
/** Default azimuth in orbit mode: the eye this far off the sun's line on the sunward side of the vessel, rad. */
export const CHASE_SUN_OFFSET = 35 * DEG;
/** The default azimuth follows the sun with this time constant (s) and at most this rate (rad/s). */
export const CHASE_SUN_SECONDS = 2.5;
export const CHASE_SUN_RATE = 15 * DEG;
/** Below this horizontal share of the sun's direction (the sun near the zenith or the nadir) the azimuth is left where it is. */
const CHASE_SUN_HORIZONTAL = 0.2;
/** The limb of a body lies this share of the half field of view from the frame's centre (below it in a level view). */
export const CHASE_LIMB_BELOW = 0.36;
/** The same for a disc in the rolled default view: it clears the vehicle. */
export const CHASE_DISC_OFF = 0.72;
/** Roll of the default view for a small disc, rad: the body is this far round from straight below, to the left. */
export const CHASE_DISC_ROLL = 65 * DEG;
/** Angular radius from which the roll comes in, and the one from which it is whole, rad. */
export const CHASE_DISC_FROM = 16 * DEG;
export const CHASE_DISC_FULL = 6 * DEG;
/** Time constant of the roll, s. */
export const CHASE_ROLL_SECONDS = 0.6;
const MAX_ELEVATION = 89 * DEG;

type RefMode = 'surface' | 'orbit';

/** Reference frame -> ROOT. Frame axes: X = azimuth zero, Y = Z x X, Z = up (away from the vessel's body). */
export function chaseReferenceFrame(s: SimSnapshot, v: VesselSnapshot, mode: RefMode): Quat {
  const body = bodyById(s, v.bodyId);
  const { n, u } = enuAt(v.r, body.qFixedToRoot);
  if (mode === 'orbit') {
    const h = v3.reject(v.v, u);
    const speed = v3.len(h);
    // Azimuth zero = the horizontal part of the orbital velocity; north where there is none (a radial fall).
    if (speed > 1e-3 && speed > 1e-6 * v3.len(v.v)) {
      const x = v3.scale(h, 1 / speed);
      return quat.fromBasis(x, v3.cross(u, x), u);
    }
  }
  return quat.fromBasis(n, v3.cross(u, n), u);
}

/** Offset direction (from the target to the eye) for azimuth / elevation in a reference frame. */
function offsetDir(frame: Quat, azimuth: number, elevation: number): Vec3 {
  const c = Math.cos(elevation);
  return quat.rotate(frame, { x: c * Math.cos(azimuth), y: c * Math.sin(azimuth), z: Math.sin(elevation) });
}

function anglesOf(frame: Quat, dirRoot: Vec3): { azimuth: number; elevation: number } {
  const d = quat.rotateInv(frame, dirRoot);
  return { azimuth: Math.atan2(d.y, d.x), elevation: Math.asin(Math.max(-1, Math.min(1, d.z))) };
}

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function chaseDistanceLimits(defs: DefLibrary, v: VesselSnapshot): { def: number; min: number; max: number } {
  const r = Math.max(0.5, v.boundingRadius);
  const chase = defs.vehicles[v.vehicleId]?.cameras.chase;
  if (chase) {
    const min = Math.max(chase.minDistance, 1.05 * r);
    const max = Math.max(min, chase.maxDistance);
    return { def: clamp(chase.defaultDistance, min, max), min, max };
  }
  return { def: 2.4 * r, min: 1.15 * r, max: 60 * r };
}

/**
 * Radius of the vessel about its centre of mass, m: the sphere there that holds the envelope cylinder
 * (`PartDef.bounds`) of every part. Null when no part has one (placeholder parts): the caller falls back to
 * `VesselSnapshot.boundingRadius`, which is about the VES origin and so up to twice as large.
 */
export function vesselRadiusAboutCom(defs: DefLibrary, v: VesselSnapshot): number | null {
  let radius = -1;
  for (const p of v.parts) {
    const b = defs.parts[p.def]?.bounds;
    if (!b) continue;
    // Part-frame point (0, y, 0) in VES, minus the centre of mass; the cylinder's rim is hypot(half, radius) from its centre.
    const mid = v3.add(p.localPos, quat.rotate(p.localRot, { x: 0, y: 0.5 * (b.yMax + b.yMin), z: 0 }));
    radius = Math.max(radius, v3.dist(mid, v.comLocal) + Math.hypot(0.5 * (b.yMax - b.yMin), b.radius));
  }
  return radius < 0 ? null : radius;
}

/**
 * Default chase distance for the vessel as it is now, m: the vehicle's `cameras.chase.defaultDistance` (set
 * for the whole stack on the pad), or CHASE_DISTANCE_PER_RADIUS radii of what is left of it when that is
 * nearer, inside the vehicle's limits. A capsule is not left as a few pixels at the stack's 140 m.
 */
export function chaseAutoDistance(defs: DefLibrary, v: VesselSnapshot, radii = CHASE_DISTANCE_PER_RADIUS): number {
  const lim = chaseDistanceLimits(defs, v);
  const r = vesselRadiusAboutCom(defs, v);
  return r === null || !Number.isFinite(radii) ? lim.def : clamp(Math.min(lim.def, radii * r), lim.min, lim.max);
}

const wrapAngle = (a: number): number => a - 2 * Math.PI * Math.round(a / (2 * Math.PI));

/**
 * Elevation of the chase camera above the horizontal plane that keeps a body of angular radius
 * `angularRadius` (rad, seen from the vessel) in a frame of vertical field of view `fovY`, the vehicle at its
 * centre. Near the body (the limb less than `base` + CHASE_LIMB_BELOW of the half field under the horizontal)
 * it is `base`: the view along the horizon. Higher up the camera rises so that the limb stays CHASE_LIMB_BELOW
 * of the half field from the centre. `side` (0..1) is the share of the roll of `chaseReferenceRoll` that is
 * applied: with it the limb moves out to CHASE_DISC_OFF of the half field, clear of the vehicle. Continuous in
 * both arguments.
 */
export function chaseReferenceElevation(angularRadius: number, fovY: number, base = 12 * DEG, side = 0): number {
  const half = fovY / 2;
  const rho = clamp(angularRadius, 0, Math.PI / 2);
  const limb = half * (CHASE_LIMB_BELOW + (CHASE_DISC_OFF - CHASE_LIMB_BELOW) * clamp(side, 0, 1));
  return clamp(Math.max(base, Math.PI / 2 - rho - limb), -MAX_ELEVATION, MAX_ELEVATION);
}

/**
 * Roll of the default chase view about its axis for a body of angular radius `angularRadius`, rad: 0 while
 * the body is a horizon or a large disc (the frame is level), CHASE_DISC_ROLL for a small disc, which then
 * stands to the lower left of the vehicle instead of straight below it.
 */
export function chaseReferenceRoll(angularRadius: number): number {
  const t = clamp((CHASE_DISC_FROM - angularRadius) / (CHASE_DISC_FROM - CHASE_DISC_FULL), 0, 1);
  return CHASE_DISC_ROLL * t * t * (3 - 2 * t);
}

export interface ChaseRig extends FlightCameraRig {
  /**
   * Place the camera: azimuth and elevation (rad) in the reference frame and the distance (m). Counts as the
   * player's input: it persists like a drag and a zoom.
   */
  setOrbit(azimuth: number, elevation: number, distance: number): void;
  /** Back to the default framing (azimuth behind the vessel, the reference elevation, the default distance), in a smooth swing. */
  resetView(): void;
  readonly distance: number;
  /** The player's part of the placement: pitch = offset from the reference elevation (rad), zoom = factor on the default distance. */
  readonly offsets: { azimuth: number; pitch: number; zoom: number };
  /** True until the player turns the camera (or `setOrbit` places it): the azimuth is the default one and follows it. */
  readonly autoAzimuth: boolean;
  /** Roll of the view about its axis now, rad (0 once the player has turned or tilted the camera). */
  readonly roll: number;
}

export function createChaseRig(opts: ChaseRigOptions): ChaseRig {
  const defs = opts.defs;
  const fovY = opts.fovY ?? 55 * DEG;
  const clearance = opts.clearance ?? 2.5;
  const baseElevation = opts.elevation ?? 12 * DEG;
  const frameBody = opts.frameBody ?? true;
  const distanceRadii = opts.distanceRadii ?? CHASE_DISTANCE_PER_RADIUS;

  let initialised = false;
  let vesselId = '';
  let refMode: RefMode = 'surface';
  let refBody = '';
  let azimuth = 0;
  // The azimuth is the default one (and follows the sun in orbit mode) until the player turns the camera.
  let autoAzimuth = true;
  // The default view may roll (a small disc beside the vehicle) until the player turns or tilts the camera.
  let autoRoll = true;
  let roll = 0;
  // The player's offset from the reference elevation and factor on the default distance.
  let pitch = 0;
  let zoom = 1;
  let distance = 0;
  // The default distance the camera is at, following `chaseAutoDistance` over about a second (staging).
  let autoDistance = 0;
  // Swing from a placement that was (direction to the eye and frame, ROOT, frozen) to the current one, progress 0..1.
  let swing: { dir: Vec3; frame: Quat; t: number; seconds: number } | null = null;
  let pendingOrbit: { azimuth: number; elevation: number; distance: number } | null = null;
  let pendingReset = false;
  // The last placement handed out (for the start of a swing).
  let lastDir: Vec3 | null = null;
  let lastFrame: Quat | null = null;

  const angularRadius = (v: VesselSnapshot): number => {
    const r = v3.len(v.r);
    const radius = bodyDef(defs, v.bodyId).radius;
    return r > radius ? Math.asin(radius / r) : Math.PI / 2;
  };
  const referenceElevation = (s: SimSnapshot, v: VesselSnapshot): number =>
    frameBody ? chaseReferenceElevation(angularRadius(v), fovY, baseElevation, roll / CHASE_DISC_ROLL) : baseElevation;

  /**
   * Azimuth of the eye on the sunward side of the vessel, CHASE_SUN_OFFSET off the sun's line on the side
   * nearer to `near`; null where the sun stands too close to the vertical to give a side.
   */
  const sunAzimuth = (s: SimSnapshot, v: VesselSnapshot, frame: Quat, near: number): number | null => {
    const local = quat.rotateInv(frame, bodyById(s, v.bodyId).sunDir);
    if (Math.hypot(local.x, local.y) < CHASE_SUN_HORIZONTAL) return null;
    const sun = Math.atan2(local.y, local.x);
    const a = sun + CHASE_SUN_OFFSET;
    const b = sun - CHASE_SUN_OFFSET;
    return Math.abs(wrapAngle(a - near)) <= Math.abs(wrapAngle(b - near)) ? a : b;
  };

  /**
   * Azimuth of the default view: behind the nose when it is not vertical, else facing the ventral side; in
   * orbit mode the sunward side nearest to that.
   */
  const defaultAzimuth = (s: SimSnapshot, v: VesselSnapshot, frame: Quat): number => {
    const byNose = noseAzimuth(s, v, frame);
    return frameBody && refMode === 'orbit' ? (sunAzimuth(s, v, frame, byNose) ?? byNose) : byNose;
  };

  const noseAzimuth = (s: SimSnapshot, v: VesselSnapshot, frame: Quat): number => {
    // Standing on a surface (on the pad, landed) a vertical vessel is seen from its starboard side instead: a
    // launch site's umbilical tower stands off the ventral side, and looking through its lattice hides the
    // vehicle (request app-integration-3).
    const nose = quat.rotate(v.q, v3.unitY());
    const up = quat.rotate(frame, v3.unitZ());
    let h = v3.reject(v3.neg(nose), up);
    const standing = v.situation === 'prelaunch' || v.situation === 'landed';
    if (v3.len(h) < 0.2) h = v3.reject(quat.rotate(v.q, standing ? v3.unitX() : v3.new(0, 0, -1)), up);
    if (v3.len(h) < 1e-6) h = quat.rotate(frame, v3.unitX());
    return anglesOf(frame, v3.normalize(h)).azimuth;
  };

  const init = (s: SimSnapshot, v: VesselSnapshot): void => {
    vesselId = v.id;
    refMode = s.navball.mode;
    refBody = v.bodyId;
    swing = null;
    lastDir = null;
    lastFrame = null;
    pitch = 0;
    zoom = 1;
    autoAzimuth = true;
    autoRoll = true;
    roll = frameBody ? chaseReferenceRoll(angularRadius(v)) : 0;
    autoDistance = chaseAutoDistance(defs, v, distanceRadii);
    distance = autoDistance;
    azimuth = defaultAzimuth(s, v, chaseReferenceFrame(s, v, refMode));
    initialised = true;
  };

  const groundRadius = (s: SimSnapshot, v: VesselSnapshot, eyeRoot: Vec3): { centre: Vec3; radius: number } => {
    const body = bodyById(s, v.bodyId);
    const def = bodyDef(defs, v.bodyId);
    let ground = def.radius;
    if (opts.terrain && def.terrain) {
      const rel = v3.sub(eyeRoot, body.rRoot);
      const dirFixed = v3.normalize(quat.rotateInv(body.qFixedToRoot, rel));
      ground = def.radius + opts.terrain.heightAt(def.id, dirFixed, 0.5);
    }
    if (def.ocean) ground = Math.max(ground, def.radius + def.ocean.seaLevel);
    return { centre: body.rRoot, radius: ground };
  };

  const startSwing = (seconds: number): void => {
    if (lastDir && lastFrame) swing = { dir: lastDir, frame: lastFrame, t: 0, seconds };
  };

  return {
    mode: 'chase',
    kind: 'external',
    get distance() {
      return distance;
    },
    get offsets() {
      return { azimuth, pitch, zoom };
    },
    get autoAzimuth() {
      return autoAzimuth;
    },
    get roll() {
      return roll;
    },
    isAvailable: (s) => s.vessels.some((x) => x.id === s.activeVesselId),
    setOrbit(az, el, dist) {
      pendingOrbit = { azimuth: az, elevation: el, distance: dist };
    },
    resetView() {
      pendingReset = true;
    },
    activate(from, s) {
      // What the player set stays with the rig through the cockpit and the map; a first activation, or another
      // vessel, starts from the defaults. (The view manager blends the switch itself.)
      const v = activeVessel(s);
      if (!initialised || v.id !== vesselId) init(s, v);
      else {
        swing = null;
        lastDir = null;
        lastFrame = null;
      }
      if (opts.startBehindPreviousView && from && from.kind !== 'map') {
        const a = anglesOf(chaseReferenceFrame(s, v, refMode), v3.neg(quat.rotate(from.qViewToRoot, { x: 0, y: 0, z: -1 })));
        azimuth = a.azimuth;
        autoAzimuth = false;
        autoRoll = false;
        roll = 0;
        pitch = clamp(a.elevation, -MAX_ELEVATION, MAX_ELEVATION) - referenceElevation(s, v);
      }
    },
    update(s: SimSnapshot, input: CameraInput, realDt: number): CameraState {
      const v = activeVessel(s);
      if (!initialised || v.id !== vesselId) init(s, v);
      const lim = chaseDistanceLimits(defs, v);
      // What is left after a separation is approached over a second, not in a snap.
      const autoNow = chaseAutoDistance(defs, v, distanceRadii);
      autoDistance = autoDistance > 0 ? Math.exp(Math.log(autoDistance) + (Math.log(autoNow) - Math.log(autoDistance)) * approach(realDt, CHASE_AUTO_SECONDS)) : autoNow;
      const auto = autoDistance;

      // Navball-mode change: the two frames share their vertical; the azimuth is re-expressed and nothing moves.
      if (s.navball.mode !== refMode && v.bodyId === refBody) {
        const dir = offsetDir(chaseReferenceFrame(s, v, refMode), azimuth, 0);
        refMode = s.navball.mode;
        azimuth = anglesOf(chaseReferenceFrame(s, v, refMode), dir).azimuth;
      }
      // Another body (sphere of influence): the same angles in its frame, reached in a swing.
      if (v.bodyId !== refBody) {
        refBody = v.bodyId;
        refMode = s.navball.mode;
        startSwing(CHASE_BODY_BLEND_SECONDS);
      }

      // The roll of the default view: in for a small disc, out when the player has taken the camera.
      if (input.yaw !== 0 || input.pitch !== 0) autoRoll = false;
      const before = referenceElevation(s, v);
      const rollTarget = autoRoll && frameBody ? chaseReferenceRoll(angularRadius(v)) : 0;
      roll += (rollTarget - roll) * approach(realDt, CHASE_ROLL_SECONDS);
      if (Math.abs(rollTarget - roll) < 1e-6) roll = rollTarget;
      let ref = referenceElevation(s, v);
      // (What the player set is an elevation: it stays where it is while the reference moves with the roll.)
      if (!autoRoll && ref !== before) pitch += before - ref;
      // Player input (grab-the-scene convention: positive yaw turns the view right).
      if (input.yaw !== 0) {
        azimuth -= input.yaw;
        autoAzimuth = false;
      } else if (autoAzimuth && frameBody && refMode === 'orbit') {
        // The default azimuth keeps the sun behind the camera as the vessel goes round its orbit.
        const want = sunAzimuth(s, v, chaseReferenceFrame(s, v, refMode), azimuth);
        if (want !== null) {
          const rate = CHASE_SUN_RATE * Math.max(0, realDt);
          azimuth += clamp(wrapAngle(want - azimuth) * approach(realDt, CHASE_SUN_SECONDS), -rate, rate);
        }
      }
      if (input.pitch !== 0) pitch = clamp(ref + pitch - input.pitch, -MAX_ELEVATION, MAX_ELEVATION) - ref;
      if (input.zoom > 0 && Number.isFinite(input.zoom) && input.zoom !== 1) {
        // The zoom stops at the vehicle's limits, so that the way back starts at once.
        zoom = clamp(auto * zoom * input.zoom, lim.min, lim.max) / auto;
      }
      let snap = false;
      if (pendingReset) {
        startSwing(CHASE_BODY_BLEND_SECONDS / 2);
        azimuth = defaultAzimuth(s, v, chaseReferenceFrame(s, v, refMode));
        autoAzimuth = true;
        autoRoll = true;
        pitch = 0;
        zoom = 1;
        pendingReset = false;
      }
      if (pendingOrbit) {
        azimuth = pendingOrbit.azimuth;
        autoAzimuth = false;
        autoRoll = false;
        roll = 0;
        ref = referenceElevation(s, v);
        pitch = clamp(pendingOrbit.elevation, -MAX_ELEVATION, MAX_ELEVATION) - ref;
        zoom = clamp(pendingOrbit.distance, lim.min, lim.max) / auto;
        swing = null;
        snap = true;
        pendingOrbit = null;
      }
      const elevation = clamp(ref + pitch, -MAX_ELEVATION, MAX_ELEVATION);
      const distanceTarget = clamp(auto * zoom, lim.min, lim.max);
      distance = snap || !(distance > 0) ? distanceTarget : clamp(Math.exp(Math.log(distance) + (Math.log(distanceTarget) - Math.log(distance)) * approach(realDt, 0.12)), lim.min, lim.max);

      let frame = chaseReferenceFrame(s, v, refMode);
      let dir = offsetDir(frame, azimuth, elevation);
      if (swing) {
        swing.t = Math.min(1, swing.t + Math.max(0, realDt) / swing.seconds);
        const k = smoothBlend(swing.t);
        frame = quat.normalize(quat.slerp(swing.frame, frame, k));
        dir = slerpDir(swing.dir, dir, k);
        if (swing.t >= 1) swing = null;
      }
      lastDir = dir;
      lastFrame = frame;

      const target = vesselComRoot(v);
      let eye = v3.addScaled(target, dir, distance);
      // Never below the ground: lift the eye radially to `clearance` above the surface under it.
      const g = groundRadius(s, v, eye);
      const rel = v3.sub(eye, g.centre);
      const r = v3.len(rel);
      if (r < g.radius + clearance) eye = v3.addScaled(g.centre, rel, (g.radius + clearance) / r);

      const up = quat.rotate(frame, v3.unitZ());
      // The roll turns the camera about its own axis (view +Z points at the viewer): the body below goes to the left.
      const level = lookRotation(v3.sub(target, eye), up);
      return {
        mode: 'chase',
        kind: 'external',
        positionRoot: eye,
        qViewToRoot: roll === 0 ? level : quat.normalize(quat.mul(level, quat.fromAxisAngle(v3.unitZ(), roll))),
        fovY,
        insideVesselId: null,
        focusVesselId: v.id,
        focusBodyId: v.bodyId,
        exposureCompensation: 0,
        minEv100: null,
        fillLight: 0,
      };
    },
  };
}
