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
import { AU_M, DAY_S, DEG, ECLIPTIC_TO_ICRF, angleBetween, jdToUt, len, matVec, poleFrame } from './lib/kepler.mjs';
import { LOBBY_EPOCH_UT, MAX_PRECESSION_FRACTION, approxPosOrbit, readingName, roundDef, satFrame, satelliteOrbit, sbdbOrbit } from './lib/orbits.mjs';
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
    plane = frame === 'parentEquator' ? poleFrame(parentPole.raDeg, parentPole.decDeg) : poleFrame(frame.pole.raDeg, frame.pole.decDeg);
    const chosen = satelliteOrbit({ row, frame, path: 'sat-table', calibration: S.states.calibration[id].rows, ctx: { parentPole, muSum: mu }, muSum: mu }).best;
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
  // rates cannot be separated from the eccentricity and the perturbations, and a fitted apsis rate would take
  // up part of the mean longitude rate (the velocity, which follows the mean motion, would then be wrong).
  // Those rates stay the starting values' (Table 1's secular rates; zero for the SBDB orbits).
  const fixRates = c.kind !== 'moon';
  const fit = fitEllipse(samples, plane, LOBBY_EPOCH_UT, start, { stages, fixRates });
  const def = roundDef(toOrbitDef(fit.x, frame, LOBBY_EPOCH_UT));
  const res = residual(win.rows, fit);
  const precession = Math.abs(def.rates.lanDeg / 36525) + Math.abs((def.rates.lanDeg + def.rates.argPeDeg) / 36525);
  out.bodies[id] = { frame, startFrom, ratesFitted: !fixRates, start, def, residual: res, precessionFraction: precession / Math.abs(def.meanMotionDegPerDay), horizons };
  if (out.bodies[id].precessionFraction > MAX_PRECESSION_FRACTION) throw new Error(`${id}: fitted precession is ${(out.bodies[id].precessionFraction * 100).toFixed(2)} % of the mean motion, above the ${MAX_PRECESSION_FRACTION * 100} % a slowly precessing ellipse allows`);
  console.log(`${id.padEnd(10)} max ${res.maxAngleDeg.toFixed(4)} deg  radial ${(res.maxRadial * 100).toFixed(3)} %  rms ${res.rmsAngleDeg.toFixed(4)} deg  n ${def.meanMotionDegPerDay.toPrecision(10)}  (${res.samples} samples)`);
}
for (const v of Object.values(out.bodies)) delete v.dense;
writeFileSync(outPath, formatJson(out));
console.log('wrote tools/bodies/sources/orbit-fits.json');
