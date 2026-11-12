#!/usr/bin/env node
// Validates the staged orbits (data/staged/bodies) against JPL Horizons over the validity window 2029-09-01 ..
// 2060-01-01 (about 2,000 states per body, the ones fit-orbits.mjs fitted, cached under
// data/cache/bodies/horizons/), ICRF axes, parent-centred, body centres, with the tolerance table
// tools/bodies/tolerances.json (the lead's decision on request bodies-ephemeris-4):
//
//   every body is judged on the largest angle between model and Horizons positions seen from its parent and the
//   largest relative difference of the distance, over the window, against its row (its class's tolerance, or a
//   reasoned bound); a body over its class tolerance without a row giving the physical reason fails.
//   Earth and the Moon are pinned by the design: reported, not judged.
//
// Writes tools/bodies/validation-report.json and prints the residual table; exits 1 on any failure.
//   node tools/bodies/validate.mjs [--quiet]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_ORDER, CATALOGUE, horizonsCenter } from './lib/catalogue.mjs';
import { formatJson } from './lib/format.mjs';
import { REPO_ROOT } from './lib/http.mjs';
import { DEG, ECLIPTIC_TO_ICRF, angleBetween, jdToUt, len, matMul, matVec, orbitState, poleFrame, rotZ, sub, transpose, wrap180 } from './lib/kepler.mjs';
import { vectorsAt } from './lib/horizons.mjs';
import { pckRotation } from './lib/pck.mjs';
import { WINDOW_START_JD, WINDOW_STOP_JD, windowSamples } from './lib/window.mjs';

const readJson = (p) => JSON.parse(readFileSync(join(REPO_ROOT, p), 'utf8'));

export function loadStaged() {
  const out = {};
  for (const id of BODY_ORDER) out[id] = readJson(`data/staged/bodies/${id}.json`);
  return out;
}

/** State of `id` relative to its parent, as the body system evaluates the staged definition. */
export function stagedState(defs, id, ut) {
  const b = defs[id];
  const p = defs[b.parent];
  const parentPole = p.rotation.mode === 'none' ? null : { raDeg: p.rotation.poleRaDeg, decDeg: p.rotation.poleDecDeg };
  return orbitState(b.orbit, ut, { muSum: p.mu + b.mu, parentPole });
}

const toEcliptic = transpose(ECLIPTIC_TO_ICRF);
const eclLon = (r) => {
  const e = matVec(toEcliptic, r);
  return Math.atan2(e[1], e[0]) / DEG;
};
/** General precession in longitude from J2000 (IAU 2006, Capitaine et al. 2003), degrees. */
const precessionDeg = (T) => (5028.796195 * T + 1.1054348 * T * T) / 3600;

/** The window step the fit used (so the very same cached states are judged); Earth and the Moon: a year, a month. */
const PINNED_PERIOD_D = { earth: 365.25, moon: 27.321661 };
function stepOf(fits, id) {
  if (PINNED_PERIOD_D[id]) return { periodDays: PINNED_PERIOD_D[id] };
  const w = fits.bodies[id]?.horizons.find((h) => h.kind === 'window');
  if (!w) throw new Error(`${id}: no window step in tools/bodies/sources/orbit-fits.json`);
  return { periodDays: 1, stepMinutes: Number(w.step.split(' ')[0]) };
}

/** An exception's bound may exceed its measured value by at most this factor. */
const MAX_BOUND_SLACK = 1.1;

/** Sub-parent longitude (deg) of a moon at r (from its parent), for a pole and W (deg). */
function subParentLongitude(r, poleRaDeg, poleDecDeg, wDeg) {
  const toBody = transpose(matMul(poleFrame(poleRaDeg, poleDecDeg), rotZ(wDeg * DEG)));
  const u = matVec(toBody, [-r[0], -r[1], -r[2]]);
  return Math.atan2(u[1], u[0]) / DEG;
}

/**
 * Largest difference over the window between the sub-parent longitude of the staged moon (staged orbit,
 * staged rotation) and the real one (Horizons position, the full pck00011 model with its libration terms).
 */
