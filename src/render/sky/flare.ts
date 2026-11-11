/**
 * Lens flare of one lens design: a 7-blade iris behind coated glass. The angular profiles here are the ones
 * evaluated by FLARE_WGSL; each is integrated numerically so that a term of energy fraction k delivers exactly
 * k x the illuminance at the lens (the part of it that falls inside the frame is what the screen shows). The
 * sum of all terms is FLARE_TOTAL_ENERGY, under the 1 % of the brief.
 *
 * What is NOT here: the burned-out core and its steep shoulder. The render core's bloom is the glare spread
 * function of the lens for every bright source (4 % of the image, falling as the third power of the distance,
 * gone within about 15 deg): around the solar disc it is far stronger than anything this file could add inside
 * its 1 %. The flare adds what the bloom does not have:
 *
 *   halo          wide-angle scatter in the glass and its coatings, (1 + (theta / c)^2)^-1.5 with c = 14 deg:
 *                 level under the bloom's shoulder, it takes over where the bloom's kernel ends and carries the
 *                 glare on to the edge of the frame as one falloff. Coatings scatter short wavelengths more:
 *                 the halo is violet-blue against the white core.
 *   rays          diffraction at the iris: two rays per blade, perpendicular to its edge. A straight edge sends
 *                 a line of light falling as theta^-2; the sun is a disc, so the line is as wide as the disc
 *                 (a Gaussian of half its radius); the blades are slightly curved, so every ray opens into a
 *                 narrow fan. Angles scale with the wavelength: a ray is blue-white near the sun, breaks into
 *                 colour fringes further out and ends red. Blades are not identical: each has its own strength,
 *                 length, fan and angular error, and its two rays differ (the far edge of the stop is vignetted).
 *   streaks       the fine structure of a real starburst: dozens of thin radial streaks of very different
 *                 strength and length between the rays (edge roughness of the blades, wipe marks on the front
 *                 element), a fixed table of this lens.
 *   ghosts        images of the iris from pairs of reflections, on the line through the image centre: no two
 *                 alike (sharp heptagons, defocused blobs, an oval, a ring, a crescent cut by a second stop),
 *                 some overlapping, tinted by the coatings, with a colour fringe on their outer side.
 *
 * Geometry: the starburst (halo + rays + streaks) is a function of the angle from the sun over the whole sphere
 * and is drawn as a fullscreen pass; every ghost is drawn on the screen-space bounding box of its cone.
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
  /** Length of its rays (rad): they end exactly there (times the relative wavelength). */
  length: number;
  /** Fan of its rays: the across width grows by this much per radian from the sun (edge curvature). */
  fan: number;
  /** Strength of the first of its two rays over the second (vignetting of the far side of the stop). */
  asymmetry: number;
}

/**
 * The seven blades of this iris, a fixed table. Blade 2 is the straightest (the long, thin pair), blade 5 barely
 * reaches into the beam (its pair is nearly missing); the edge normals are off their nominal angles by up to 5 deg.
 */
export const BLADES: readonly BladeDef[] = [
  { angle: 0.035, amplitude: 1.0, length: 0.27, fan: 0.018, asymmetry: 1.25 },
  { angle: -0.06, amplitude: 0.55, length: 0.17, fan: 0.028, asymmetry: 0.75 },
  { angle: 0.085, amplitude: 1.75, length: 0.62, fan: 0.012, asymmetry: 1.35 },
  { angle: -0.025, amplitude: 0.8, length: 0.22, fan: 0.022, asymmetry: 0.65 },
  { angle: 0.05, amplitude: 1.2, length: 0.31, fan: 0.016, asymmetry: 1.0 },
  { angle: -0.075, amplitude: 0.2, length: 0.12, fan: 0.03, asymmetry: 1.5 },
  { angle: 0.015, amplitude: 0.95, length: 0.24, fan: 0.02, asymmetry: 0.85 },
];

