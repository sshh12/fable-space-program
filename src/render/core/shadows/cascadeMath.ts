/**
 * Sun shadow cascades, CPU side, float64 (ARCHITECTURE 10.1). Pure: no GPU, no DOM.
 *
 * A cascade is CAPTURED in the frame of its anchor (the body-fixed frame of the body it covers, or a
 * vessel frame): light basis, texel-snapped centre and extents are stored in anchor coordinates. The
 * matrix used for rendering and sampling is re-derived EVERY frame from the capture and the anchor's
 * current pose, so a cascade re-rendered only every 2nd / 4th / 8th frame stays registered to ground that
 * moves 7-30 m per frame in ROOT axes.
 *
 * The footprint of a cascade is a square around its focus, except for staggered camera cascades, whose
 * footprint is narrowed along v to the ground they shadow (`fitReceivers`): that is what keeps shadow
 * edges straight at low sun.
 */
import { quat, v3, type Mat4, type Quat, type Vec3 } from '@/core/math';

/** Camera-fitted cascade radii (m): logarithmic, 12 m .. 1500 km. Texel = 2 r / map size along u. */
export const CASCADE_RADII: readonly number[] = [12, 60, 300, 1500, 8000, 40000, 200000, 1500000];
export const MAX_CASCADES = 8;
/** Cascades below this index are always re-rendered every frame. */
export const ALWAYS_EVERY_FRAME = 2;
/**
 * Radius (m) of cascade 0 when it is anchored to the vessel the camera is inside. A cabin and the room for
 * its shadows fit in 6 m, and the eye is 0.4 to 1 m from the surfaces the sun patches fall on: half the
 * radius of the exterior cascade halves the texel (0.59 cm) and with it the smallest penumbra and the
 * grain of its filter (docs/requests/cockpit-4.md). Casters towards the sun are caught at any distance
 * (the depth range is pancaked); receivers farther than this (seen through a window) use cascade 1.
 */
export const INTERIOR_CASCADE_RADIUS = 6;
/** Upper bound on cascades re-rendered every frame (GPU cost guard). */
export const MAX_EVERY_FRAME = 4;
/** Staggered cascades are re-captured early when the sun has moved this much in the anchor frame (rad). */
export const SUN_DRIFT_LIMIT = (0.05 * Math.PI) / 180;
/** ... or when the camera has left the central part of a camera-fitted cascade (fraction of its radius). */
export const CAMERA_DRIFT_FRACTION = 0.15;
/** A body-fitted cascade is wanted for another body once its disc is larger than this on screen (px); it fades in from half of it. */
export const BODY_FIT_MIN_PIXELS = 64;
/**
 * Receiver fit of staggered camera cascades. Their footprint along v (the map axis in the vertical plane of
 * the light) is narrowed to the band the ground occupies: radiusV = radius x 2^(-k / 2), k = 0 .. BAND_LEVELS.
 */
export const BAND_LEVELS = 8;
/** A band is captured this much wider than the receivers need (factor on its half width): hysteresis against re-fitting. */
export const BAND_SLACK = 1.25;
/** The band axis follows the local vertical; the map is re-oriented when it has turned away by more than this (rad). */
export const BAND_ROLL_LIMIT = (10 * Math.PI) / 180;

export interface AnchorRef {
  kind: 'body' | 'vessel';
  id: string;
}

/** Pose of an anchor frame this frame: origin relative to the camera (ROOT axes) and anchor -> ROOT rotation. */
export interface AnchorPose {
  originRelCam: Vec3;
  q: Quat;
}

