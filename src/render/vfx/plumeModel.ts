/**
 * Gas-dynamic shape of an exhaust jet as a pure function of the nozzle, the throttle and the ambient
 * pressure. This is the single source of the numbers the plume shader marches (uploaded per nozzle) and
 * the reference the browser tests measure rendered density slices against.
 *
 *  - Exit Mach number Me from the chamber / exit pressure ratio (isentropic, fixed by the nozzle).
 *  - Fully expanded jet Mach number Mj from the chamber / ambient pressure ratio.
 *  - Initial expansion half-angle at the lip: theta = nu(Mj) - nu(Me) + nozzle wall angle (Prandtl-Meyer
 *    turn; negative = the over-expanded jet is pinched), clamped to [-8, 85] deg.
 *  - Inviscid boundary r(x) = re + Lexp tan(theta) (1 - exp(-x / Lexp)); an under-expanded jet relaxes over
 *    Lexp = 6 re sqrt(eta), an over-expanded one contracts to the fully expanded radius re sqrt(eta).
 *  - Turbulent mixing spread of 5 deg (tan = 0.09) scaled by the ambient density, starting with zero slope
 *    so the lip angle is the Prandtl-Meyer angle.
 *  - Shock cells for 0.25 < eta < 4 with the Prandtl-Pack spacing Ls = 1.306 Dj sqrt(Mj^2 - 1),
 *    Dj = 2 re sqrt(max(eta, 0.3)).
 */
import type { Vec3Tuple } from '@/core/math';
import type { PlumeLookDef } from './data';

const DEG = Math.PI / 180;
export const SEA_LEVEL_PRESSURE = 101325;
export const THETA_MIN = -8 * DEG;
export const THETA_MAX = 85 * DEG;
/** tan(5 deg): spread of a fully turbulent mixing layer. */
export const MIXING_SPREAD = 0.09;
/** Shock cells are drawn for pressure ratios inside this window (faded in and out at its edges). */
export const CELL_ETA_MIN = 0.25;
export const CELL_ETA_MAX = 4;
/** Pressure ratios between which a jet goes over from a column held by the ambient air to a free expansion. */
export const FAR_ETA_MIN = 4;
export const FAR_ETA_MAX = 40;

export interface NozzleGeometry {
  /** Exit radius, m. */
  exitRadius: number;
  /** Exit static pressure and chamber pressure at full throttle, Pa. */
  exitPressure: number;
  chamberPressure: number;
}

export interface JetShape {
  /** Exit / ambient pressure ratio at this throttle (1e6 in vacuum). */
  eta: number;
  exitMach: number;
  jetMach: number;
  /** Initial expansion half-angle of the jet boundary at the lip, rad (negative = pinched). */
  theta: number;
  tanTheta: number;
  /** Relaxation length of the inviscid boundary, m. */
  lExp: number;
  /** Asymptotic slope of the mixing layer and its development length, m. */
  mixSlope: number;
  mixDev: number;
  /** Shock-cell spacing (Prandtl-Pack), m, and visibility 0..1 of the cells at this pressure ratio. */
  shockSpacing: number;
  cellAmp: number;
  /** 0..1: how much ambient air there is to afterburn with. */
  oxygen: number;
  /** 0 at sea level .. 1 in vacuum. */
  vacuum: number;
  /**
   * 0..1: how far the jet has become a free expansion (a jet at more than about forty times the ambient
   * pressure, and every jet in vacuum). The gas of such a jet is spread by angle from the nozzle,
   * density ~ farAmp (re / R)^2 cos^k(theta pi / (2 thetaLimit)), instead of filling a column.
   */
  far: number;
  /** On-axis density of the free expansion relative to (re / R)^2 (from the conservation of mass flow). */
  farAmp: number;
  /** Limiting angle of the free expansion, rad. */
  thetaLimit: number;
  /** e-folding lengths of the core and shear emission and the LENGTH of the turbulent flame (its ragged tip), m. */
  coreLength: number;
  shearLength: number;
  afterLength: number;
  /** Extent of everything brighter than the visible fraction of the exit column brightness: along the axis and radially, m. */
  visibleLength: number;
  visibleRadius: number;
}

const smoothstep = (a: number, b: number, x: number): number => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** Prandtl-Meyer function nu(M), rad. */
export function prandtlMeyer(mach: number, gamma: number): number {
  const m2 = Math.max(mach * mach - 1, 0);
  const k = Math.sqrt((gamma + 1) / (gamma - 1));
  return k * Math.atan(Math.sqrt(m2) / k) - Math.atan(Math.sqrt(m2));
}

