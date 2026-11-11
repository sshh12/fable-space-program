/**
 * Lens flare of one lens design: a 7-blade iris behind coated glass. The angular profiles here are the ones
 * evaluated by FLARE_WGSL; each is integrated numerically so that a term of energy fraction k delivers exactly
 * k x the illuminance at the lens (the part of it that falls inside the frame is what the screen shows). The
 * sum of all terms is FLARE_TOTAL_ENERGY, under the 1 % of the brief.
 *
 *   glare core    (1 + (theta / c)^2)^-1.5: the burned-out centre and its shoulder (forward scatter in the glass)
 *   glare skirt   1 / (1 + (theta / c)^2): the theta^-2 law of veiling glare, to the far side of the sphere
 *   veil          stray light inside the barrel: uniform over the frame
 *   rays          diffraction at the iris: two rays per blade, perpendicular to its edge. A straight edge sends
 *                 a line of light falling as theta^-2; the sun is a disc, so the line is as wide as the disc
 *                 (a Gaussian of half its radius); the blades are slightly curved, so every ray opens into a
 *                 fan (width growing with theta, peak falling as theta^-3) and ends within a few degrees.
 *                 Blades are not identical: each has its own strength, length, fan and a small angular error.
 *   ghosts        images of the iris from pairs of reflections: heptagons turned like the rays, on the line
 *                 through the image centre, each blurred by the image of the solar disc, tinted by the
 *                 coatings, with lateral colour, an uneven fill and cut to a cat's eye off axis.
 *
 * Geometry: the starburst (glare + rays) is a function of the angle from the sun over the whole sphere and is
 * drawn as a fullscreen pass; every ghost is drawn on the screen-space bounding box of its cone.
 *
 * Sun outside the frame: the lens has a rectangular hood matched to the frame (it does not vignette any
 * direction inside the field), HOOD_DEPTH entrance-pupil diameters deep. A source beyond the frame edge lights
 * the part of the pupil the hood does not shadow (hoodTransmission), so the glare fades out over a few
 * degrees beyond the edge instead of ending when the disc leaves the frame.
 */
import type { Vec3, Vec3Tuple } from '@/core/math';

/** Aperture blades; an odd count gives two separate rays per blade. */
export const BLADE_COUNT = 7;
export const SPIKE_COUNT = 2 * BLADE_COUNT;
/** Depth of the lens hood in entrance-pupil diameters (rectangular, matched to the frame). */
export const HOOD_DEPTH = 2;

export interface BladeDef {
  /** Angular error of the blade's edge normal (rad). */
  angle: number;
  /** Relative strength of its two rays. */
  amplitude: number;
  /** Length scale of its rays (rad): exp(-(theta / length)^2). */
  length: number;
  /** Fan of its rays: the across width grows by this much per radian from the sun (edge curvature). */
  fan: number;
}

/** The seven blades of this iris (a fixed table: manufacturing spread of 20-30 % in strength and length). */
export const BLADES: readonly BladeDef[] = [
  { angle: 0.012, amplitude: 1.0, length: 0.073, fan: 0.042 },
  { angle: -0.021, amplitude: 0.72, length: 0.065, fan: 0.056 },
  { angle: 0.03, amplitude: 1.24, length: 0.076, fan: 0.038 },
  { angle: -0.008, amplitude: 0.86, length: 0.075, fan: 0.05 },
  { angle: 0.019, amplitude: 1.12, length: 0.074, fan: 0.045 },
  { angle: -0.027, amplitude: 0.78, length: 0.053, fan: 0.06 },
  { angle: 0.004, amplitude: 1.05, length: 0.07, fan: 0.041 },
];