export interface CascadeCapture {
  key: string;
  fit: 'camera' | 'body';
  anchor: AnchorRef;
  /** Half extent of the orthographic footprint along lx, m. */
  radius: number;
  /** Half extent along ly, m: equal to `radius`, or smaller when the footprint is fitted to its receivers. */
  radiusV: number;
  /** World size of one texel along lx / along ly, m. */
  texelSize: number;
  texelSizeV: number;
  /** Half of the depth range along the light, m. */
  zHalf: number;
  /** Light basis in ANCHOR coordinates: lx = +u of the map, ly = up in the map, lz = towards the sun. */
  lx: Vec3;
  ly: Vec3;
  lz: Vec3;
  /** Texel-snapped centre in anchor coordinates (float64). */
  center: Vec3;
  /** The point the cascade was fitted around (the camera, or the body centre), anchor coordinates. */
  focus: Vec3;
  capturedFrame: number;
}

/** Footprint of a cascade that is fitted to its receivers instead of being a square around the focus. */
export interface CascadeShape {
  /** +u of the map in anchor coordinates (made orthogonal to the light on capture). */
  lx: Vec3;
  /** Half extent along v, m (at most the cascade radius). */
  radiusV: number;
  /** Offset of the footprint centre from the focus along v, m. */
  centerV: number;
}

/** Orthonormal light basis for a unit direction towards the sun, all in the same (anchor) frame. */
export function lightBasis(lz: Vec3): { lx: Vec3; ly: Vec3; lz: Vec3 } {
  const ref = Math.abs(lz.z) < 0.99 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  const lx = v3.normalize(v3.cross(ref, lz));
  return { lx, ly: v3.cross(lz, lx), lz };
}

/**
 * Fit a cascade around `focus` (anchor coordinates): the centre is snapped to whole texels along the light
 * basis so the map never crawls over geometry that is static in the anchor frame. With a `shape` the
 * footprint is a band: `shape.radiusV` high along v, centred `shape.centerV` from the focus, with the map
 * turned so that +u is `shape.lx`.
 */
export function captureCascade(
  key: string,
  fit: 'camera' | 'body',
  anchor: AnchorRef,
  focus: Vec3,
  sunDirAnchor: Vec3,
  radius: number,
  mapSize: number,
  frame: number,
  snap = true,
  previous: CascadeCapture | null = null,
  shape: CascadeShape | null = null,
): CascadeCapture {
  let basis = lightBasis(v3.normalize(sunDirAnchor));
  if (shape) {
    const lx = v3.normalize(v3.addScaled(shape.lx, basis.lz, -v3.dot(shape.lx, basis.lz)));
    basis = { lx, ly: v3.cross(basis.lz, lx), lz: basis.lz };
  }
  const { lx, ly, lz } = basis;
  const radiusV = shape ? Math.min(shape.radiusV, radius) : radius;
  const texelSize = (2 * radius) / mapSize;
  const texelSizeV = (2 * radiusV) / mapSize;
  // Snap RELATIVE to the previous capture of this cascade when there is one. The anchor origin is millions
  // of metres away, so snapping absolute coordinates would re-phase the grid every time the sun (and with
  // it the light basis) moves by a micro-radian; relative to a centre a few metres away the grid is stable
  // and static geometry sees whole-texel steps only.
  const usePrev = snap && previous !== null && previous.radius === radius && previous.radiusV === radiusV;
  const origin = usePrev ? previous.center : v3.zero();
  const rel = v3.sub(shape ? v3.addScaled(focus, ly, shape.centerV) : focus, origin);
  let cx = v3.dot(lx, rel);
  let cy = v3.dot(ly, rel);
  let cz = v3.dot(lz, rel);
  if (snap) {
    cx = Math.round(cx / texelSize) * texelSize;
    cy = Math.round(cy / texelSizeV) * texelSizeV;
    cz = Math.round(cz / texelSize) * texelSize;
  }
  const center = { x: origin.x + lx.x * cx + ly.x * cy + lz.x * cz, y: origin.y + lx.y * cx + ly.y * cy + lz.y * cz, z: origin.z + lx.z * cx + ly.z * cy + lz.z * cz };
  const zHalf = fit === 'body' ? radius : Math.max(2 * radius, 200);
  return { key, fit, anchor, radius, radiusV, texelSize, texelSizeV, zHalf, lx, ly, lz, center, focus, capturedFrame: frame };
}

