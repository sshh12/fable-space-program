// Orbit definitions of the staged bodies, by source (ARCHITECTURE 8.2 and the brief):
//
//   approx-pos  JPL Table 1 (planets): ecliptic elements at J2000 with their six rates; M = L - long.peri.,
//               argPe = long.peri. - node; the mean motion is the table's (L rate - long.peri. rate).
//   sun-v1      Earth: { kind: 'sunLowPrecision', inverted: true } (the v1 Almanac Sun, negated).
//   frozen-v1   the Moon: the orbit block of data/defs/bodies/moon.json, byte for byte.
//   sat-table   JPL satellite mean elements at their epoch (2000-01-01.5 TDB = ut 0), plane frames: Laplace
//               -> { pole } (the table's Laplace pole); 'equatorial' -> 'parentEquator', except Uranus, whose
//               moons use the POSITIVE pole (the antipode of the IAU north pole) as an explicit { pole }.
//   sat-fit     the brief's path for Saturn's moons: plane, node, periapsis and phase fitted to Horizons states
//               at the lobby epoch; a, e, the period and the precession periods are the table's.
//   sbdb        osculating heliocentric ecliptic elements of the JPL Small-Body Database, at their own epoch.
//
// The satellite table gives P, P apsis and P node without saying which mean rate P is the period of, nor the
// sense of the two precessions. Eight readings are possible (P = 360 deg / mean-anomaly rate, or / mean-
// longitude rate; apsis and node advancing or regressing). The generator takes, for every moon, the reading
// that reproduces Horizons best over a CALIBRATION window (ten epochs from 2010-01-01 to 2029-09-01, before
// the validation window 2030-2060, so the validation stays independent), and records it.
import { DAY_S, DEG, angleBetween, jdToUt, keplerState } from './kepler.mjs';
import { fitPlanePhase } from './fit.mjs';

export const JULIAN_YEAR_D = 365.25;
/** Default lobby epoch (ARCHITECTURE 5.2: the start of lunar-direct, 2029-09-24T18:26:58), whole seconds. */
export const LOBBY_EPOCH_UT = 938240818;
/** A precession faster than this fraction of the mean motion is not a slowly precessing ellipse. */
export const MAX_PRECESSION_FRACTION = 0.01;

export const READINGS = [];
for (const period of ['anomalistic', 'sidereal']) for (const apsis of [1, -1]) for (const node of [-1, 1]) READINGS.push({ period, apsis, node });
export const readingName = (r) => `P=${r.period}, apsis ${r.apsis > 0 ? 'advancing' : 'regressing'}, node ${r.node > 0 ? 'advancing' : 'regressing'}`;

/** Rates (deg/day) of a table row under a reading; null when the reading is not a slowly precessing ellipse. */
export function readingRates(row, reading, { dropApsis = false } = {}) {
  const apsisListed = row.apsisPeriodYears && !dropApsis ? 360 / (row.apsisPeriodYears * JULIAN_YEAR_D) : 0;
  const nodeListed = row.nodePeriodYears ? 360 / (row.nodePeriodYears * JULIAN_YEAR_D) : 0;
  const w = reading.apsis * apsisListed;
  const O = reading.node * nodeListed;
  const nP = 360 / row.periodDays;
  const n = reading.period === 'anomalistic' ? nP : nP - w - O;
  if (!(n > 0) || Math.abs(w) + Math.abs(O) > MAX_PRECESSION_FRACTION * n) return null;
  return { n, w, O };
}

export function approxPosOrbit(t, AU) {
  const r = t.ratesPerCentury;
  return {
    kind: 'kepler',
    frame: 'ecliptic',
    a: t.a * AU,
    e: t.e,
    iDeg: t.I,
    lanDeg: t.longNode,
    argPeDeg: t.longPeri - t.longNode,
    meanAnomalyDeg: t.L - t.longPeri,
    epochUt: 0,
    rates: { a: r.a * AU, e: r.e, iDeg: r.I, lanDeg: r.longNode, argPeDeg: r.longPeri - r.longNode },
    meanMotionDegPerDay: (r.L - r.longPeri) / 36525,
  };
}