export interface StarburstDef {
  /** Glare core: energy fraction and core angle (rad). */
  coreEnergy: number;
  coreAngle: number;
  /** Glare skirt (theta^-2): energy fraction and the angle (rad) inside which it is flat. */
  skirtEnergy: number;
  skirtAngle: number;
  /** Veil: energy fraction spread uniformly over the frame. */
  veilEnergy: number;
  /** Rays: energy fraction of all fourteen, knee angle (rad) beyond which a ray falls as theta^-2. */
  rayEnergy: number;
  rayKnee: number;
  /** Across width of a ray at the sun in solar radii (a disc projected on a line has a standard deviation of half its radius). */
  rayDiscSigma: number;
}

export const STARBURST: StarburstDef = {
  coreEnergy: 0.0028,
  coreAngle: 0.012,
  skirtEnergy: 0.003,
  skirtAngle: 0.02,
  veilEnergy: 0.0006,
  rayEnergy: 0.0028,
  rayKnee: 0.03,
  rayDiscSigma: 0.5,
};

/** Relative wavelength per channel (R, G, B): a ray's angles scale with it (red rays are a little longer). */
export const SPIKE_LAMBDA: Vec3Tuple = [1.04, 1.0, 0.95];

export interface GhostDef {
  /** Position on the line from the image centre (0) to the sun (1), in NDC multiples of the sun's position. */
  k: number;
  /** Apothem of the iris image (rad). */
  radius: number;
  energy: number;
  /** Coating tint, luminance 1. */
  tint: Vec3Tuple;
  /** Edge blur in solar radii: the ghost is the iris image convolved with an image of the solar disc. */
  blur: number;
  /** 0 = straight-edged polygon, 1 = circle (curved blades). */
  round: number;
  /** Brightening (+) or darkening (-) of the outer zone against the centre (edge caustic / hollow centre). */
  rim: number;
  /** Linear fill gradient along the axis-to-sun line, per radius. */
  gradient: number;
  /** Lateral colour: centre shift of the red and blue images along the axis-to-sun line, in radii. */
  chroma: number;
  /** -1 = inverted image of the iris. */
  flip: 1 | -1;
  /** Cat's eye: shift of the clipping circle per unit off-axis tangent of the sun, in radii. */
  vignette: number;
}

const normaliseTint = (c: Vec3Tuple): Vec3Tuple => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
};

/**
 * Twelve ghosts of very different size and strength. Energies are of the order of two coated reflections
 * (1e-5 of the source and less) into areas of 5e-4 to 0.3 sr: at the exposure of a sunlit scene the brightest
 * is about an eighth of mid-grey and most are below the display's black.
 */