/** The narrowest band half extent of the ladder radius x 2^(-k / 2), k = 0 .. BAND_LEVELS, that is at least `half`. */
export function bandRadius(radius: number, half: number): number {
  if (!(half < radius)) return radius;
  const k = Math.min(BAND_LEVELS, Math.floor(2 * Math.log2(radius / Math.max(half, 1e-9))));
  return radius * 2 ** (-k / 2);
}

/**
 * Range of v = dot(ly, p - focus) over the receivers of a camera-fitted cascade that holds body-fixed
 * casters only: the ground, i.e. the shell of the body between the radii rInner and rOuter (lowest and
 * highest terrain), inside the ball of radius `reach` around the focus. Everything in anchor coordinates
 * with the body centre at the origin. null when the shell does not meet the ball.
 *
 * On the sphere of radius rho the ball cuts a cap of half angle alpha around the local vertical, and a
 * linear function is extreme on a cap at the angles gamma -/+ alpha from its gradient (gamma = angle
 * between ly and the vertical), so each radius needs two cosines. The radii the ball reaches are sampled
 * at 17 values; the two points of the ball that are extreme along ly are added exactly when they lie in
 * the shell (they are the answer whenever the ball is small against the relief).
 */
export function receiverBand(focus: Vec3, ly: Vec3, reach: number, rInner: number, rOuter: number): { min: number; max: number } | null {
  const D = v3.len(focus);
  if (D < 1) return null;
  const lo = Math.max(rInner, D - reach);
  const hi = Math.min(rOuter, D + reach);
  if (!(hi >= lo)) return null;
  const gamma = Math.acos(Math.max(-1, Math.min(1, v3.dot(ly, focus) / D)));
  const v0 = -v3.dot(ly, focus);
  let min = Infinity;
  let max = -Infinity;
  for (let i = 0; i <= 16; i++) {
    const rho = lo + ((hi - lo) * i) / 16;
    const alpha = Math.acos(Math.max(-1, Math.min(1, (D * D + rho * rho - reach * reach) / (2 * D * rho))));
    max = Math.max(max, v0 + rho * Math.cos(Math.max(gamma - alpha, 0)));
    min = Math.min(min, v0 + rho * Math.cos(Math.min(gamma + alpha, Math.PI)));
  }
  for (const sign of [1, -1]) {
    const rho = v3.len(v3.addScaled(focus, ly, sign * reach));
    if (rho < rInner || rho > rOuter) continue;
    if (sign > 0) max = reach;
    else min = -reach;
  }
  return { min, max };
}

export interface CascadeMatrices {
  /** Camera-relative ROOT axes -> shadow clip (xy in [-1, 1]; z = 0 at the sun side .. 1), column-major float64. */
  viewProj: Mat4;
  /** World (ROOT) directions: towards the sun, +u of the map, +v of the map (texture y, down). */
  lightDirRoot: Vec3;
  axisURoot: Vec3;
  axisVRoot: Vec3;
}

/**
 * World-to-shadow matrix for THIS frame: capture matrix x motion of the anchor frame since capture.
 * Everything large (anchor origin 6.4e6 m from the centre, cascade centre in anchor coordinates) cancels
 * in float64 here; the result has only small translations and survives the narrowing to float32.
 */