export interface StarburstDef {
  /** Halo: energy fraction, core angle (rad) and tint (luminance 1). */
  haloEnergy: number;
  haloAngle: number;
  haloTint: Vec3Tuple;
  /** Rays: energy fraction of all fourteen, knee angle (rad) beyond which a ray falls as theta^-2. */
  rayEnergy: number;
  rayKnee: number;
  /** Across width of a ray or streak at the sun in solar radii (a disc projected on a line has a standard deviation of half its radius). */
  rayDiscSigma: number;
  /**
   * Colour fringes along a ray: modulation depth and period (rad, at the green wavelength), and the angle (rad) over
   * which they wash out (each channel spans a band of wavelengths whose fringes run out of step: a few bands of
   * colour near the core, then a white ray that ends red).
   */
  fringeDepth: number;
  fringePeriod: number;
  fringeReach: number;
  /** Streaks: energy fraction of the whole table and their fan (across width per radian from the sun). */
  streakEnergy: number;
  streakFan: number;
}

const normaliseTint = (c: Vec3Tuple): Vec3Tuple => {
  const l = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  return [c[0] / l, c[1] / l, c[2] / l];
};

export const STARBURST: StarburstDef = {
  haloEnergy: 0.0025,
  haloAngle: 0.25,
  haloTint: normaliseTint([0.95, 0.92, 1.22]),
  rayEnergy: 0.0027,
  rayKnee: 0.02,
  rayDiscSigma: 0.5,
  fringeDepth: 0.3,
  fringePeriod: 0.034,
  fringeReach: 0.11,
  streakEnergy: 0.0009,
  streakFan: 0.004,
};

/** Relative wavelength per channel (R, G, B): a ray's angles scale with it (red rays are longer, their fringes wider). */
export const SPIKE_LAMBDA: Vec3Tuple = [1.09, 1.0, 0.9];

export interface StreakDef {
  /** Azimuth about the sun in the image plane (rad, from up towards right, in [-pi, pi)). */
  azimuth: number;
  amplitude: number;
  /** Length (rad): the streak ends exactly there (times the relative wavelength). */
  length: number;
}

/** Azimuth cells of the streak table: one streak per cell, so a pixel only visits its own cell and the two beside it. */
export const STREAK_COUNT = 72;

/**
 * The streaks of this lens: one per 5 deg cell at a fixed pseudo-random place in it, a few strong and long, most
 * faint and short (amplitude = u^3, length 0.06 to 0.5 rad, most under 0.15). A fixed table (a small generator with a fixed seed).
 */