export const GHOSTS: readonly GhostDef[] = [
  { k: -0.28, radius: 0.012, energy: 1.5e-6, tint: normaliseTint([0.75, 0.95, 1.0]), blur: 1.2, round: 0.25, rim: -0.3, gradient: 0.3, chroma: 0.1, flip: 1, vignette: 0.3 },
  { k: -0.47, radius: 0.021, energy: 3.4e-6, tint: normaliseTint([0.55, 0.7, 1.0]), blur: 1.5, round: 0.15, rim: 0.25, gradient: 0.35, chroma: 0.08, flip: -1, vignette: 0.5 },
  { k: -0.66, radius: 0.034, energy: 5.5e-6, tint: normaliseTint([0.8, 0.6, 1.0]), blur: 2.0, round: 0.2, rim: 0.4, gradient: 0.3, chroma: 0.06, flip: 1, vignette: 0.6 },
  { k: -0.86, radius: 0.016, energy: 1.6e-6, tint: normaliseTint([1.0, 0.85, 0.6]), blur: 1.3, round: 0.3, rim: -0.2, gradient: 0.25, chroma: 0.1, flip: -1, vignette: 0.4 },
  { k: -1.08, radius: 0.052, energy: 8.0e-6, tint: normaliseTint([0.6, 1.0, 0.75]), blur: 2.5, round: 0.2, rim: 0.5, gradient: 0.4, chroma: 0.05, flip: 1, vignette: 0.7 },
  { k: -1.36, radius: 0.085, energy: 1.3e-5, tint: normaliseTint([0.65, 0.75, 1.0]), blur: 3.0, round: 0.3, rim: 0.3, gradient: 0.45, chroma: 0.04, flip: -1, vignette: 0.8 },
  { k: -1.75, radius: 0.15, energy: 2.2e-5, tint: normaliseTint([1.0, 0.7, 0.85]), blur: 4.0, round: 0.4, rim: 0.2, gradient: 0.5, chroma: 0.03, flip: 1, vignette: 0.9 },
  { k: 0.3, radius: 0.027, energy: 3.0e-6, tint: normaliseTint([1.0, 0.8, 0.55]), blur: 1.8, round: 0.2, rim: 0.3, gradient: 0.3, chroma: 0.07, flip: 1, vignette: 0.5 },
  { k: 0.55, radius: 0.044, energy: 5.0e-6, tint: normaliseTint([0.6, 0.95, 0.8]), blur: 2.2, round: 0.25, rim: -0.25, gradient: 0.35, chroma: 0.05, flip: -1, vignette: 0.6 },
  { k: 0.78, radius: 0.011, energy: 1.0e-6, tint: normaliseTint([0.9, 0.9, 1.0]), blur: 1.1, round: 0.35, rim: -0.4, gradient: 0.2, chroma: 0.12, flip: 1, vignette: 0.3 },
  { k: 1.42, radius: 0.07, energy: 7.0e-6, tint: normaliseTint([0.7, 0.6, 1.0]), blur: 3.0, round: 0.3, rim: 0.45, gradient: 0.4, chroma: 0.04, flip: -1, vignette: 0.8 },
  { k: -2.3, radius: 0.3, energy: 4.0e-5, tint: normaliseTint([0.96, 0.98, 1.0]), blur: 8.0, round: 0.5, rim: 0.15, gradient: 0.5, chroma: 0.02, flip: 1, vignette: 1.0 },
];

export const FLARE_TOTAL_ENERGY =
  STARBURST.coreEnergy + STARBURST.skirtEnergy + STARBURST.veilEnergy + STARBURST.rayEnergy + GHOSTS.reduce((s, g) => s + g.energy, 0);

// ------------------------------------------------------------------------------------------------ iris geometry

/** Blade whose edge sends ray j (0..SPIKE_COUNT - 1, nominal angle j x 2 pi / SPIKE_COUNT): rays 2b and 2b + BLADE_COUNT. */
export const spikeBlade = (j: number): number => {
  const m = ((j % SPIKE_COUNT) + SPIKE_COUNT) % SPIKE_COUNT;
  return (m % 2 === 0 ? m : (m + BLADE_COUNT) % SPIKE_COUNT) / 2;
};
/** Angle of blade b's edge normal in the image plane, from the camera's up towards its right (rad). */
export const bladeAngle = (b: number): number => (b * 2 * Math.PI) / BLADE_COUNT + BLADES[b]!.angle;
/** cos(pi / n): apothem / circumradius of the regular polygon. */
const POLY_COS = Math.cos(Math.PI / BLADE_COUNT);
/** Radius of the circle with the polygon's area, in apothems. */
export const POLY_EQ_CIRCLE = Math.sqrt((BLADE_COUNT * Math.tan(Math.PI / BLADE_COUNT)) / Math.PI);
/** Radius of the cat's-eye clipping circle in apothems (clear of the polygon on the axis). */
export const GHOST_CLIP_RADIUS = 1.25 / POLY_COS;
/** Smallest apothem / vertex-distance ratio of this (slightly irregular) polygon: cos of half the widest gap between edge normals. */
const POLY_MIN_COS = (() => {
  let m = 1;
  for (let b = 0; b < BLADE_COUNT; b++) {
    const next = (b + 1) % BLADE_COUNT;
    const gap = bladeAngle(next) - bladeAngle(b) + (next === 0 ? 2 * Math.PI : 0);
    m = Math.min(m, Math.cos(gap / 2));
  }
  return m;
})();

// ------------------------------------------------------------------------------------------------ profiles