function subParentError(defs, id, rows) {
  const pck = readJson('tools/bodies/sources/naif-pck00011.json').vars;
  const model = pckRotation(pck, CATALOGUE[id].naif);
  const rot = defs[id].rotation;
  let worst = 0;
  for (const s of rows) {
    const ut = jdToUt(s.jd);
    const m = model.at(ut);
    const truth = subParentLongitude(s.r, m.poleRaDeg, m.poleDecDeg, m.wDeg);
    const staged = subParentLongitude(stagedState(defs, id, ut).r, rot.poleRaDeg, rot.poleDecDeg, rot.w0Deg + rot.rateDegPerDay * ((ut - rot.epochUt) / 86400));
    worst = Math.max(worst, Math.abs(wrap180(staged - truth)));
  }
  return worst;
}

/** Instants outside the window (TDB) at which the degradation of the fitted orbits is reported (not judged). */
export const OUTSIDE_JDS = { 2025: 2460676.5, 2027: 2461406.5, 2028: 2461771.5, 2061: 2473824.5, 2063: 2474554.5, 2065: 2475285.5, 2070: 2477111.5 };

async function outsideWindow(defs) {
  const out = {};
  const years = Object.keys(OUTSIDE_JDS);
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (c.parent === null || id === 'earth' || id === 'moon') continue;
    const h = await vectorsAt(c.horizons, horizonsCenter(id), years.map((y) => OUTSIDE_JDS[y]), `outside-${id}`);
    out[id] = Object.fromEntries(h.rows.map((s, k) => [years[k], Number((angleBetween(stagedState(defs, id, jdToUt(s.jd)).r, s.r) / DEG).toFixed(4))]));
  }
  return out;
}

export async function validate() {
  const defs = loadStaged();
  const tol = readJson('tools/bodies/tolerances.json');
  const fits = readJson('tools/bodies/sources/orbit-fits.json');
  const rows = [];
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (c.parent === null) continue;
    const row = tol.bodies.find((r) => r.id === id);
    if (!row) throw new Error(`tools/bodies/tolerances.json has no row for ${id}`);
    const st = stepOf(fits, id);
    const win = await windowSamples(id, c.horizons, horizonsCenter(id), st.periodDays, { stepMinutes: st.stepMinutes });
    let maxAngle = 0;
    let maxRadial = 0;
    let sumSq = 0;
    let maxDv = 0;
    let maxOfDate = 0;
    let worstJd = null;
    for (const s of win.rows) {
      const ut = jdToUt(s.jd);
      const m = stagedState(defs, id, ut);
      const ang = angleBetween(m.r, s.r) / DEG;
      if (ang > maxAngle) {
        maxAngle = ang;
        worstJd = s.jd;
      }
      maxRadial = Math.max(maxRadial, Math.abs(len(m.r) - len(s.r)) / len(s.r));
      maxDv = Math.max(maxDv, len(sub(m.v, s.v)) / len(s.v));
      sumSq += ang * ang;
      if (id === 'earth') {
        const T = (s.jd - 2451545) / 36525;
        const ofDate = matVec(ECLIPTIC_TO_ICRF, matVec(rotZ(precessionDeg(T) * DEG), matVec(toEcliptic, s.r)));
        maxOfDate = Math.max(maxOfDate, Math.abs(wrap180(eclLon(m.r) - eclLon(ofDate))));
      }
    }
    const cls = tol.classes[row.class] ?? null;
    const bound = row.class === 'pinned' ? null : { angleDeg: row.angleDeg ?? cls.angleDeg, radial: row.radial ?? cls.radial };
    const out = {
      id,
      class: row.class,
      samples: win.rows.length,
      residual: { maxAngleDeg: maxAngle, maxRadial, rmsAngleDeg: Math.sqrt(sumSq / win.rows.length), worstAtJdTdb: worstJd, maxVelocityError: maxDv },
      tolerance: bound,
      horizons: { url: win.meta.url, retrievedAt: win.meta.retrievedAt, stepMinutes: win.step },
    };
    if (id === 'earth') out.residual.maxLongitudeOfDateDeg = maxOfDate;
    if (row.class === 'pinned') {
      out.verdict = 'reported';
      out.reason = row.reason;
    } else {
      const overClass = maxAngle > cls.angleDeg || maxRadial > cls.radial;
      const withinRow = maxAngle <= bound.angleDeg && maxRadial <= bound.radial;
      const widened = bound.angleDeg > cls.angleDeg || bound.radial > cls.radial;
      out.verdict = !overClass ? 'pass' : withinRow && widened ? 'reasoned exception' : 'FAIL';
      if (widened) {
        // An exception is the lead's: approved in a request, with its physical reason, and no looser than about
        // 10 % above what it covers.
        const problems = [];
        if (row.approvedBy !== 'lead' || typeof row.request !== 'string' || !/^bodies-ephemeris-[0-9]+$/.test(row.request)) problems.push('no approval (approvedBy "lead" and the request id)');
        if (!(typeof row.reason === 'string' && row.reason.trim().length > 40)) problems.push('no physical reason');
        if (bound.angleDeg > cls.angleDeg && bound.angleDeg > MAX_BOUND_SLACK * maxAngle) problems.push(`bound ${bound.angleDeg} deg is more than ${Math.round((MAX_BOUND_SLACK - 1) * 100)} % above the measured ${maxAngle.toFixed(3)} deg`);
        if (bound.radial > cls.radial && bound.radial > MAX_BOUND_SLACK * maxRadial) problems.push(`radial bound ${bound.radial} is more than ${Math.round((MAX_BOUND_SLACK - 1) * 100)} % above the measured ${maxRadial.toFixed(5)}`);
        if (problems.length) {
          out.verdict = 'FAIL';
          out.problems = problems;
        }
        out.reason = row.reason;
        out.approval = { approvedBy: row.approvedBy ?? null, request: row.request ?? null };
      }
      const sync = fits.bodies[id]?.rotation;
      if (sync) {
        const lim = tol.subParentLongitudeDeg;
        const err = subParentError(defs, id, win.rows);
        out.subParentLongitude = { maxErrorDeg: err, boundDeg: lim, method: sync.method };
        if (err > lim) {
          out.verdict = 'FAIL';
          (out.problems ??= []).push(`sub-parent longitude off by ${err.toFixed(2)} deg (bound ${lim})`);
        }
      }
    }
    rows.push(out);
  }
  return rows;
}