export const STREAKS: readonly StreakDef[] = (() => {
  let s = 0x2f6e2b1;
  const rnd = (): number => {
    // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const cell = (2 * Math.PI) / STREAK_COUNT;
  const out: StreakDef[] = [];
  for (let i = 0; i < STREAK_COUNT; i++) {
    const u = rnd();
    const v = rnd();
    out.push({ azimuth: -Math.PI + (i + 0.15 + 0.7 * rnd()) * cell, amplitude: 0.04 + u * u * u, length: 0.06 + 0.44 * v * v * v });
  }
  return out;
})();

/** Angle from the sun (rad) beyond which no ray or streak reaches (the longest, at the red wavelength). */
export const RAY_REACH = Math.max(...BLADES.map((b) => b.length), ...STREAKS.map((s) => s.length)) * Math.max(...SPIKE_LAMBDA);

export interface GhostDef {
  /** Position on the line from the image centre (0) to the sun (1), in NDC multiples of the sun's position. */
  k: number;
  /** Apothem of the iris image (rad). */
  radius: number;
  energy: number;
  /** Coating tint, luminance 1. */
  tint: Vec3Tuple;
  /** Edge blur in solar radii: the ghost is the iris image convolved with an image of the solar disc; a defocused ghost has a blur as large as itself. */
  blur: number;
  /** 0 = straight-edged polygon, 1 = circle (curved blades). */
  round: number;
  /** Brightening (+) or darkening (-) of the outer zone against the centre (edge caustic / dark rim). */
  rim: number;
  /** Linear fill gradient along the axis-to-sun line, per radius. */
  gradient: number;
  /** Lateral colour: the blue image is larger by this fraction on the side away from the image centre (a blue fringe on one side). */
  chroma: number;
  /** -1 = inverted image of the iris. */
  flip: 1 | -1;
  /** Cat's eye: shift of the clipping circle per unit off-axis tangent of the sun, in radii. */
  vignette: number;
  /** Stretch along the axis-to-sun line (1 = none): an oval. */
  aspect: number;
  /** 0 = filled, 1 = a ring (the centre is empty, the brightness rises with the square of the distance from it). */
  hollow: number;
  /** A second stop in the light path cuts a disc of this radius (in radii of the ghost; 0 = none) out of it ... */
  bite: number;
  /** ... centred this far (radii) from the ghost's centre towards the sun: what is left is a crescent. */
  biteShift: number;
}

const ghost = (g: Partial<GhostDef> & Pick<GhostDef, 'k' | 'radius' | 'energy' | 'tint' | 'blur'>): GhostDef => ({
  round: 0.2,
  rim: 0,
  gradient: 0.3,
  chroma: 0,
  flip: 1,
  vignette: 0.5,
  aspect: 1,
  hollow: 0,
  bite: 0,
  biteShift: 0,
  ...g,
  tint: normaliseTint(g.tint),
});

/**
 * Eleven ghosts, no two alike, in three groups and three singles. Energies are of the order of two coated
 * reflections (1e-5 of the source and less) into areas of 5e-4 to 0.06 sr: at the exposure of a sunlit scene
 * the brightest is about a tenth of mid-grey and most are a few display levels.
 */
export const GHOSTS: readonly GhostDef[] = [
  // Near the image centre, opposite the sun: a small bright oval.
  ghost({ k: -0.22, radius: 0.01, energy: 1.2e-6, tint: [0.8, 0.97, 1.0], blur: 1.0, round: 0.9, aspect: 1.5, gradient: 0.2, vignette: 0.3 }),
  // A group of three that overlap: a dark-rimmed heptagon, a soft violet blob over it, a small warm iris with a bright edge.
  ghost({ k: -0.41, radius: 0.024, energy: 3.4e-6, tint: [0.5, 0.68, 1.0], blur: 1.6, round: 0.1, rim: -0.55, chroma: 0.08, flip: -1 }),
  ghost({ k: -0.47, radius: 0.034, energy: 4.5e-6, tint: [0.75, 0.55, 1.0], blur: 5, round: 0.5, gradient: 0.4, vignette: 0.6 }),
  ghost({ k: -0.52, radius: 0.013, energy: 1.4e-6, tint: [1.0, 0.8, 0.5], blur: 1.2, rim: 0.5, chroma: 0.1, flip: -1, vignette: 0.4 }),
  // A pair: a strongly defocused green blob and a blue crescent beside it.
  ghost({ k: -0.95, radius: 0.05, energy: 8.0e-6, tint: [0.55, 1.0, 0.7], blur: 9, round: 1, gradient: 0.5, vignette: 0.7 }),
  ghost({ k: -1.1, radius: 0.03, energy: 4.0e-6, tint: [0.6, 0.75, 1.0], blur: 1.4, round: 0.6, rim: 0.1, chroma: 0.06, flip: -1, bite: 0.95, biteShift: 0.55 }),
  // Far side: one very large, very soft magenta veil.
  ghost({ k: -1.7, radius: 0.15, energy: 2.2e-5, tint: [1.0, 0.65, 0.9], blur: 14, round: 1, gradient: 0.6, vignette: 0.9 }),
  // Between the image centre and the sun: an amber iris and a hollow teal one over it.
  ghost({ k: 0.34, radius: 0.03, energy: 3.0e-6, tint: [1.0, 0.8, 0.55], blur: 2.5, round: 0.3, rim: 0.2, chroma: 0.07 }),
  ghost({ k: 0.41, radius: 0.044, energy: 5.0e-6, tint: [0.55, 0.95, 0.85], blur: 6, round: 0.7, hollow: 0.5, flip: -1, vignette: 0.6 }),
  // Close to the sun: a small sharp one.
  ghost({ k: 0.8, radius: 0.011, energy: 1.0e-6, tint: [0.9, 0.9, 1.0], blur: 1.0, round: 0.4, rim: -0.3, chroma: 0.12, gradient: 0.2, vignette: 0.3 }),
  // Beyond the sun, far from the others: a faint ring.
  ghost({ k: 1.45, radius: 0.08, energy: 7.0e-6, tint: [0.7, 0.6, 1.0], blur: 2.0, round: 0.9, hollow: 0.92, chroma: 0.05, flip: -1, gradient: 0.4, vignette: 0.8 }),
];

export const FLARE_TOTAL_ENERGY = STARBURST.haloEnergy + STARBURST.rayEnergy + STARBURST.streakEnergy + GHOSTS.reduce((s, g) => s + g.energy, 0);

// ------------------------------------------------------------------------------------------------ iris geometry

/** Blade whose edge sends ray j (0..SPIKE_COUNT - 1, nominal angle j x 2 pi / SPIKE_COUNT): rays 2b and 2b + BLADE_COUNT. */
export const spikeBlade = (j: number): number => {
  const m = ((j % SPIKE_COUNT) + SPIKE_COUNT) % SPIKE_COUNT;
  return (m % 2 === 0 ? m : (m + BLADE_COUNT) % SPIKE_COUNT) / 2;
};
/** Strength of ray j: its blade's amplitude, split between the blade's two rays by its asymmetry (their mean is the amplitude). */
export const spikeAmplitude = (j: number): number => {
  const m = ((j % SPIKE_COUNT) + SPIKE_COUNT) % SPIKE_COUNT;
  const b = BLADES[spikeBlade(j)]!;
  return (b.amplitude * 2 * (m % 2 === 0 ? b.asymmetry : 1)) / (1 + b.asymmetry);
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

export const glareHalo = (theta: number): number => (1 + (theta / STARBURST.haloAngle) ** 2) ** -1.5;

/**
 * Light per unit length along a ray or streak of length `length` at angle theta, for relative wavelength lambda:
 * flat inside the knee, theta^-2 beyond, ending exactly at lambda x length ((1 - x^2)^2: no step, no kink).
 */
function alongProfile(theta: number, length: number, lambda: number): number {
  const t = theta / lambda;
  const x = t / length;
  if (x >= 1) return 0;
  const w = 1 - x * x;
  return (w * w) / (1 + (t / STARBURST.rayKnee) ** 2) / lambda;
}

/**
 * One channel of the ray set at angle theta from the sun and azimuth phi (from the image-plane up towards right),
 * unnormalised: amplitude x along(theta / lambda) x colour fringes x a unit-integral Gaussian across.
 */
export function rayProfile(theta: number, phi: number, sunRadius: number, lambda: number): number {
  if (theta >= RAY_REACH) return 0;
  const seg = (2 * Math.PI) / SPIKE_COUNT;
  const j = Math.round(phi / seg);
  const blade = BLADES[spikeBlade(j)]!;
  const along = alongProfile(theta, blade.length, lambda);
  if (along <= 0) return 0;
  const dphi = phi - j * seg - blade.angle;
  const across = theta * Math.sin(dphi);
  const w0 = STARBURST.rayDiscSigma * sunRadius;
  const sigma = Math.sqrt(w0 * w0 + (blade.fan * theta) ** 2);
  // The fringes of all wavelengths agree at the sun and run apart with the angle: white, then colour bands.
  const fringe = 1 + STARBURST.fringeDepth * Math.exp(-((theta / STARBURST.fringeReach) ** 2)) * Math.cos((2 * Math.PI * theta) / (lambda * STARBURST.fringePeriod));
  return (spikeAmplitude(j) * along * fringe * Math.exp((-0.5 * across * across) / (sigma * sigma))) / (2.5066282746 * sigma);
}

/** One channel of the streak table at (theta, phi), unnormalised: the streak of the pixel's azimuth cell and of the two cells beside it. */
export function streakProfile(theta: number, phi: number, sunRadius: number, lambda: number): number {
  if (theta >= RAY_REACH) return 0;
  const cell = (2 * Math.PI) / STREAK_COUNT;
  const c = Math.min(STREAK_COUNT - 1, Math.max(0, Math.floor((phi + Math.PI) / cell)));
  const w0 = STARBURST.rayDiscSigma * sunRadius;
  const sigma = Math.sqrt(w0 * w0 + (STARBURST.streakFan * theta) ** 2);
  let sum = 0;
  for (let k = -1; k <= 1; k++) {
    const s = STREAKS[(c + k + STREAK_COUNT) % STREAK_COUNT]!;
    const along = alongProfile(theta, s.length, lambda);
    if (along <= 0) continue;
    const across = theta * Math.sin(phi - s.azimuth);
    sum += s.amplitude * along * Math.exp((-0.5 * across * across) / (sigma * sigma));
  }
  return sum / (2.5066282746 * sigma);
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

/** Lateral effects (gradient, colour fringe) fade in with the sun's distance from the axis: a ghost of an on-axis source is symmetric. */
export const ghostLateral = (offAxis: number): number => smooth01(offAxis / 0.2);

/**
 * Ghost image at the tangent-plane point (px, py) (rad; right, up) from its centre, unnormalised: soft-edged
 * iris image x fill x cat's-eye clip x crescent cut. `blue` = the blue image, which is larger by the ghost's
 * lateral colour on the side away from the image centre (red and green share one image).
 */
export function ghostShape(g: GhostDef, f: GhostFrame, px: number, py: number, blue = false): number {
  const lateral = ghostLateral(f.offAxis);
  const R0 = g.radius;
  const s = g.blur * f.sunRadius;
  const c = blue ? g.chroma * lateral : 0;
  const R = R0 * (1 + c);
  const x = px - f.axis[0] * c * R0;
  const y = py - f.axis[1] * c * R0;
  // Along / across the axis-to-sun line; the along coordinate is compressed by the aspect (an oval).
  const u = (x * f.axis[0] + y * f.axis[1]) / g.aspect;
  const v = -x * f.axis[1] + y * f.axis[0];
  const qx = f.axis[0] * u - f.axis[1] * v;
  const qy = f.axis[1] * u + f.axis[0] * v;
  let poly = -Infinity;
  for (let b = 0; b < BLADE_COUNT; b++) {
    const a = bladeAngle(b);
    poly = Math.max(poly, g.flip * (qx * Math.sin(a) + qy * Math.cos(a)));
  }
  const d = poly + (Math.hypot(qx, qy) / POLY_EQ_CIRCLE - poly) * g.round;
  const mask = smooth01(0.5 - (d - R) / (2 * s));
  if (mask <= 0) return 0;
  const rel = Math.min(d / R, 1);
  const fill = (1 + g.rim * (smooth01((rel - 0.55) / 0.45) - 0.5)) * (1 - g.hollow * (1 - rel * rel));
  const grad = Math.max(0, 1 + (g.gradient * lateral * u) / R0);
  // Cat's eye: a second aperture, displaced towards the image centre in proportion to the sun's off-axis tangent.
  const shift = g.vignette * f.offAxis * R0;
  const dv = Math.hypot(x + f.axis[0] * shift, y + f.axis[1] * shift);
  let clip = smooth01(0.5 - (dv - GHOST_CLIP_RADIUS * R0 - 2 * s) / (2 * s));
  // Crescent: a disc cut out on the side towards the sun.
  if (g.bite > 0) {
    const db = Math.hypot(x - f.axis[0] * g.biteShift * R0, y - f.axis[1] * g.biteShift * R0);
    clip *= smooth01(0.5 + (db - g.bite * R0) / (2 * s));
  }
  return mask * fill * grad * clip;
}

/** The three channels of a ghost at (px, py): red and green share one image; the blue one is evaluated when the ghost has lateral colour. */
export function ghostImage(g: GhostDef, f: GhostFrame, px: number, py: number): Vec3Tuple {
  const v = ghostShape(g, f, px, py);
  return [v, v, g.chroma > 0 ? ghostShape(g, f, px, py, true) : v];
}

/** Angular radius (rad) beyond which a ghost is zero in every channel. */
export const ghostSupport = (g: GhostDef, sunRadius: number): number => ((g.radius * (1 + g.chroma) + g.blur * sunRadius) / POLY_MIN_COS) * Math.max(1, g.aspect) + g.chroma * g.radius;

// ------------------------------------------------------------------------------------------- normalisation

/** Integral over the sphere outside the solar disc of an axially symmetric profile (sr). */
function ringIntegral(f: (theta: number) => number, sunRadius: number): number {
  let s = 0;
  const n = 6000;
  const la = Math.log(sunRadius);
  const lb = Math.log(Math.PI);
  for (let i = 0; i < n; i++) {
    // Logarithmic steps in theta: fine near the disc, where the narrow profiles are.
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / n);
    s += f(th) * 2 * Math.PI * Math.sin(th) * ((th * (lb - la)) / n);
  }
  return s;
}

/**
 * Integral over the sphere outside the disc (sr) of a profile of (theta, phi) made of radial lines no narrower
 * than `minSigma` (rad): rings in logarithmic steps out to RAY_REACH, each sampled at half that width.
 */
function lineSetIntegral(profile: (theta: number, phi: number) => number, sunRadius: number, minSigma: (theta: number) => number): number {
  let s = 0;
  const nt = 700;
  const la = Math.log(sunRadius);
  const lb = Math.log(RAY_REACH);
  for (let i = 0; i < nt; i++) {
    const th = Math.exp(la + ((i + 0.5) * (lb - la)) / nt);
    const np = Math.min(6000, Math.max(SPIKE_COUNT * 24, Math.ceil((4 * Math.PI * th) / minSigma(th))));
    let ring = 0;
    for (let j = 0; j < np; j++) ring += profile(th, -Math.PI + ((j + 0.5) * 2 * Math.PI) / np);
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * ((th * (lb - la)) / nt);
  }
  return s;
}

const lineSigma = (sunRadius: number, fan: number) => (theta: number): number => Math.sqrt((STARBURST.rayDiscSigma * sunRadius) ** 2 + (fan * theta) ** 2);

/** Integral of the ray set of one channel over the sphere outside the disc (sr). */
export const rayIntegral = (lambda: number, sunRadius: number): number =>
  lineSetIntegral((th, phi) => rayProfile(th, phi, sunRadius, lambda), sunRadius, lineSigma(sunRadius, Math.min(...BLADES.map((b) => b.fan))));

/** Integral of the streak table of one channel over the sphere outside the disc (sr). */
export const streakIntegral = (lambda: number, sunRadius: number): number => lineSetIntegral((th, phi) => streakProfile(th, phi, sunRadius, lambda), sunRadius, lineSigma(sunRadius, STARBURST.streakFan));

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
      ring += ghostShape(g, f, th * Math.sin(phi), th * Math.cos(phi));
    }
    s += ((ring * 2 * Math.PI) / np) * Math.sin(th) * (support / nr);
  }
  return s;
}