export function cascadeMatrices(c: CascadeCapture, anchor: AnchorPose): CascadeMatrices {
  const Lx = quat.rotate(anchor.q, c.lx);
  const Ly = quat.rotate(anchor.q, c.ly);
  const Lz = quat.rotate(anchor.q, c.lz);
  const o = anchor.originRelCam;
  const tx = -(v3.dot(Lx, o) + v3.dot(c.lx, c.center)) / c.radius;
  const ty = -(v3.dot(Ly, o) + v3.dot(c.ly, c.center)) / c.radiusV;
  const zs = 1 / (2 * c.zHalf);
  const tz = 0.5 + (v3.dot(Lz, o) + v3.dot(c.lz, c.center)) * zs;
  const r = 1 / c.radius;
  const rv = 1 / c.radiusV;
  const m = new Float64Array(16);
  m[0] = Lx.x * r;
  m[4] = Lx.y * r;
  m[8] = Lx.z * r;
  m[12] = tx;
  m[1] = Ly.x * rv;
  m[5] = Ly.y * rv;
  m[9] = Ly.z * rv;
  m[13] = ty;
  m[2] = -Lz.x * zs;
  m[6] = -Lz.y * zs;
  m[10] = -Lz.z * zs;
  m[14] = tz;
  m[15] = 1;
  return { viewProj: m, lightDirRoot: Lz, axisURoot: Lx, axisVRoot: v3.neg(Ly) };
}

// ------------------------------------------------------------------------------------------- planning

export interface PlanBody {
  id: string;
  radius: number;
  /** Highest terrain above the reference radius, m (0 for a smooth body). */
  maxElevation: number;
  /** Lowest terrain relative to the reference radius, m (negative or 0; 0 when unknown or smooth). */
  minElevation?: number;
  hasTerrain: boolean;
  /** Body centre relative to the camera, ROOT axes. */
  centerRelCam: Vec3;
  qFixedToRoot: Quat;
  /** Unit direction body -> star, ROOT axes. */
  sunDirRoot: Vec3;
}

export interface PlanVessel {
  id: string;
  originRelCam: Vec3;
  q: Quat;
  boundingRadius: number;
}

export interface PlanInput {
  frame: number;
  bodies: PlanBody[];
  vessels: PlanVessel[];
  /** Vessel whose interior the camera is in (cascade 0 is anchored to it), or null. */
  insideVesselId: string | null;
  fovY: number;
  renderHeight: number;
  mapSize: number;
  /** Unit direction to the star at the camera (ROOT axes): used for vessel-anchored cascades. */
  sunDirRoot: Vec3;
}

export interface DesiredCascade {
  key: string;
  fit: 'camera' | 'body';
  anchor: AnchorRef;
  radius: number;
  everyFrame: boolean;
  /** 0..1 cross-fade weight (body-fitted cascades fade in/out; camera cascades are 1). */
  weight: number;
  /** Far distance from the camera (Infinity for body-fitted). */
  farDistance: number;
  /** Camera-fitted: distance from the camera within which ground can be seen in this cascade (its radius, or the horizon when that is nearer). */
  reach: number;
}

const smooth = (a: number, b: number, x: number): number => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/**
 * Decide which cascades exist this frame (at most MAX_CASCADES), in sampling order: camera-fitted from
 * the finest outwards, then body-fitted ones.
 */
