/**
 * Float64 frame mathematics of the render core: TAA jitter, camera-relative poses, the star as seen from
 * the camera, eclipse geometry and planetshine. Pure functions (no GPU, no DOM): unit-tested in vitest.
 */
import type { BodyDef, DefLibrary } from '@/core/contracts/defs';
import type { BodyPose, CameraState, VesselPose } from '@/core/contracts/render';
import { NEAR_PLANE } from '@/core/contracts/render';
import type { BodySnapshot, SimSnapshot } from '@/core/contracts/sim';
import { mat4, quat, v3, type Mat4, type Vec3, type Vec3Tuple } from '@/core/math';

/** Radical inverse of `index` (1-based) in `base`. */
export function halton(index: number, base: number): number {
  let f = 1;
  let r = 0;
  let i = index;
  while (i > 0) {
    f /= base;
    r += f * (i % base);
    i = Math.floor(i / base);
  }
  return r;
}

/** Halton(2, 3) sub-pixel jitter in [-0.5, 0.5) render pixels (x right, y down) for a sequence of `length` samples. */
export function taaJitter(frameIndex: number, length = 8): [number, number] {
  const i = (((frameIndex % length) + length) % length) + 1;
  return [halton(i, 2) - 0.5, halton(i, 3) - 0.5];
}

/** Sequence length for a given internal resolution scale: 8 at native, more when upscaling (8 / scale^2, capped). */
export function jitterSequenceLength(renderScale: number): number {
  return Math.min(32, Math.max(8, Math.round(8 / (renderScale * renderScale))));
}

export interface Projection {
  proj: Mat4;
  projUnjittered: Mat4;
  /** Jitter in NDC units as contained in `proj`. */
  jitterNdc: [number, number];
  tanHalfFovX: number;
  tanHalfFovY: number;
}

/**
 * THE projection (reversed-Z, infinite far, near = NEAR_PLANE) and its jittered copy. The jitter is added to
 * clip xy (clip.xy += jitterNdc * clip.w), so the depth mapping is untouched.
 */
export function buildProjection(fovY: number, width: number, height: number, jitterPx: readonly [number, number]): Projection {
  const aspect = width / height;
  const projUnjittered = mat4.perspectiveReversedZInfinite(fovY, aspect, NEAR_PLANE);
  const proj = new Float64Array(projUnjittered);
  const jx = (2 * jitterPx[0]) / width;
  const jy = (-2 * jitterPx[1]) / height;
  // clip.w = -z_view, so adding j * w means subtracting j from the z column.
  proj[8] = -jx;
  proj[9] = -jy;
  const tanY = Math.tan(fovY / 2);
  return { proj, projUnjittered, jitterNdc: [jx, jy], tanHalfFovX: tanY * aspect, tanHalfFovY: tanY };
}

export function cameraBasis(camera: CameraState): { right: Vec3; up: Vec3; forward: Vec3 } {
  return {
    right: quat.rotate(camera.qViewToRoot, { x: 1, y: 0, z: 0 }),
    up: quat.rotate(camera.qViewToRoot, { x: 0, y: 1, z: 0 }),
    forward: quat.rotate(camera.qViewToRoot, { x: 0, y: 0, z: -1 }),
  };
}

/**
 * Camera-relative body poses in float64. `prev*` values are relative to the PREVIOUS camera eye, so
 * motion vectors are exact under body rotation and orbital motion.
 */
export function buildBodyPoses(snapshot: SimSnapshot, prevSnapshot: SimSnapshot, camera: CameraState, prevCamera: CameraState, defs: DefLibrary): BodyPose[] {
  const prevById = new Map(prevSnapshot.bodies.map((b) => [b.id, b]));
  return snapshot.bodies.map((b) => {
    const p = prevById.get(b.id) ?? b;
    const rel = v3.sub(camera.positionRoot, b.rRoot);
    const cameraFixed = quat.rotateInv(b.qFixedToRoot, rel);
    const radius = defs.bodies[b.id]?.radius ?? 0;
    return {
      id: b.id,
      centerRelCam: v3.sub(b.rRoot, camera.positionRoot),
      qFixedToRoot: b.qFixedToRoot,
      prevCenterRelCam: v3.sub(p.rRoot, prevCamera.positionRoot),
      prevQFixedToRoot: p.qFixedToRoot,
      cameraFixed,
      cameraAltitude: v3.len(cameraFixed) - radius,
      sunDir: b.sunDir,
    };
  });
}