export interface FlareNormalisation {
  /** 1 / integral (1/sr) of the halo, the rays and the streaks (green channel), each ghost (green channel). */
  halo: number;
  rays: number;
  streaks: number;
  ghosts: number[];
  /** Solar angular radius (rad) the integrals were computed for. */
  sunRadius: number;
}

let normCache: FlareNormalisation | null = null;

/** Normalisation of the flare profiles for a solar disc of angular radius `sunRadius` (recomputed when it changes by 0.1 %). */
export function flareNormalisation(sunRadius: number): FlareNormalisation {
  if (normCache && Math.abs(sunRadius - normCache.sunRadius) < 1e-3 * sunRadius) return normCache;
  normCache = {
    halo: 1 / ringIntegral(glareHalo, sunRadius),
    rays: 1 / rayIntegral(1, sunRadius),
    streaks: 1 / streakIntegral(1, sunRadius),
    ghosts: GHOSTS.map((g) => 1 / ghostIntegral(g, sunRadius)),
    sunRadius,
  };
  return normCache;
}

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
  const halo = STARBURST.haloEnergy * n.halo * glareHalo(theta);
  const out: Vec3Tuple = [halo * STARBURST.haloTint[0], halo * STARBURST.haloTint[1], halo * STARBURST.haloTint[2]];
  if (theta < RAY_REACH) {
    // Rays and streaks: azimuth about the sun in the image plane, from the camera's up towards its right.
    const bs = tangentBasis(g.view, s);
    const ds = dot3(d, s);
    const ts = { x: d.x - s.x * ds, y: d.y - s.y * ds, z: d.z - s.z * ds };
    const phi = Math.atan2(dot3(ts, bs.rt), dot3(ts, bs.up));
    for (let c = 0; c < 3; c++) {
      out[c] = out[c]! + STARBURST.rayEnergy * n.rays * rayProfile(theta, phi, g.sunRadius, SPIKE_LAMBDA[c]!) + STARBURST.streakEnergy * n.streaks * streakProfile(theta, phi, g.sunRadius, SPIKE_LAMBDA[c]!);
    }
  }
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
    const img = ghostImage(gh, gf, px, py);
    for (let c = 0; c < 3; c++) out[c] = out[c]! + gh.energy * gh.tint[c]! * n.ghosts[i]! * img[c]!;
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