export function planCascades(input: PlanInput): DesiredCascade[] {
  const bodies = input.bodies;
  let nearest: PlanBody | null = null;
  let nearestAlt = Infinity;
  for (const b of bodies) {
    const alt = v3.len(b.centerRelCam) - b.radius;
    if (alt < nearestAlt) {
      nearestAlt = alt;
      nearest = b;
    }
  }
  if (!nearest) return [];
  const h = Math.max(nearestAlt, 0);
  const hMin = Math.max(0, nearestAlt - nearest.maxElevation);
  const R = nearest.radius;
  const horizon = Math.sqrt(h * (2 * R + h)) + Math.sqrt(nearest.maxElevation * (2 * R + nearest.maxElevation));
  const texelOf = (r: number): number => (2 * r) / input.mapSize;

  const cam: DesiredCascade[] = [];
  let everyFrameCount = 0;
  const interiorVessel = input.insideVesselId !== null && input.vessels.some((v) => v.id === input.insideVesselId);
  const radiusOf = (i: number): number => (i === 0 && interiorVessel ? INTERIOR_CASCADE_RADIUS : CASCADE_RADII[i]!);
  for (let i = 0; i < CASCADE_RADII.length; i++) {
    const r = radiusOf(i);
    const prevR = i > 0 ? radiusOf(i - 1) : 0;
    const reachesGround = r > hMin;
    let holdsVessel = false;
    let needsEveryFrame = i < ALWAYS_EVERY_FRAME;
    for (const v of input.vessels) {
      const d = v3.len(v.originRelCam);
      if (d - v.boundingRadius >= r) continue;
      holdsVessel = true;
      // A moving caster needs this cascade every frame unless it and the room for its shadow sit wholly
      // inside the finer cascade, or it is smaller than a few texels here.
      const insideFiner = i > 0 && d + 4 * v.boundingRadius < prevR;
      if (!insideFiner && texelOf(r) <= v.boundingRadius / 4) needsEveryFrame = true;
    }
    let active: boolean;
    if (i < ALWAYS_EVERY_FRAME) active = true;
    else if (i < 4) active = holdsVessel || (reachesGround && prevR < horizon);
    else active = reachesGround && prevR < horizon;
    if (!active) continue;
    const everyFrame = needsEveryFrame && everyFrameCount < MAX_EVERY_FRAME;
    if (everyFrame) everyFrameCount++;
    const vesselAnchored = i === 0 && interiorVessel;
    cam.push({
      key: `cam:${i}`,
      fit: 'camera',
      anchor: vesselAnchored ? { kind: 'vessel', id: input.insideVesselId! } : { kind: 'body', id: nearest.id },
      radius: r,
      everyFrame,
      weight: 1,
      farDistance: r,
      reach: Math.min(r, horizon),
    });
  }

  const lastCamRadius = cam.length > 0 ? cam[cam.length - 1]!.radius : 0;
  const bodyFit: (DesiredCascade & { score: number })[] = [];
  for (const b of bodies) {
    if (!b.hasTerrain) continue;
    const d = v3.len(b.centerRelCam);
    const px = d > b.radius ? ((2 * Math.asin(b.radius / d)) / input.fovY) * input.renderHeight : Infinity;
    let weight: number;
    if (b === nearest) {
      // The camera-fitted cascades stop at lastCamRadius; the whole-body cascade takes over for visible
      // ground beyond it and fades out once the horizon is comfortably inside.
      const reach = Math.max(lastCamRadius, 1);
      weight = hMin >= CASCADE_RADII[CASCADE_RADII.length - 1]! ? 1 : smooth(0.8, 1.0, horizon / reach);
    } else {
      weight = smooth(BODY_FIT_MIN_PIXELS / 2, BODY_FIT_MIN_PIXELS, px);
    }
    if (weight <= 0) continue;
    bodyFit.push({
      key: `body:${b.id}`,
      fit: 'body',
      anchor: { kind: 'body', id: b.id },
      radius: (b.radius + b.maxElevation) * 1.1,
      everyFrame: false,
      weight,
      farDistance: Infinity,
      reach: Infinity,
      score: weight * Math.min(px, 1e6),
    });
  }
  bodyFit.sort((a, b) => b.score - a.score);

  // Slots: the vessel-range cascades first, then whole-body cascades, then the far camera cascades.
  const near = cam.filter((c) => c.radius <= CASCADE_RADII[3]!);
  const far = cam.filter((c) => c.radius > CASCADE_RADII[3]!);
  const bodySlots = bodyFit.slice(0, Math.max(0, MAX_CASCADES - near.length));
  const farSlots = far.slice(0, Math.max(0, MAX_CASCADES - near.length - bodySlots.length));
  return [...near, ...farSlots, ...bodySlots.map(({ score: _score, ...c }) => c)];
}