export function buildVesselPoses(snapshot: SimSnapshot, prevSnapshot: SimSnapshot, camera: CameraState, prevCamera: CameraState): VesselPose[] {
  const prevById = new Map(prevSnapshot.vessels.map((v) => [v.id, v]));
  return snapshot.vessels.map((v) => {
    const p = prevById.get(v.id);
    const originRelCam = v3.sub(v.rRoot, camera.positionRoot);
    return {
      id: v.id,
      originRelCam,
      q: v.q,
      // A vessel that did not exist last frame (staging) is treated as static relative to the camera.
      prevOriginRelCam: p ? v3.sub(p.rRoot, prevCamera.positionRoot) : originRelCam,
      prevQ: p ? p.q : v.q,
    };
  });
}

export interface SunInfo {
  dirRoot: Vec3;
  illuminance: number;
  color: Vec3Tuple;
  angularRadius: number;
  bodyId: string;
  distance: number;
}

/** The star as seen from a point (ROOT frame): direction, unoccluded illuminance from BodyDef.emission, angular radius. */
export function sunAt(point: Vec3, snapshot: SimSnapshot, defs: DefLibrary): SunInfo {
  const star = snapshot.bodies.find((b) => b.id === snapshot.starId);
  const def = star ? defs.bodies[star.id] : undefined;
  if (!star || !def?.emission) {
    return { dirRoot: { x: 1, y: 0, z: 0 }, illuminance: 0, color: [1, 1, 1], angularRadius: 0.00465, bodyId: snapshot.starId, distance: 1.496e11 };
  }
  const to = v3.sub(star.rRoot, point);
  const d = v3.len(to);
  const e = def.emission;
  return {
    dirRoot: v3.scale(to, 1 / d),
    illuminance: e.illuminance * (e.refDistance / d) ** 2,
    color: e.color,
    angularRadius: Math.asin(Math.min(1, e.radius / d)),
    bodyId: star.id,
    distance: d,
  };
}

/**
 * Visible fraction of a disc of angular radius `rs` whose centre is `d` radians from the centre of an
 * occluding disc of angular radius `ro` (exact lens area; total, annular and penumbral cases). Mirrors the
 * WGSL `discVisibleFraction` of the eclipse chunk.
 */
export function discVisibleFraction(rs: number, ro: number, d: number): number {
  if (d >= rs + ro) return 1;
  if (d <= ro - rs) return 0;
  if (d <= rs - ro) return 1 - (ro * ro) / (rs * rs);
  if (ro > 40 * rs) {
    const x = Math.max(-1, Math.min(1, (d - ro) / rs));
    return 1 - (Math.acos(x) - x * Math.sqrt(Math.max(0, 1 - x * x))) / Math.PI;
  }
  const a1 = Math.acos(Math.max(-1, Math.min(1, (d * d + rs * rs - ro * ro) / (2 * d * rs))));
  const a2 = Math.acos(Math.max(-1, Math.min(1, (d * d + ro * ro - rs * rs) / (2 * d * ro))));
  const k = Math.max(0, (-d + rs + ro) * (d + rs - ro) * (d - rs + ro) * (d + rs + ro));
  const lens = rs * rs * a1 + ro * ro * a2 - 0.5 * Math.sqrt(k);
  return Math.max(0, Math.min(1, 1 - lens / (Math.PI * rs * rs)));
}

/** Fraction of the solar disc visible from a ROOT-frame point against every non-star body. */
export function sunVisibilityAt(point: Vec3, snapshot: SimSnapshot, defs: DefLibrary, sun: SunInfo = sunAt(point, snapshot, defs)): number {
  let vis = 1;
  for (const b of snapshot.bodies) {
    if (b.id === snapshot.starId) continue;
    const def = defs.bodies[b.id];
    if (!def) continue;
    const to = v3.sub(b.rRoot, point);
    const dist = v3.len(to);
    const ro = Math.asin(Math.min(1, def.radius / Math.max(dist, 1e-3)));
    const sep = v3.angle(to, sun.dirRoot);
    vis *= discVisibleFraction(sun.angularRadius, ro, sep);
  }
  return vis;
}

/** Phase function of a Lambert sphere, 1 at full phase (alpha = 0), 0 at new (alpha = pi). */
export const lambertSpherePhase = (alpha: number): number => (Math.sin(alpha) + (Math.PI - alpha) * Math.cos(alpha)) / Math.PI;

export interface ShineLight {
  bodyId: string;
  /** Unit direction from the receiver to the shining body (ROOT axes). */
  dir: Vec3;
  /** Illuminance at the receiver, lux, linear sRGB. */
  illuminance: Vec3Tuple;
  /**
   * Angular radius of the shining body's disc seen from the point the light was evaluated at (rad): the
   * source size of the occlusion test (request sky-lighting-8). Absent = a point source.
   */
  angularRadius?: number;
}

const luma = (c: Readonly<Vec3Tuple>): number => 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];