/** Mach number reached by an isentropic expansion through the total / static pressure ratio. */
export function machFromPressureRatio(totalOverStatic: number, gamma: number): number {
  const ratio = Math.max(totalOverStatic, 1);
  return Math.sqrt((2 / (gamma - 1)) * (Math.pow(ratio, (gamma - 1) / gamma) - 1));
}

/** Prandtl-Pack shock-cell spacing for a jet of fully expanded Mach number `jetMach`, m. */
export function shockCellSpacing(exitRadius: number, eta: number, jetMach: number): number {
  const dj = 2 * exitRadius * Math.sqrt(Math.max(eta, 0.3));
  return 1.306 * dj * Math.sqrt(Math.max(jetMach * jetMach - 1, 0.05));
}

/** Boundary radius of the jet (half-density contour) at distance x from the exit plane, m. */
export function jetBoundaryRadius(shape: JetShape, exitRadius: number, x: number): number {
  const xc = Math.max(x, 0);
  const inviscid = exitRadius + shape.lExp * shape.tanTheta * (1 - Math.exp(-xc / shape.lExp));
  return inviscid + shape.mixSlope * (xc - shape.mixDev * (1 - Math.exp(-xc / shape.mixDev)));
}

/** Luminance of a sunlit column of particulates per unit of scattering optical depth: 128,000 lx / 4 pi, cd/m^2. */
export const SUN_SCATTER_LUMINANCE = 128000 / (4 * Math.PI);

/** The fan of a free expansion is never followed further than this many exit radii. */
export const FAR_REACH_RE = 400;

/** Default cut-off of the visible extent: fraction of the exit column brightness. */
export const DEFAULT_VISIBLE_FRACTION = 5e-4;

/** Slope of the cone that holds the bulk of the gas of a widely expanding jet (the rest is a thin halo out to the boundary). */
export const BULK_SLOPE = 0.8;

/**
 * Radius that holds the bulk of the gas at x: the boundary itself for a narrow jet; for a jet that balloons
 * (near vacuum) the gas stays concentrated around the axis inside a cone of slope BULK_SLOPE.
 */
export function jetBulkRadius(shape: JetShape, exitRadius: number, x: number): number {
  return Math.min(jetBoundaryRadius(shape, exitRadius, x), 2 * exitRadius + BULK_SLOPE * Math.max(x, 0));
}

/**
 * Relative column brightness of the core seen side-on at x (1 at the exit plane). `farGain` / `nearLength`:
 * what the thin gas far from the nozzle radiates relative to the gas at the exit, and the distance over
 * which the emission falls to that (the vacuum gain of the look; 1 at sea level).
 */
function columnBrightness(shape: JetShape, re: number, x: number, exponent: number, farGain: number, nearLength: number): number {
  const rb = jetBulkRadius(shape, re, x);
  const thin = 1 + (farGain - 1) * (1 - Math.exp(-x / nearLength));
  return Math.pow(re / rb, 2 * exponent - 1) * Math.exp(-x / shape.coreLength) * thin;
}

/**
 * Shape of one jet. `throttle` (0..1) scales chamber and exit pressure; `ambientPressure` in Pa (0 in
 * vacuum). `lengthRadius` is the radius the emission lengths scale with (a merged cluster jet: the radius
 * of one nozzle times sqrt(nozzle count); default: the exit radius). `visibleFraction` is the fraction of
 * the exit column brightness below which the jet counts as invisible (the renderer derives it from the
 * exposure, so that a faint vacuum plume is not cut off in a dark-adapted frame).
 */