interface ReceiverFit {
  /** Footprint to capture with (null = the square around the focus). */
  shape: CascadeShape | null;
  /** The held capture no longer serves: re-capture now instead of waiting for the cascade's turn. */
  changed: boolean;
}

/**
 * Receiver fit of a staggered camera cascade anchored to `body` (anchor coordinates: body centre at the
 * origin, `focus` = camera, `lz` = unit direction to the sun).
 *
 * At a sun elevation e the ground inside the cascade takes up only about sin(e) of the map along the axis
 * that lies in the vertical plane of the light, while one texel along that axis covers 1 / sin(e) texels of
 * ground. Narrowing the footprint along that axis to the band the ground occupies (the terrain shell inside
 * the cascade's reach) gives those texels back: at 14 deg the 200 km cascade of a 100 km lunar orbit becomes
 * 2.8 times, at 6 deg the 1500 km cascade seen from 1000 km 5.7 times as fine along the light.
 *
 * The band axis has to lie along the local vertical, so the map is turned accordingly; orientation and band
 * are kept from one capture to the next (the texel grid stays put) until the band no longer holds the
 * receivers, a narrower step of the ladder would hold them with BAND_SLACK to spare, or the vertical has
 * turned by BAND_ROLL_LIMIT. Each of those re-phases the grid once.
 */
function fitReceivers(d: DesiredCascade, body: PlanBody, focus: Vec3, lz: Vec3, held: CascadeCapture | null): ReceiverFit {
  const rInner = body.radius + Math.min(body.minElevation ?? 0, 0);
  const rOuter = body.radius + Math.max(body.maxElevation, 0);
  const heldBand = held !== null && held.radiusV < held.radius;
  const vertical = v3.cross(focus, lz);
  const ideal = v3.len(vertical) > 1e-3 * v3.len(focus) ? v3.normalize(vertical) : null;
  if (heldBand) {
    const lx = v3.normalize(v3.addScaled(held.lx, lz, -v3.dot(held.lx, lz)));
    const ly = v3.cross(lz, lx);
    const band = receiverBand(focus, ly, d.reach, rInner, rOuter);
    if (band) {
      const centre = v3.dot(ly, v3.sub(held.center, focus));
      const holds = centre - held.radiusV <= band.min - held.texelSizeV && centre + held.radiusV >= band.max + held.texelSizeV;
      const loose = bandRadius(d.radius, 0.5 * (band.max - band.min) * BAND_SLACK) < held.radiusV;
      const rolled = ideal !== null && v3.angle(lx, ideal) > BAND_ROLL_LIMIT;
      if (holds && !loose && !rolled) return { shape: { lx, radiusV: held.radiusV, centerV: 0.5 * (band.min + band.max) }, changed: false };
    }
  }
  if (ideal) {
    const band = receiverBand(focus, v3.cross(lz, ideal), d.reach, rInner, rOuter);
    if (band) {
      const radiusV = bandRadius(d.radius, 0.5 * (band.max - band.min) * BAND_SLACK);
      if (radiusV < d.radius) return { shape: { lx: ideal, radiusV, centerV: 0.5 * (band.min + band.max) }, changed: true };
    }
  }
  // No gain from a band (high sun, or relief as large as the cascade): the square around the camera.
  return { shape: null, changed: heldBand };
}

export interface CascadeFrame {
  /** Layer of the shadow array this cascade lives in. */
  layer: number;
  desired: DesiredCascade;
  capture: CascadeCapture;
  matrices: CascadeMatrices;
  /** True when the layer must be rendered this frame. */
  render: boolean;
}

/**
 * Keeps cascade captures across frames, assigns stable texture layers, staggers re-rendering and
 * re-derives every matrix each frame.
 */
export class CascadeScheduler {
  private readonly byKey = new Map<string, { layer: number; capture: CascadeCapture | null }>();

  /** Captures currently held (for tests and debugging). */
  captureOf(key: string): CascadeCapture | null {
    return this.byKey.get(key)?.capture ?? null;
  }