/**
 * Fraction of the disc of body `shiningId` that every OTHER non-star body of the snapshot leaves visible from
 * a ROOT-frame point (request sky-lighting-8): the overlap of discs used by `sunVisibilityAt`, with the
 * shining body's own angular radius as the source. 0 when the Moon is behind the Earth seen from low orbit,
 * 0.5 when the limb halves it. The WGSL twin is `shineVisibility()` of the eclipse chunk.
 */
export function shineVisibleFraction(point: Vec3, shiningId: string, snapshot: SimSnapshot, defs: DefLibrary): number {
  const shining = snapshot.bodies.find((b) => b.id === shiningId);
  const sdef = defs.bodies[shiningId];
  if (!shining || !sdef) return 1;
  const toS = v3.sub(shining.rRoot, point);
  const ds = v3.len(toS);
  const rs = Math.asin(Math.min(1, sdef.radius / Math.max(ds, 1e-3)));
  let vis = 1;
  for (const b of snapshot.bodies) {
    if (b.id === snapshot.starId || b.id === shiningId) continue;
    const def = defs.bodies[b.id];
    if (!def) continue;
    const to = v3.sub(b.rRoot, point);
    const dist = v3.len(to);
    const ro = Math.asin(Math.min(1, def.radius / Math.max(dist, 1e-3)));
    vis *= discVisibleFraction(rs, ro, v3.angle(to, toS));
    if (vis === 0) return 0;
  }
  return vis;
}

/**
 * Planetshine at a ROOT-frame point: every non-star body other than `excludeBodyId` lights the receiver
 * with E = E_sun(at the body) x geometricAlbedo x (R / d)^2 x Phi(phase), coloured by its mean visible
 * colour. The far-field formula fades out between 2 R and 4 R from the centre (closer than that the
 * environment probe carries the light). Strongest first, at most `max` entries.
 *
 * The lights carry no occlusion: the renderer evaluates them once per receiver body (at its centre) and the
 * deferred pass tests every shaded point with `shineVisibility()`. A caller that lights one point itself
 * passes that point as `visibleFrom`: each light is then multiplied by `shineVisibleFraction(visibleFrom)`
 * (the body the point stands on, `excludeBodyId` included, hides what is below its horizon), before the
 * strongest are chosen.
 */
export function planetshineAt(point: Vec3, excludeBodyId: string | null, snapshot: SimSnapshot, defs: DefLibrary, max = 2, visibleFrom?: Vec3): ShineLight[] {
  const out: (ShineLight & { e: number })[] = [];
  const star = snapshot.bodies.find((b) => b.id === snapshot.starId);
  const emission = star ? defs.bodies[star.id]?.emission : null;
  if (!star || !emission) return [];
  for (const b of snapshot.bodies) {
    if (b.id === snapshot.starId || b.id === excludeBodyId) continue;
    const def: BodyDef | undefined = defs.bodies[b.id];
    if (!def || def.render.geometricAlbedo <= 0) continue;
    const to = v3.sub(b.rRoot, point);
    const d = v3.len(to);
    const x = (d / def.radius - 2) / 2;
    const fade = x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x);
    if (fade === 0) continue;
    const eSun = emission.illuminance * (emission.refDistance / b.sunDistance) ** 2;
    const alpha = v3.angle(b.sunDir, v3.neg(to));
    const visible = visibleFrom ? shineVisibleFraction(visibleFrom, b.id, snapshot, defs) : 1;
    if (visible <= 0) continue;
    const e = eSun * def.render.geometricAlbedo * (def.radius / d) ** 2 * lambertSpherePhase(alpha) * fade * visible;
    const mc = def.render.meanColor;
    const l = Math.max(luma(mc), 1e-6);
    out.push({ bodyId: b.id, dir: v3.scale(to, 1 / d), illuminance: [(e * mc[0]) / l, (e * mc[1]) / l, (e * mc[2]) / l], angularRadius: Math.asin(Math.min(1, def.radius / d)), e });
  }
  out.sort((a, b) => b.e - a.e);
  return out.slice(0, max).map(({ bodyId, dir, illuminance, angularRadius }) => ({ bodyId, dir, illuminance, angularRadius }));
}

/** Body of the snapshot whose surface is nearest to a ROOT-frame point (stars excluded). */
export function nearestBody(point: Vec3, snapshot: SimSnapshot, defs: DefLibrary): { body: BodySnapshot; def: BodyDef; altitude: number } | null {
  let best: { body: BodySnapshot; def: BodyDef; altitude: number } | null = null;
  for (const b of snapshot.bodies) {
    if (b.id === snapshot.starId) continue;
    const def = defs.bodies[b.id];
    if (!def) continue;
    const altitude = v3.dist(point, b.rRoot) - def.radius;
    if (!best || altitude < best.altitude) best = { body: b, def, altitude };
  }
  return best;
}

/** proj * view for a rotation-only view. */
export const viewProjOf = (proj: Mat4, view: Mat4): Mat4 => mat4.mul(proj, view);