export const glareCore = (theta: number): number => (1 + (theta / STARBURST.coreAngle) ** 2) ** -1.5;
export const glareSkirt = (theta: number): number => 1 / (1 + (theta / STARBURST.skirtAngle) ** 2);

/**
 * One channel of the ray set at angle theta from the sun and azimuth phi (from the image-plane up towards right),
 * unnormalised: amplitude x along(theta / lambda) / lambda x a unit-integral Gaussian across.
 */
export function rayProfile(theta: number, phi: number, sunRadius: number, lambda: number): number {
  const seg = (2 * Math.PI) / SPIKE_COUNT;
  const j = Math.round(phi / seg);
  const blade = BLADES[spikeBlade(j)]!;
  const dphi = phi - j * seg - blade.angle;
  const across = theta * Math.sin(dphi);
  const w0 = STARBURST.rayDiscSigma * sunRadius;
  const sigma = Math.sqrt(w0 * w0 + (blade.fan * theta) ** 2);
  const t = theta / lambda;
  const along = Math.exp(-((t / blade.length) ** 2)) / (1 + (t / STARBURST.rayKnee) ** 2) / lambda;
  return (blade.amplitude * along * Math.exp((-0.5 * across * across) / (sigma * sigma))) / (2.5066282746 * sigma);
}

const smooth01 = (x: number): number => {
  const t = Math.min(1, Math.max(0, x));
  return t * t * (3 - 2 * t);
};

/** Per-frame geometry of the ghosts: unit axis-to-sun direction in the image plane (right, up), and how far off axis the sun is. */
export interface GhostFrame {
  axis: [number, number];
  /** Tangent of the sun's angle off the view axis. */
  offAxis: number;
  sunRadius: number;
}

/** Lateral effects (gradient, colour shift) fade in with the sun's distance from the axis: a ghost of an on-axis source is symmetric. */
export const ghostLateral = (offAxis: number): number => smooth01(offAxis / 0.2);

/**
 * Ghost image at the tangent-plane point (px, py) (rad; right, up) from its centre, one channel (`channel` -1 red,
 * 0 green, +1 blue), unnormalised: soft-edged iris polygon x fill x cat's-eye clip.
 */
export function ghostShape(g: GhostDef, f: GhostFrame, px: number, py: number, channel: number): number {
  const lateral = ghostLateral(f.offAxis);
  const R = g.radius;
  const s = g.blur * f.sunRadius;
  // Lateral colour: the red and blue images sit a little further out / in along the axis-to-sun line.
  const cs = channel * g.chroma * R * lateral;
  const x = px - f.axis[0] * cs;
  const y = py - f.axis[1] * cs;
  let poly = -Infinity;
  for (let b = 0; b < BLADE_COUNT; b++) {
    const a = bladeAngle(b);
    poly = Math.max(poly, g.flip * (x * Math.sin(a) + y * Math.cos(a)));
  }
  const r = Math.hypot(x, y);
  const d = poly + (r / POLY_EQ_CIRCLE - poly) * g.round;
  const mask = smooth01(0.5 - (d - R) / (2 * s));
  if (mask <= 0) return 0;
  const fill = 1 + g.rim * (smooth01((d / R - 0.55) / 0.45) - 0.5);
  const grad = Math.max(0, 1 + (g.gradient * lateral * (x * f.axis[0] + y * f.axis[1])) / R);
  // Cat's eye: a second aperture, displaced towards the image centre in proportion to the sun's off-axis tangent.
  const shift = g.vignette * f.offAxis * R;
  const dv = Math.hypot(x + f.axis[0] * shift, y + f.axis[1] * shift);
  const clip = smooth01(0.5 - (dv - GHOST_CLIP_RADIUS * R - 2 * s) / (2 * s));
  return mask * fill * grad * clip;
}

/** Angular radius (rad) beyond which a ghost is zero in every channel. */
export const ghostSupport = (g: GhostDef, sunRadius: number): number => (g.radius + g.blur * sunRadius) / POLY_MIN_COS + g.chroma * g.radius;

// ------------------------------------------------------------------------------------------- normalisation

