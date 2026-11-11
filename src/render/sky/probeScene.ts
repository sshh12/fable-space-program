/**
 * The environment probe's scene, in float64: which bodies it sees, from where, with what weight, and a CPU
 * evaluation of the same radiance function for airless, cloudless scenes (used by tests as the brute-force
 * reference of the GPU probe and its SH9 irradiance).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { FrameContext } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { v3, type Vec3, type Vec3Tuple } from '@/core/math';
import { MAX_BODIES, discVisibleFraction, nearestBody, planetshineAt } from '@/render/core';
import { cubeTexelDirection, cubeTexelSolidAngle, planetshineWeight, shBasis, SH_COSINE_LOBE } from './photometry';

export interface ProbeBody {
  id: string;
  /** Index into FrameContext.bodies (= frame uniform body index). */
  frameIndex: number;
  /** Body centre relative to the probe, ROOT axes (m). */
  centre: Vec3;
  /**
   * Radius of the sphere that stands for the body's ground in the probe (m): the reference radius, except for
   * the active vessel's own body where the ground under the vessel lies below it (probeGroundSphere).
   */
  radius: number;
  /** Probe height above that sphere (m, float64; > 0). */
  altitude: number;
  /** Share of the body's light that the probe carries: 1 - the render core's planetshine weight for it. */
  weight: number;
}

export interface ProbeScene {
  /** Probe position (ROOT) and relative to the camera. */
  positionRoot: Vec3;
  relCam: Vec3;
  bodies: ProbeBody[];
  /** Frame index of the body whose sky-view table the camera sees (nearest atmosphere body), or -1. */
  skyViewBody: number;
  /** Distance camera - probe (m): the sky-view table is evaluated at the camera. */
  cameraOffset: number;
}

/**
 * Bodies the render core lights a surface at `point` with as planetshine, and their weights: the receiver is
 * the nearest body when the point is lower than half its radius above it (then the list is computed at that
 * body's centre), else free space at the camera (deferred lighting, RENDER_API section 7).
 */
export function planetshineWeights(point: Vec3, cameraRoot: Vec3, snapshot: SimSnapshot, defs: DefLibrary): Map<string, number> {
  const out = new Map<string, number>();
  const near = nearestBody(point, snapshot, defs);
  let receiver: Vec3;
  let list: { bodyId: string }[];
  if (near && near.altitude < 0.5 * near.def.radius) {
    receiver = near.body.rRoot;
    list = planetshineAt(near.body.rRoot, near.body.id, snapshot, defs);
  } else {
    const camNear = nearestBody(cameraRoot, snapshot, defs);
    receiver = cameraRoot;
    list = planetshineAt(cameraRoot, camNear && camNear.altitude < 0.5 * camNear.def.radius ? camNear.body.id : null, snapshot, defs);
  }
  for (const s of list) {
    const b = snapshot.bodies.find((x) => x.id === s.bodyId);
    const def = defs.bodies[s.bodyId];
    if (b && def) out.set(s.bodyId, planetshineWeight(v3.dist(receiver, b.rRoot), def.radius));
  }
  return out;
}

/** Height of the probe point above the ground it stands on, at least (m): the vessel's origin is above its lowest contact point. */
export const PROBE_MIN_GROUND_HEIGHT = 1;

/**
 * The sphere that stands for a body's ground in the probe seen from `distance` (m) from its centre, with the
 * ground `groundHeight` (m) below the probe point (the active vessel's radar altitude), and the probe's height
 * above it. The reference sphere, except where the ground lies below it (a crater floor or basin under a
 * landing site, a capsule floating with its origin under the sea surface): there the sphere goes through the
 * actual ground while the probe is below the reference radius, and rises back to the reference radius as the
 * probe climbs above it, reaching it once the probe is as high above the reference radius as the ground lies
 * below it. Continuous in position; in orbit (higher than any depression is deep) it is the reference sphere.
 * The probe is never less than PROBE_MIN_GROUND_HEIGHT above the sphere.
 */
export function probeGroundSphere(referenceRadius: number, distance: number, groundHeight: number): { radius: number; height: number } {
  const hg = Math.max(groundHeight, PROBE_MIN_GROUND_HEIGHT);
  const hd = distance - referenceRadius;
  const depth = Math.max(0, hg - hd);
  const lower = Math.max(0, depth - Math.max(hd, 0));
  return { radius: referenceRadius - lower, height: hd + lower };
}

/** The probe scene for this frame: the active vessel (or the camera when there is none) and the frame's first bodies. */
export function probeSceneOf(frame: FrameContext, defs: DefLibrary): ProbeScene {
  const s = frame.snapshot;
  const vessel = s.vessels.find((v) => v.id === s.activeVesselId);
  const positionRoot = vessel ? vessel.rRoot : frame.camera.positionRoot;
  const relCam = v3.sub(positionRoot, frame.camera.positionRoot);
  const shine = planetshineWeights(positionRoot, frame.camera.positionRoot, s, defs);
  const bodies: ProbeBody[] = [];
  let skyViewBody = -1;
  let skyViewAlt = Infinity;
  const count = Math.min(MAX_BODIES, frame.bodies.length);
  for (let i = 0; i < count; i++) {
    const pose = frame.bodies[i]!;
    const def = defs.bodies[pose.id];
    if (!def || pose.id === frame.sun.bodyId) continue;
    const snap = s.bodies.find((b) => b.id === pose.id)!;
    const centre = v3.sub(snap.rRoot, positionRoot);
    const distance = v3.len(centre);
    // The read-outs' radar altitude is the active vessel's height above the terrain or sea of its central body.
    const ground = vessel && vessel.bodyId === pose.id ? probeGroundSphere(def.radius, distance, s.readouts.altitudeRadar) : { radius: def.radius, height: distance - def.radius };
    bodies.push({ id: pose.id, frameIndex: i, centre, radius: ground.radius, altitude: ground.height, weight: 1 - (shine.get(pose.id) ?? 0) });
    if (def.render.atmosphere && pose.cameraAltitude < skyViewAlt) {
      skyViewAlt = pose.cameraAltitude;
      skyViewBody = i;
    }
  }
  return { positionRoot, relCam, bodies, skyViewBody, cameraOffset: v3.len(relCam) };
}