export function jetShape(look: PlumeLookDef, nozzle: NozzleGeometry, throttle: number, ambientPressure: number, options: { lengthRadius?: number; visibleFraction?: number } = {}): JetShape {
  const lengthRadius = options.lengthRadius ?? nozzle.exitRadius;
  const g = look.gamma;
  const re = nozzle.exitRadius;
  const thr = Math.min(1, Math.max(throttle, 0.02));
  const pa = Math.max(ambientPressure, 1);
  const eta = Math.min(1e6, (nozzle.exitPressure * thr) / pa);
  const exitMach = Math.max(1.05, machFromPressureRatio(nozzle.chamberPressure / nozzle.exitPressure, g));
  const jetMach = Math.max(1.05, machFromPressureRatio((nozzle.chamberPressure * thr) / pa, g));
  const theta = Math.min(Math.min(THETA_MAX, look.maxExpansionDeg * DEG), Math.max(THETA_MIN, prandtlMeyer(jetMach, g) - prandtlMeyer(exitMach, g) + look.nozzleHalfAngleDeg * DEG));
  const tanTheta = Math.tan(theta);
  const far = smoothstep(Math.log(FAR_ETA_MIN), Math.log(FAR_ETA_MAX), Math.log(Math.max(eta, 1e-6)));
  const thetaLimit = Math.max(theta, 8 * DEG);
  // Mass flow through the exit = mass flow through a far sphere: A = 1 / (2 int cos^k(theta pi / 2 thetaLimit) sin(theta) dtheta).
  let integral = 0;
  for (let i = 0; i < 48; i++) {
    const th = ((i + 0.5) / 48) * thetaLimit;
    integral += Math.pow(Math.cos((th * Math.PI) / (2 * thetaLimit)), look.farField.exponent) * Math.sin(th) * (thetaLimit / 48);
  }
  const farAmp = 1 / (2 * Math.max(integral, 1e-4));
  let lExp: number;
  if (theta < -0.5 * DEG) {
    // Over-expanded: the jet contracts to its fully expanded radius re sqrt(eta).
    const rInf = re * Math.sqrt(Math.min(1, Math.max(eta, 0.3)));
    lExp = Math.min(12 * re, Math.max(0.5 * re, (re - rInf) / -tanTheta));
  } else {
    lExp = 6 * re * Math.sqrt(Math.max(eta, 1));
    // A strongly under-expanded jet balloons to about 1.3 re sqrt(eta) before the ambient pressure holds it
    // (30 km: ten exit radii; 60 km: seventy; vacuum: no boundary within sight).
    const held = (1.3 * re * Math.sqrt(eta)) / Math.max(tanTheta, 0.05);
    lExp += (Math.min(lExp, held) - lExp) * far;
  }
  const pRel = Math.min(1, pa / SEA_LEVEL_PRESSURE);
  const mixSlope = MIXING_SPREAD * Math.pow(pRel, 0.25) * (ambientPressure > 1 ? 1 : 0);
  // The shear layer of a supersonic jet grows slowly at first (compressibility): full spread after about 30 radii.
  const mixDev = 30 * re;
  const window = smoothstep(0.8 * CELL_ETA_MIN, 1.2 * CELL_ETA_MIN, eta) * (1 - smoothstep(0.75 * CELL_ETA_MAX, CELL_ETA_MAX, eta));
  const cellAmp = window * Math.min(1, 0.25 + Math.abs(Math.log(eta)) / 0.4);
  // Afterburning needs air dense enough to hold a flame: gone below about 1 kPa. Up to there the fuel-rich
  // exhaust still finds the air it needs, in a longer and wider flame: at 15 km (12 kPa, where the vehicle
  // passes its greatest dynamic pressure) the flame is a third as bright as at the pad, not a sixth.
  const oxygen = Math.pow(pRel, 0.5) * smoothstep(600, 4000, ambientPressure);
  const vacuum = 1 - Math.pow(pRel, 0.35) * (ambientPressure > 1 ? 1 : 0);
  const lenThr = Math.pow(thr, 0.4);
  const coreLength = lengthRadius * (look.core.lengthRe + (look.core.vacuumLengthRe - look.core.lengthRe) * vacuum) * lenThr;
  const shearLength = lengthRadius * look.shear.lengthRe * lenThr;
  const afterLength = lengthRadius * look.afterburn.lengthRe * lenThr;
  const shape: JetShape = {
    eta,
    exitMach,
    jetMach,
    theta,
    tanTheta,
    lExp,
    mixSlope,
    mixDev,
    shockSpacing: shockCellSpacing(re, eta, jetMach),
    cellAmp,
    oxygen,
    vacuum,
    far,
    farAmp,
    thetaLimit,
    coreLength,
    shearLength,
    afterLength,
    visibleLength: 0,
    visibleRadius: 0,
  };

  // Visible extent. Core: where the side-on column brightness has fallen to EPS of its exit value;
  // afterburning terms: three e-folding lengths while there is air to burn with.
  const EPS = Math.min(5e-3, Math.max(1e-7, options.visibleFraction ?? DEFAULT_VISIBLE_FRACTION));
  const exponent = look.core.densityExponent;
  const farGain = 1 + (look.core.vacuumGain - 1) * vacuum;
  const nearLength = look.core.vacuumCoreRe * re;
  // What is seen of a jet is its glowing core or, for a smoky one, its particulates in sunlight (taken at
  // full sun: the extent is a bound), whichever is brighter relative to the exit brightness of the core.
  const smokeGain = (Math.max(look.smoke.sunScatter, (look.smoke.glow * look.smoke.extinction) / SUN_SCATTER_LUMINANCE) * SUN_SCATTER_LUMINANCE) / Math.max(look.core.luminance, 1);
  const smokeAt = (x: number): number => smokeGain * (re / jetBulkRadius(shape, re, x)) * Math.exp(-x / (look.smoke.lengthRe * re));
  // A free expansion in sunlight: the column through the fan at distance x holds about 0.75 farAmp re^2 / x of gas.
  const fanGain = (far * look.farField.scatter * SUN_SCATTER_LUMINANCE * 0.38 * farAmp) / Math.max(look.core.luminance, 1);
  const fanAt = (x: number): number => (fanGain * re) / Math.max(x, re);
  const brightness = (x: number): number => Math.max(columnBrightness(shape, re, x, exponent, farGain, nearLength), smokeAt(x), fanAt(x));
  let lo = 0;
  let hi = Math.max(8 * coreLength, smokeGain > EPS ? 4 * look.smoke.lengthRe * re : 0, Math.min(FAR_REACH_RE * re, (fanGain * re) / EPS));
  if (brightness(hi) > EPS) lo = hi;
  else {
    for (let i = 0; i < 40; i++) {
      const mid = 0.5 * (lo + hi);
      if (brightness(mid) > EPS) lo = mid;
      else hi = mid;
    }
  }
  const burn = oxygen > 0.01 ? Math.max(look.shear.luminance > 0 ? 3 * shearLength * Math.min(1, 0.35 + oxygen) : 0, look.afterburn.luminance > 0 ? 2.1 * afterLength : 0) : 0;
  shape.visibleLength = Math.min(Math.max(lo, burn, 3 * re), Math.max(FAR_REACH_RE * re, burn, 8 * coreLength));
  let radius = re * 1.5;
  for (let i = 1; i <= 24; i++) {
    const x = (shape.visibleLength * i) / 24;
    const rb = jetBoundaryRadius(shape, re, x);
    const b = brightness(x);
    // Gaussian core of width core.radius x bulk radius: radius where it has dropped to EPS of the exit brightness.
    const core = b > EPS ? look.core.radius * jetBulkRadius(shape, re, x) * Math.sqrt(Math.log(b / EPS)) : 0;
    // (The flame is pushed out to 2.6 boundary radii by its large eddies.)
    const shear = x < burn ? 2.6 * rb + 2 * re : 0;
    // Particulates: a core 1.3 times as wide as the glow, or the whole cross-section of the jet.
    const s = smokeAt(x);
    const smoke = s > EPS ? (look.smoke.halo > 0.5 ? 1.5 * rb : Math.max(1.3 * look.core.radius * jetBulkRadius(shape, re, x) * Math.sqrt(Math.log(s / EPS)), look.smoke.halo > 0 ? 1.5 * Math.min(rb, 2 * re + BULK_SLOPE * x) : 0)) : 0;
    // The fan of a free expansion: out to the angle where its density is a hundredth of that on the axis.
    const fan = far > 0 && fanAt(x) > EPS ? x * Math.tan(Math.min(1.35, farVisibleAngle(look, thetaLimit))) + 2 * re : 0;
    radius = Math.max(radius, core, shear, Math.min(smoke, 1.5 * rb + re), fan);
  }
  shape.visibleRadius = radius;
  return shape;
}