function fmtRow(r) {
  const res = r.residual;
  const t = r.tolerance ? ` (tolerance ${r.tolerance.angleDeg} deg, ${(r.tolerance.radial * 100).toFixed(1)} %)` : '';
  const extra = (r.id === 'earth' ? ` (of date: ${(res.maxLongitudeOfDateDeg * 3600).toFixed(1)}")` : '') + (r.subParentLongitude ? `, sub-parent ${r.subParentLongitude.maxErrorDeg.toFixed(2)} deg` : '') + (r.problems ? ` [${r.problems.join('; ')}]` : '');
  return `${r.id.padEnd(10)} ${r.verdict.padEnd(19)} max ${res.maxAngleDeg.toFixed(4)} deg, radial ${(res.maxRadial * 100).toFixed(3)} %, rms ${res.rmsAngleDeg.toFixed(4)} deg${extra}${t}`;
}

async function main() {
  const rows = await validate();
  const failed = rows.filter((r) => r.verdict === 'FAIL');
  const outside = await outsideWindow(loadStaged());
  const tol = readJson('tools/bodies/tolerances.json');
  const approved = tol.bodies.filter((r) => r.approvedBy === 'lead').map((r) => r.id).sort();
  writeFileSync(join(REPO_ROOT, 'tools/bodies/validation-report.json'), formatJson({
    description: 'tools/bodies/validate.mjs: the staged orbits against JPL Horizons over the validity window (residual per body, judged with tools/bodies/tolerances.json)',
    window: { startJdTdb: WINDOW_START_JD, stopJdTdb: WINDOW_STOP_JD },
    summary: { passed: rows.filter((r) => r.verdict === 'pass').map((r) => r.id), reasonedExceptions: rows.filter((r) => r.verdict === 'reasoned exception').map((r) => r.id), failed: failed.map((r) => r.id), reported: rows.filter((r) => r.verdict === 'reported').map((r) => r.id) },
    approvedExceptions: approved,
    bodies: rows,
    outsideWindowMaxAngleDeg: { note: 'angle (deg) between the staged orbit and Horizons seen from the parent at instants outside the validity window: reported, not judged', byBody: outside },
  }));
  if (!process.argv.includes('--quiet')) for (const r of rows) console.log(fmtRow(r));
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${n('pass')} pass, ${n('reasoned exception')} reasoned exceptions, ${failed.length} failed; reported (pinned): ${rows.filter((r) => r.verdict === 'reported').map((r) => r.id).join(', ')}`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
