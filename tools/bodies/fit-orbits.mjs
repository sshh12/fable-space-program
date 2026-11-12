#!/usr/bin/env node
// Fits the orbit of every body except the Sun, Earth and the Moon to JPL Horizons over the validity window
// 2029-09-01 .. 2060-01-01 (the lead's decision on request bodies-ephemeris-4) and writes the fitted elements,
// their starting values and the fit residuals to tools/bodies/sources/orbit-fits.json, which generate.mjs reads.
// Horizons states are fetched once into data/cache/bodies/horizons/ and reused.
//
//   node tools/bodies/fit-orbits.mjs [id ...]
//
// Starting values: planets the JPL Table 1 elements and rates carried to the epoch; Ceres and Pluto the SBDB
// osculating elements carried to the epoch; satellites the JPL mean elements under the reading chosen over the
// calibration window (a, e, mean motion, precession rates) with the plane and phase of the osculating orbit at
// the epoch - and, for Phobos, Deimos and Triton, whose table periods do not give their mean motion, the
// osculating mean motion of Horizons itself. Stages: the fit is first made over the dense span about the
// epoch, then extended over the window in doubling spans, so the mean longitude is never ambiguous.
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_ORDER, CATALOGUE, horizonsCenter } from './lib/catalogue.mjs';
import { fitEllipse, osculatingStart, toOrbitDef } from './lib/ellipseFit.mjs';
import { formatJson } from './lib/format.mjs';
import { REPO_ROOT } from './lib/http.mjs';
import { AU_M, DAY_S, DEG, ECLIPTIC_TO_ICRF, angleBetween, jdToUt, keplerState, len, matMul, matVec, poleFrame, rotZ, transpose, wrap180 } from './lib/kepler.mjs';
import { LOBBY_EPOCH_UT, MAX_PRECESSION_FRACTION, approxPosOrbit, readingName, round, roundDef, satFrame, satelliteOrbit, sbdbOrbit } from './lib/orbits.mjs';
import { pckRotation } from './lib/pck.mjs';
import { loadSources } from './lib/sources.mjs';
import { WINDOW_START_JD, WINDOW_STOP_JD, denseSamples, windowSamples } from './lib/window.mjs';

/** Satellites whose table period does not give the mean motion: the start rate comes from Horizons. */
export const START_RATE_FROM_HORIZONS = ['phobos', 'deimos', 'triton'];
const MOON_STAGES_D = [30, 60, 120, 240, 480, 960, 1920, 3840, 7680, 12000];

const S = loadSources();
const only = process.argv.slice(2);
const pck = S.pck.vars;
const capital = (s) => s[0].toUpperCase() + s.slice(1);
const gmOf = (id) => {
  const c = CATALOGUE[id];
  if (id === 'sun') return S.astroPar.gmSunM3s2;
  if (c.kind === 'planet' || id === 'pluto') return (S.satPhys.planetGm[capital(id)]?.gm ?? S.astroPar.systemGm[capital(id)]) * 1e9;
  if (id === 'ceres') return Number(S.sbdb['sbdb-ceres'].phys.GM.value) * 1e9;
  return S.satPhys.satellites.find((s) => s.name === c.satName).gm * 1e9;
};
const poleAtEpoch = (id) => {
  const r = pckRotation(pck, CATALOGUE[id].naif).at(LOBBY_EPOCH_UT);
  return { raDeg: r.poleRaDeg, decDeg: r.poleDecDeg };
};
const src = (m) => ({ url: m.url, retrievedAt: m.retrievedAt });