// ---------------------------------------------------------------------------------- CPU reference (vacuum)

export interface ReferenceBody {
  centre: Vec3;
  radius: number;
  weight: number;
  albedo: Vec3Tuple;
  /** Unit direction body -> star. */
  sunDir: Vec3;
}
export interface ReferenceScene {
  bodies: ReferenceBody[];
  /** Solar colour x illuminance (lux) and angular radius of the star. */
  sunE: Vec3Tuple;
  sunRadius: number;
  /** Constant radiance of every direction that misses a body (cd/m^2), e.g. the Milky Way level. */
  background: Vec3Tuple;
}

function hit(d: Vec3, b: ReferenceBody): number {
  const bq = v3.dot(d, b.centre);
  const c = v3.lenSq(b.centre) - b.radius * b.radius;
  const disc = bq * bq - c;
  if (c <= 0 || bq <= 0 || disc < 0) return -1;
  return bq - Math.sqrt(disc);
}

/** Radiance (cd/m^2) the probe holds along unit direction d for an airless, cloudless scene (same model as PROBE_FACE_CS). */
export function referenceRadiance(scene: ReferenceScene, d: Vec3): Vec3Tuple {
  let best = Infinity;
  let bi = -1;
  scene.bodies.forEach((b, i) => {
    const t = hit(d, b);
    if (t > 0 && t < best) {
      best = t;
      bi = i;
    }
  });
  if (bi < 0) return [...scene.background];
  const b = scene.bodies[bi]!;
  const p = v3.scale(d, best);
  const n = v3.normalize(v3.sub(p, b.centre));
  const muS = v3.dot(n, b.sunDir);
  let vis = discVisibleFraction(scene.sunRadius, Math.PI / 2, v3.angle(v3.neg(n), b.sunDir));
  scene.bodies.forEach((o, j) => {
    if (j === bi) return;
    const to = v3.sub(o.centre, p);
    vis *= discVisibleFraction(scene.sunRadius, Math.asin(Math.min(1, o.radius / v3.len(to))), v3.angle(to, b.sunDir));
  });
  const e = muS > 0 ? vis * muS : 0;
  const out: Vec3Tuple = [0, 0, 0];
  for (let c = 0; c < 3; c++) out[c] = ((scene.sunE[c]! * e * b.albedo[c]!) / Math.PI) * b.weight + scene.background[c]! * (1 - b.weight);
  return out;
}

/** Irradiance coefficients (9 x rgb, the 'env.sh9' convention) of a radiance function, from a cube of `size`. */
export function projectSh(radiance: (d: Vec3) => Vec3Tuple, size = 64): Vec3Tuple[] {
  const acc: Vec3Tuple[] = Array.from({ length: 9 }, () => [0, 0, 0] as Vec3Tuple);
  const basis = new Array<number>(9);
  for (let face = 0; face < 6; face++) {
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const d = cubeTexelDirection(face, x, y, size);
        const w = cubeTexelSolidAngle(x, y, size);
        const L = radiance(d);
        shBasis(d, basis);
        for (let k = 0; k < 9; k++) for (let c = 0; c < 3; c++) acc[k]![c] = acc[k]![c]! + L[c]! * basis[k]! * w;
      }
    }
  }
  return acc.map((c, k) => c.map((v) => v * SH_COSINE_LOBE[k]!) as Vec3Tuple);
}

/** Exact irradiance (lux) on a surface with unit normal n: integral of L max(n . w, 0) over the sphere. */
export function bruteForceIrradiance(radiance: (d: Vec3) => Vec3Tuple, n: Vec3, steps = 400): Vec3Tuple {
  // Integrate over the hemisphere around n in (cos theta, phi), uniform in solid angle.
  const t = v3.normalize(v3.anyOrthogonal(n));
  const b = v3.cross(n, t);
  const e: Vec3Tuple = [0, 0, 0];
  const nPhi = 2 * steps;
  for (let i = 0; i < steps; i++) {
    const ct = (i + 0.5) / steps;
    const st = Math.sqrt(1 - ct * ct);
    for (let j = 0; j < nPhi; j++) {
      const phi = ((j + 0.5) * 2 * Math.PI) / nPhi;
      const d = v3.add(v3.add(v3.scale(t, st * Math.cos(phi)), v3.scale(b, st * Math.sin(phi))), v3.scale(n, ct));
      const L = radiance(d);
      for (let c = 0; c < 3; c++) e[c] = e[c]! + L[c]! * ct;
    }
  }
  const dOmega = (2 * Math.PI) / (steps * nPhi);
  return [e[0] * dOmega, e[1] * dOmega, e[2] * dOmega];
}