/** Integral over the sphere outside the solar disc of an axially symmetric profile (sr). */
function ringIntegral(f: (theta: number) => number, sunRadius: number): number {
  let s = 0;
  const n = 6000;
  const la = Math.log(sunRadius);
  const lb = Math.log(Math.PI);
  for (let i = 0; i < n; i++) {
    // Logarithmic steps in theta: the profiles are concentrated within a few core angles.
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / n);
    s += f(th) * 2 * Math.PI * Math.sin(th) * ((th * (lb - la)) / n);
  }
  return s;
}

/** Integral of the ray set of one channel over the sphere outside the disc (sr). */
export function rayIntegral(lambda: number, sunRadius: number): number {
  let s = 0;
  const nt = 1200;
  const np = 1680;
  const la = Math.log(sunRadius);
  const lb = Math.log(Math.PI);
  for (let i = 0; i < nt; i++) {
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / nt);
    // The rays end within a few lengths: nothing to add beyond.
    if (th > 0.8) break;
    let ring = 0;
    for (let j = 0; j < np; j++) ring += rayProfile(th, ((j + 0.5) * 2 * Math.PI) / np, sunRadius, lambda);
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * ((th * (lb - la)) / nt);
  }
  return s;
}

/** Integral of a ghost's green image over the sphere (sr), unclipped and without the lateral terms (the sun on the axis). */
export function ghostIntegral(g: GhostDef, sunRadius: number): number {
  const f: GhostFrame = { axis: [0, 1], offAxis: 0, sunRadius };
  const support = ghostSupport(g, sunRadius);
  let s = 0;
  const nr = 400;
  const np = 420;
  for (let i = 0; i < nr; i++) {
    const th = ((i + 0.5) * support) / nr;
    let ring = 0;
    for (let j = 0; j < np; j++) {
      const phi = ((j + 0.5) * 2 * Math.PI) / np;
      ring += ghostShape(g, f, th * Math.sin(phi), th * Math.cos(phi), 0);
    }
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * (support / nr);
  }
  return s;
}

export interface FlareNormalisation {
  /** 1 / integral (1/sr) of the glare core, the skirt, the rays (green channel), each ghost (green channel). */
  core: number;
  skirt: number;
  rays: number;
  ghosts: number[];
  /** Solar angular radius (rad) the integrals were computed for. */
  sunRadius: number;
}

let normCache: FlareNormalisation | null = null;

/** Normalisation of the flare profiles for a solar disc of angular radius `sunRadius` (recomputed when it changes by 0.1 %). */
export function flareNormalisation(sunRadius: number): FlareNormalisation {
  if (normCache && Math.abs(sunRadius - normCache.sunRadius) < 1e-3 * sunRadius) return normCache;
  normCache = {
    core: 1 / ringIntegral(glareCore, sunRadius),
    skirt: 1 / ringIntegral(glareSkirt, sunRadius),
    rays: 1 / rayIntegral(1, sunRadius),
    ghosts: GHOSTS.map((g) => 1 / ghostIntegral(g, sunRadius)),
    sunRadius,
  };
  return normCache;
}

/** Solid angle (sr) of the frame: a rectangular pyramid with half-tangents tanX, tanY. */
export const frameSolidAngle = (tanX: number, tanY: number): number => 4 * Math.atan((tanX * tanY) / Math.sqrt(1 + tanX * tanX + tanY * tanY));

// ------------------------------------------------------------------------------------------------- CPU model

/** Geometry of one frame's flare: camera, unit direction to the sun, its angular radius and NDC position (unjittered). */
export interface FlareGeometry {
  view: FlareView;
  sun: Vec3;
  sunRadius: number;
  sunNdc: [number, number];
}

const dot3 = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;
const cross3 = (a: Vec3, b: Vec3): Vec3 => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
const norm3 = (a: Vec3): Vec3 => {
  const l = Math.hypot(a.x, a.y, a.z);
  return { x: a.x / l, y: a.y / l, z: a.z / l };
};
const angleBetween = (a: Vec3, b: Vec3): number => {
  const c = cross3(a, b);
  return Math.atan2(Math.hypot(c.x, c.y, c.z), dot3(a, b));
};