/** Elements of a KeplerOrbitDef with rates carried to `ut` (deg, deg/day). */
function carry(def, ut) {
  const T = (ut - def.epochUt) / (36525 * DAY_S);
  const r = def.rates ?? {};
  const node = r.lanDeg ?? 0;
  const argPe = r.argPeDeg ?? 0;
  return {
    a: def.a + (r.a ?? 0) * T,
    e: def.e + (r.e ?? 0) * T,
    iDeg: def.iDeg + (r.iDeg ?? 0) * T,
    lanDeg: def.lanDeg + node * T,
    argPeDeg: def.argPeDeg + argPe * T,
    meanAnomalyDeg: def.meanAnomalyDeg + def.meanMotionDegPerDay * ((ut - def.epochUt) / DAY_S),
    meanMotionDegPerDay: def.meanMotionDegPerDay,
    nodeRateDegPerDay: node / 36525,
    apsisRateDegPerDay: (node + argPe) / 36525,
  };
}

function residual(samples, fit) {
  let maxAngle = 0;
  let maxRadial = 0;
  let sum = 0;
  for (const s of samples) {
    const m = fit.positionAt((jdToUt(s.jd) - LOBBY_EPOCH_UT) / DAY_S);
    const ang = angleBetween(m, s.r) / DEG;
    maxAngle = Math.max(maxAngle, ang);
    maxRadial = Math.max(maxRadial, Math.abs(len(m) - len(s.r)) / len(s.r));
    sum += ang * ang;
  }
  return { maxAngleDeg: maxAngle, maxRadial, rmsAngleDeg: Math.sqrt(sum / samples.length), samples: samples.length };
}

/** Sub-parent longitude (deg) of a moon at relative position r (moon from parent), for a pole and W (deg). */
function subParentLongitude(r, poleRaDeg, poleDecDeg, wDeg) {
  const toBody = transpose(matMul(poleFrame(poleRaDeg, poleDecDeg), rotZ(wDeg * DEG)));
  const u = matVec(toBody, [-r[0], -r[1], -r[2]]);
  return Math.atan2(u[1], u[0]) / DEG;
}

/**
 * A satellite whose pck00011 rotation is synchronous (|W1| within 1 % of the fitted mean-longitude rate) gets a
 * rotation that keeps its face to the parent on the fitted orbit: the pole of the full model at the epoch and,
 * of two candidates, the one whose sub-parent longitude over the window stays closest to the truth (Horizons
 * position, full pck00011 rotation with its libration terms):
 *   A  rate = the fitted orbit's mean-longitude rate (n + node rate + apsis rate, the sign of W1), W0 = the full
 *      model's W at the epoch;
 *   B  W0 and rate of a least-squares line through the full model's W over the window.
 */
function synchronousRotation(id, def, frame, rows) {
  const model = pckRotation(pck, CATALOGUE[id].naif);
  const atL = model.at(LOBBY_EPOCH_UT);
  const lambdaDot = def.meanMotionDegPerDay + (def.rates.lanDeg + def.rates.argPeDeg) / 36525;
  if (Math.abs(Math.abs(atL.rateDegPerDay) - lambdaDot) > 0.01 * lambdaDot) return null;
  const sign = Math.sign(atL.rateDegPerDay);
  const ctx = { parentPole: null };
  const days = rows.map((s) => (jdToUt(s.jd) - LOBBY_EPOCH_UT) / DAY_S);
  const truth = rows.map((s) => {
    const m = model.at(jdToUt(s.jd));
    return subParentLongitude(s.r, m.poleRaDeg, m.poleDecDeg, m.wDeg);
  });
  const ws = rows.map((s) => model.at(jdToUt(s.jd)).wDeg);
  const n = days.length;
  const mx = days.reduce((a, b) => a + b, 0) / n;
  const my = ws.reduce((a, b) => a + b, 0) / n;
  const slope = days.reduce((a, d, k) => a + (d - mx) * (ws[k] - my), 0) / days.reduce((a, d) => a + (d - mx) ** 2, 0);
  const candidates = [
    { method: 'A: rate = the fitted mean-longitude rate, W0 = the full pck W at the epoch', w0: atL.wDeg, rate: sign * lambdaDot },
    { method: 'B: least-squares line through the full pck W over the window', w0: my - slope * mx, rate: slope },
  ];
  for (const cnd of candidates) {
    let worst = 0;
    rows.forEach((s, k) => {
      const r = keplerState(def, jdToUt(s.jd), ctx).r;
      const lon = subParentLongitude(r, atL.poleRaDeg, atL.poleDecDeg, cnd.w0 + cnd.rate * days[k]);
      worst = Math.max(worst, Math.abs(wrap180(lon - truth[k])));
    });
    cnd.maxSubParentErrorDeg = worst;
  }
  candidates.sort((a, b) => a.maxSubParentErrorDeg - b.maxSubParentErrorDeg);
  const best = candidates[0];
  return { method: best.method, w0Deg: ((best.w0 % 360) + 360) % 360, rateDegPerDay: best.rate, maxSubParentErrorDeg: best.maxSubParentErrorDeg, otherCandidate: { method: candidates[1].method, maxSubParentErrorDeg: candidates[1].maxSubParentErrorDeg }, pckMeanRateDegPerDay: atL.rateDegPerDay };
}