/** Angle from the axis at which the density of a free expansion has fallen to a hundredth of its on-axis value, rad. */
export function farVisibleAngle(look: PlumeLookDef, thetaLimit: number): number {
  return (Math.acos(Math.pow(0.01, 1 / look.farField.exponent)) * 2 * thetaLimit) / Math.PI;
}

/** Luminous intensity of the light a plume casts (linear sRGB x cd): proportional to thrust. */
export function plumeLightIntensity(look: PlumeLookDef, thrust: number): Vec3Tuple {
  const i = look.light.efficacy * Math.max(thrust, 0);
  return [look.light.color[0] * i, look.light.color[1] * i, look.light.color[2] * i];
}

/**
 * Emission scale of an engine from its module state: the throttle, the start-up flash, and the fading
 * residual flame after shutdown. Returns 0 when nothing is to be drawn.
 */
export function engineEmissionState(
  look: PlumeLookDef,
  s: { throttleActual: number; ignitionAge: number; shutdownAge: number },
): { throttle: number; front: number; flash: number; residual: number } {
  const residual = s.shutdownAge >= 0 ? Math.exp(-s.shutdownAge / look.shutdown.fadeTime) : 0;
  const throttle = Math.max(s.throttleActual, 0);
  if (throttle < 0.002 && residual < 0.02) return { throttle: 0, front: 0, flash: 0, residual: 0 };
  // The start-up front runs down the jet; while running the whole jet is lit.
  const front = s.ignitionAge >= 0 && throttle >= 0.002 ? look.ignition.frontSpeed * (s.ignitionAge + 1 / 120) : 1e9;
  // The start-up puff is gone, exactly, after flashTime.
  const flash = s.ignitionAge >= 0 && s.ignitionAge < look.ignition.flashTime ? look.ignition.flash * (1 - s.ignitionAge / look.ignition.flashTime) ** 2 : 0;
  return { throttle, front, flash, residual };
}