/** Image-plane basis (right, up) perpendicular to unit direction c: the camera's up projected, and c x up. */
function tangentBasis(view: FlareView, c: Vec3): { rt: Vec3; up: Vec3 } {
  const u = dot3(view.up, c);
  const up = norm3({ x: view.up.x - c.x * u, y: view.up.y - c.y * u, z: view.up.z - c.z * u });
  return { rt: cross3(c, up), up };
}

/** Axis-to-sun direction in the image plane and the sun's off-axis tangent, from its NDC position. */
export function ghostFrame(view: FlareView, sunNdc: [number, number], sunRadius: number): GhostFrame {
  const ax = sunNdc[0] * view.tanX;
  const ay = sunNdc[1] * view.tanY;
  const l = Math.hypot(ax, ay);
  return { axis: l > 1e-9 ? [ax / l, ay / l] : [0, 1], offAxis: l, sunRadius };
}

/**
 * CPU model of FLARE_WGSL: the radiance (rgb, cd/m^2 per lux of source illuminance) the flare adds along unit
 * direction d inside the frame. Zero on the disc and its 1.5 px rim (`pixelAngle` = pixel angle on the view
 * axis), which the shader leaves alone. Tests integrate it over the screen as the reference of the GPU image.
 */
export function flareRadiance(g: FlareGeometry, d: Vec3, pixelAngle: number): Vec3Tuple {
  const s = g.sun;
  const theta = angleBetween(d, s);
  if (theta < g.sunRadius + 1.5 * pixelAngle) return [0, 0, 0];
  const n = flareNormalisation(g.sunRadius);
  const glare =
    STARBURST.coreEnergy * n.core * glareCore(theta) + STARBURST.skirtEnergy * n.skirt * glareSkirt(theta) + STARBURST.veilEnergy / frameSolidAngle(g.view.tanX, g.view.tanY);
  const out: Vec3Tuple = [glare, glare, glare];
  // Rays: azimuth about the sun in the image plane, from the camera's up towards its right.
  const bs = tangentBasis(g.view, s);
  const ds = dot3(d, s);
  const ts = { x: d.x - s.x * ds, y: d.y - s.y * ds, z: d.z - s.z * ds };
  const phi = Math.atan2(dot3(ts, bs.rt), dot3(ts, bs.up));
  for (let c = 0; c < 3; c++) out[c] = out[c]! + STARBURST.rayEnergy * n.rays * rayProfile(theta, phi, g.sunRadius, SPIKE_LAMBDA[c]!);
  // Ghosts: iris images around the view rays through k x the sun's NDC position.
  const gf = ghostFrame(g.view, g.sunNdc, g.sunRadius);
  GHOSTS.forEach((gh, i) => {
    const centre = ndcDirection(g.view, g.sunNdc[0] * gh.k, g.sunNdc[1] * gh.k);
    const a = angleBetween(d, centre);
    if (a > ghostSupport(gh, g.sunRadius)) return;
    const bc = tangentBasis(g.view, centre);
    const dc = dot3(d, centre);
    const t = { x: d.x - centre.x * dc, y: d.y - centre.y * dc, z: d.z - centre.z * dc };
    const tl = Math.hypot(t.x, t.y, t.z);
    const px = tl > 0 ? (a * dot3(t, bc.rt)) / tl : 0;
    const py = tl > 0 ? (a * dot3(t, bc.up)) / tl : 0;
    for (let c = 0; c < 3; c++) out[c] = out[c]! + gh.energy * gh.tint[c]! * n.ghosts[i]! * ghostShape(gh, gf, px, py, c - 1);
  });
  return out;
}