  /**
   * Forget every capture and layer (frame-exact capture, CoreRenderer.renderExact): the next update assigns
   * the layers in the order of the plan and renders every cascade, as the first frame of a session does.
   */
  reset(): void {
    this.byKey.clear();
  }

  update(input: PlanInput, desired: DesiredCascade[] = planCascades(input)): CascadeFrame[] {
    // Release layers of cascades that are gone, then give new cascades the free layers.
    const wanted = new Set(desired.map((d) => d.key));
    for (const key of [...this.byKey.keys()]) if (!wanted.has(key)) this.byKey.delete(key);
    const used = new Set([...this.byKey.values()].map((e) => e.layer));
    for (const d of desired) {
      if (this.byKey.has(d.key)) continue;
      let layer = 0;
      while (used.has(layer)) layer++;
      used.add(layer);
      this.byKey.set(d.key, { layer, capture: null });
    }

    const bodyById = new Map(input.bodies.map((b) => [b.id, b]));
    const vesselById = new Map(input.vessels.map((v) => [v.id, v]));
    const out: CascadeFrame[] = [];
    let staggerRank = 0;
    for (const d of desired) {
      const entry = this.byKey.get(d.key)!;
      let pose: AnchorPose;
      let sunDirRoot: Vec3;
      if (d.anchor.kind === 'body') {
        const b = bodyById.get(d.anchor.id);
        if (!b) continue;
        pose = { originRelCam: b.centerRelCam, q: b.qFixedToRoot };
        sunDirRoot = b.sunDirRoot;
      } else {
        const v = vesselById.get(d.anchor.id);
        if (!v) continue;
        pose = { originRelCam: v.originRelCam, q: v.q };
        sunDirRoot = input.sunDirRoot;
      }
      const sunAnchor = quat.rotateInv(pose.q, sunDirRoot);
      // Focus in anchor coordinates: the camera for camera-fitted cascades, the body centre otherwise.
      const focus = d.fit === 'body' ? v3.zero() : quat.rotateInv(pose.q, v3.neg(pose.originRelCam));

      let render = false;
      const cap = entry.capture;
      const sameAnchor = cap !== null && cap.anchor.kind === d.anchor.kind && cap.anchor.id === d.anchor.id;
      // Staggered camera cascades hold body-fixed casters only, so their receivers are the ground: fit the
      // footprint to it (a band along v) instead of a square around the camera.
      let fit: ReceiverFit = { shape: null, changed: false };
      const fitBody = d.fit === 'camera' && !d.everyFrame && d.anchor.kind === 'body' ? bodyById.get(d.anchor.id) : undefined;
      if (fitBody) fit = fitReceivers(d, fitBody, focus, sunAnchor, sameAnchor && cap.radius === d.radius ? cap : null);
      if (!cap || !sameAnchor || cap.radius !== d.radius) render = true;
      else if (d.everyFrame) render = true;
      else {
        const period = staggerRank < 2 ? 2 : staggerRank < 4 ? 4 : 8;
        if ((input.frame + staggerRank) % period === 0) render = true;
        else if (fit.changed) render = true;
        else if (v3.angle(cap.lz, sunAnchor) > SUN_DRIFT_LIMIT) render = true;
        else if (d.fit === 'camera' && v3.dist(focus, cap.focus) > CAMERA_DRIFT_FRACTION * cap.radius) render = true;
      }
      if (!d.everyFrame) staggerRank++;
      if (render) {
        entry.capture = captureCascade(d.key, d.fit, d.anchor, focus, sunAnchor, d.radius, input.mapSize, input.frame, d.fit === 'camera', sameAnchor ? cap : null, fit.shape);
      }
      const capture = entry.capture!;
      out.push({ layer: entry.layer, desired: d, capture, matrices: cascadeMatrices(capture, pose), render });
    }
    return out;
  }
}