const outPath = join(REPO_ROOT, 'tools/bodies/sources/orbit-fits.json');
let out;
try {
  out = JSON.parse(readFileSync(outPath, 'utf8'));
} catch {
  out = { bodies: {} };
}
out.description = 'Orbits fitted to JPL Horizons over the validity window (tools/bodies/fit-orbits.mjs): KeplerOrbitDef elements at the lobby epoch with mean motion and linear node and apsis rates, the starting values they were fitted from, and the residuals over the window';
out.lobbyEpochUt = LOBBY_EPOCH_UT;
out.window = { startJdTdb: WINDOW_START_JD, stopJdTdb: WINDOW_STOP_JD };

for (const id of BODY_ORDER) {
  const c = CATALOGUE[id];
  if (id === 'sun' || id === 'earth' || id === 'moon') continue;
  if (only.length && !only.includes(id)) continue;
  const center = horizonsCenter(id);
  let frame;
  let plane;
  let start;
  let startFrom;
  let periodDays;
  const mu = gmOf(c.parent) + gmOf(id);
  const horizons = [];
  if (c.approxPos || c.sbdb) {
    const def = c.approxPos ? approxPosOrbit(S.approxPos.table1[c.approxPos], AU_M) : sbdbOrbit(S.sbdb[c.sbdb], AU_M);
    frame = 'ecliptic';
    plane = ECLIPTIC_TO_ICRF;
    start = carry(def, LOBBY_EPOCH_UT);
    startFrom = c.approxPos ? `JPL Table 1 row "${c.approxPos}" carried to the epoch` : `SBDB osculating elements of JD ${S.sbdb[c.sbdb].epochJdTdb} carried to the epoch`;
    periodDays = 360 / def.meanMotionDegPerDay;
  } else {
    const row = S.satElem.rows[c.satName];
    frame = satFrame(row, c.parent);
    if (frame === 'positive-pole-of-parent') {
      const p = poleAtEpoch(c.parent);
      frame = { pole: { raDeg: (p.raDeg + 180) % 360, decDeg: -p.decDeg } };
    }
    const parentPole = poleAtEpoch(c.parent);
    // Triton's and Charon's tables are referred to the parent's equator: written as an explicit { pole } (the
    // parent's pck00011 pole at the epoch), so the orbit plane does not follow later edits of the parent's
    // rotation, and the frozen pole's limit is stated once (hand-off, limits).
    if (frame === 'parentEquator') frame = { pole: { raDeg: round(parentPole.raDeg, 12), decDeg: round(parentPole.decDeg, 12) } };
    plane = poleFrame(frame.pole.raDeg, frame.pole.decDeg);
    const chosen = satelliteOrbit({ row, frame, calibration: S.states.calibration[id].rows, ctx: { muSum: mu } }).best;
    periodDays = row.periodDays;
    const dense = await denseSamples(id, c.horizons, center, periodDays);
    horizons.push({ kind: 'dense span about the epoch', step: `${dense.step} min`, rows: dense.rows.length, ...src(dense.meta) });
    const osc = osculatingStart(dense.rows, plane, LOBBY_EPOCH_UT, mu);
    const fromHorizons = START_RATE_FROM_HORIZONS.includes(id);
    const n = fromHorizons ? osc.meanMotionDegPerDay : chosen.rates.n;
    start = { a: row.aKm * 1e3, e: Math.max(row.e, 1e-4), iDeg: osc.iDeg, lanDeg: osc.lanDeg, argPeDeg: osc.argPeDeg, meanAnomalyDeg: osc.meanAnomalyDeg, meanMotionDegPerDay: n, nodeRateDegPerDay: chosen.rates.O, apsisRateDegPerDay: chosen.rates.w + chosen.rates.O };
    startFrom = `JPL satellite mean elements (${row.ephemeris}; ${readingName(chosen.reading)}${chosen.apsisDropped ? ', apsis held' : ''}): a, e, ${fromHorizons ? 'precession rates, with the mean motion of the osculating orbit (Horizons)' : 'mean motion and precession rates'}; plane and phase of the osculating orbit at the epoch`;
    out.bodies[id] = { dense: dense.rows };
  }
  const win = await windowSamples(id, c.horizons, center, periodDays);
  horizons.push({ kind: 'window', step: `${win.step} min`, rows: win.rows.length, ...src(win.meta) });
  const samples = [...(out.bodies[id]?.dense ?? []), ...win.rows];
  const stages = c.kind === 'moon' ? [3 * periodDays, ...MOON_STAGES_D] : [12000];
  // A heliocentric orbit is a fraction of a revolution in the window (Neptune a fifth): its apsis and node
  // rates cannot be separated from the eccentricity and the perturbations; a fitted apsis rate takes up part of
  // the mean-longitude rate (Neptune's came out at 45 % of its mean motion), which reproduces the window but
  // turns the ellipse wrongly beyond it. Those rates stay the starting values' (Table 1's secular rates; zero
  // for the SBDB orbits). The refusal below (precession above 1 % of the mean motion) guards every body against
  // that degenerate split: the velocity is the exact derivative of the position, so it is not a velocity error,
  // but the orbit would not extrapolate and the osculating conic the runtime derives from the state would no
  // longer describe the mean orbit.
  const fixRates = c.kind !== 'moon';
  const fit = fitEllipse(samples, plane, LOBBY_EPOCH_UT, start, { stages, fixRates });
  const def = roundDef(toOrbitDef(fit.x, frame, LOBBY_EPOCH_UT));
  const res = residual(win.rows, fit);
  const precession = Math.abs(def.rates.lanDeg / 36525) + Math.abs((def.rates.lanDeg + def.rates.argPeDeg) / 36525);
  out.bodies[id] = { frame, startFrom, ratesFitted: !fixRates, start, def, residual: res, precessionFraction: precession / Math.abs(def.meanMotionDegPerDay), horizons };
  if (out.bodies[id].precessionFraction > MAX_PRECESSION_FRACTION) throw new Error(`${id}: fitted precession is ${(out.bodies[id].precessionFraction * 100).toFixed(2)} % of the mean motion, above the ${MAX_PRECESSION_FRACTION * 100} % a slowly precessing ellipse allows`);
  if (c.kind === 'moon') {
    const rot = synchronousRotation(id, def, frame, win.rows);
    if (rot) out.bodies[id].rotation = rot;
  }
  console.log(`${id.padEnd(10)} max ${res.maxAngleDeg.toFixed(4)} deg  radial ${(res.maxRadial * 100).toFixed(3)} %  rms ${res.rmsAngleDeg.toFixed(4)} deg  n ${def.meanMotionDegPerDay.toPrecision(10)}  (${res.samples} samples)`);
}
for (const v of Object.values(out.bodies)) delete v.dense;
writeFileSync(outPath, formatJson(out));
console.log('wrote tools/bodies/sources/orbit-fits.json');