/**
 * Fraction of a circular entrance pupil lit through a rectangular hood matched to the frame, for a source whose
 * image-plane tangents exceed the frame's half-tangents by ex, ey >= 0 (0 inside the frame). Along each axis
 * the hood's edge shadows a straight-edged part of the pupil that grows by HOOD_DEPTH x the excess tangent
 * (in pupil diameters): the lit part is the circular segment beyond it. The two axes are combined as a product.
 */
export function hoodTransmission(ex: number, ey: number): number {
  const lit = (e: number): number => {
    const s = Math.min(1, Math.max(0, e * HOOD_DEPTH));
    if (s <= 0) return 1;
    if (s >= 1) return 0;
    const x = 2 * s - 1;
    return (Math.acos(x) - x * Math.sqrt(1 - x * x)) / Math.PI;
  };
  return lit(ex) * lit(ey);
}

/** Camera basis and half-tangents of the frame (unjittered). */
export interface FlareView {
  right: Vec3;
  up: Vec3;
  forward: Vec3;
  tanX: number;
  tanY: number;
}

/** Unit view direction through an NDC point (the shader's ndcRay). */
export function ndcDirection(v: FlareView, x: number, y: number): Vec3 {
  const d = {
    x: v.forward.x + v.right.x * x * v.tanX + v.up.x * y * v.tanY,
    y: v.forward.y + v.right.y * x * v.tanX + v.up.y * y * v.tanY,
    z: v.forward.z + v.right.z * x * v.tanX + v.up.z * y * v.tanY,
  };
  const l = Math.hypot(d.x, d.y, d.z);
  return { x: d.x / l, y: d.y / l, z: d.z / l };
}

/** Number of directions on the cone's rim projected for its bounding box. */
const CONE_RIM = 48;

/**
 * NDC bounding box [minX, minY, maxX, maxY] of the cone of half-angle `angle` around unit direction `c`, by
 * projecting a ring of directions on its rim (inflated by the chord error of the polygon), or the whole screen
 * when the cone reaches the plane of the camera (no finite projection).
 */
export function coneNdcBounds(v: FlareView, c: Vec3, angle: number): [number, number, number, number] {
  const a = Math.abs(c.z) < 0.9 ? { x: 0, y: 0, z: 1 } : { x: 1, y: 0, z: 0 };
  let e1 = { x: c.y * a.z - c.z * a.y, y: c.z * a.x - c.x * a.z, z: c.x * a.y - c.y * a.x };
  const l1 = Math.hypot(e1.x, e1.y, e1.z);
  e1 = { x: e1.x / l1, y: e1.y / l1, z: e1.z / l1 };
  const e2 = { x: c.y * e1.z - c.z * e1.y, y: c.z * e1.x - c.x * e1.z, z: c.x * e1.y - c.y * e1.x };
  // A polygon inscribed in the rim misses at most 1 - cos(pi / n) of the radius between its vertices.
  const rim = angle / Math.cos(Math.PI / CONE_RIM);
  const ca = Math.cos(rim);
  const sa = Math.sin(rim);
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (let i = 0; i < CONE_RIM; i++) {
    const phi = (i * 2 * Math.PI) / CONE_RIM;
    const k1 = sa * Math.cos(phi);
    const k2 = sa * Math.sin(phi);
    const d = { x: c.x * ca + e1.x * k1 + e2.x * k2, y: c.y * ca + e1.y * k1 + e2.y * k2, z: c.z * ca + e1.z * k1 + e2.z * k2 };
    const w = d.x * v.forward.x + d.y * v.forward.y + d.z * v.forward.z;
    if (w <= 1e-6) return [-1, -1, 1, 1];
    const x = (d.x * v.right.x + d.y * v.right.y + d.z * v.right.z) / (w * v.tanX);
    const y = (d.x * v.up.x + d.y * v.up.y + d.z * v.up.z) / (w * v.tanY);
    minX = Math.min(minX, x);
    minY = Math.min(minY, y);
    maxX = Math.max(maxX, x);
    maxY = Math.max(maxY, y);
  }
  return [minX, minY, maxX, maxY];
}