export function sbdbOrbit(s, AU) {
  const el = s.elements;
  return {
    kind: 'kepler',
    frame: 'ecliptic',
    a: el.a * AU,
    e: el.e,
    iDeg: el.iDeg,
    lanDeg: el.nodeDeg,
    argPeDeg: el.argPeDeg,
    meanAnomalyDeg: el.meanAnomalyDeg,
    epochUt: jdToUt(s.epochJdTdb),
    meanMotionDegPerDay: el.meanMotionDegPerDay,
  };
}

/** The plane frame of a satellite table row (see header). */
export function satFrame(row, parentId) {
  if (row.frame === 'Laplace') return { pole: { raDeg: row.laplacePole.raDeg, decDeg: row.laplacePole.decDeg } };
  if (row.frame === 'equatorial') return parentId === 'uranus' ? 'positive-pole-of-parent' : 'parentEquator';
  throw new Error(`satellite frame "${row.frame}" is not one of the three plane frames`);
}

function tableOrbit(row, frame, rates) {
  return {
    kind: 'kepler',
    frame,
    a: row.aKm * 1e3,
    e: row.e,
    iDeg: row.iDeg,
    lanDeg: row.nodeDeg,
    argPeDeg: row.argPeDeg,
    meanAnomalyDeg: row.meanAnomalyDeg,
    epochUt: 0,
    rates: { argPeDeg: rates.w * 36525, lanDeg: rates.O * 36525 },
    meanMotionDegPerDay: rates.n,
  };
}

/** Largest angle (deg) between model and Horizons positions seen from the parent. */
export function maxAngleDeg(def, rows, ctx) {
  let m = 0;
  for (const s of rows) m = Math.max(m, angleBetween(keplerState(def, jdToUt(s.jd), ctx).r, s.r) / DEG);
  return m;
}

/**
 * Build a satellite orbit on the table or fit path, choosing the reading over the calibration rows.
 * `frame` is a resolved KeplerOrbitDef frame; `ctx.parentPole` serves 'parentEquator'.
 */
export function satelliteOrbit({ row, frame, path, calibration, fitSpan, muSum, ctx }) {
  // A listed apsidal period too short for a slowly precessing ellipse (Tethys: 0.005 yr for e = 0.001, the
  // circulation of an ill-defined periapsis) cannot be carried; the apsis is then held fixed, which moves the
  // position by at most e x a. Recorded as `apsisDropped`.
  const dropApsis = READINGS.every((r) => readingRates(row, r) === null) && READINGS.some((r) => readingRates(row, r, { dropApsis: true }) !== null);
  const candidates = [];
  for (const reading of READINGS) {
    const rates = readingRates(row, reading, { dropApsis });
    if (!rates) continue;
    let def = tableOrbit(row, frame, rates);
    let fit = null;
    if (path === 'sat-fit') {
      const pole = frame.pole ?? ctx.parentPole;
      const base = { ...def, frame: { pole }, epochUt: LOBBY_EPOCH_UT };
      const f = fitPlanePhase(base, fitSpan, { muSum });
      def = { ...f.def, frame };
      fit = { rmsKm: f.rms / 1e3, maxKm: f.max / 1e3, samples: fitSpan.length };
    }
    candidates.push({ reading, rates, def, fit, apsisDropped: dropApsis, calibrationMaxDeg: maxAngleDeg(def, calibration, ctx) });
  }
  if (candidates.length === 0) throw new Error(`no reading of the ${row.satellite} row is a slowly precessing ellipse`);
  candidates.sort((a, b) => a.calibrationMaxDeg - b.calibrationMaxDeg);
  return { best: candidates[0], candidates };
}

/** Round a number to `sig` significant digits for the staged files (the round trip is what --check compares). */
export const round = (x, sig = 15) => (x === 0 ? 0 : Number(x.toPrecision(sig)));
export const roundDef = (def) => JSON.parse(JSON.stringify(def, (k, v) => (typeof v === 'number' ? round(v) : v)));
export const DAY = DAY_S;
