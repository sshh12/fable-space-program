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
import { DEG, ECLIPTIC_TO_ICRF, angleBetween, jdToUt, len, matVec, orbitState, rotZ, sub, transpose, wrap180 } from './lib/kepler.mjs';
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
      if (widened && !(typeof row.reason === 'string' && row.reason.trim().length > 40)) throw new Error(`tolerances.json: ${id} widens its class tolerance without a reason`);
      out.verdict = !overClass ? 'pass' : withinRow && widened ? 'reasoned exception' : 'FAIL';
      if (widened) out.reason = row.reason;
    }
    rows.push(out);
  }
  return rows;
}

function fmtRow(r) {
  const res = r.residual;
  const t = r.tolerance ? ` (tolerance ${r.tolerance.angleDeg} deg, ${(r.tolerance.radial * 100).toFixed(1)} %)` : '';
  const extra = r.id === 'earth' ? ` (of date: ${(res.maxLongitudeOfDateDeg * 3600).toFixed(1)}")` : '';
  return `${r.id.padEnd(10)} ${r.verdict.padEnd(19)} max ${res.maxAngleDeg.toFixed(4)} deg, radial ${(res.maxRadial * 100).toFixed(3)} %, rms ${res.rmsAngleDeg.toFixed(4)} deg${extra}${t}`;
}

async function main() {
  const rows = await validate();
  const failed = rows.filter((r) => r.verdict === 'FAIL');
  writeFileSync(join(REPO_ROOT, 'tools/bodies/validation-report.json'), formatJson({
    description: 'tools/bodies/validate.mjs: the staged orbits against JPL Horizons over the validity window (residual per body, judged with tools/bodies/tolerances.json)',
    window: { startJdTdb: WINDOW_START_JD, stopJdTdb: WINDOW_STOP_JD },
    summary: { passed: rows.filter((r) => r.verdict === 'pass').map((r) => r.id), reasonedExceptions: rows.filter((r) => r.verdict === 'reasoned exception').map((r) => r.id), failed: failed.map((r) => r.id), reported: rows.filter((r) => r.verdict === 'reported').map((r) => r.id) },
    bodies: rows,
  }));
  if (!process.argv.includes('--quiet')) for (const r of rows) console.log(fmtRow(r));
  const n = (v) => rows.filter((r) => r.verdict === v).length;
  console.log(`\n${n('pass')} pass, ${n('reasoned exception')} reasoned exceptions, ${failed.length} failed; reported (pinned): ${rows.filter((r) => r.verdict === 'reported').map((r) => r.id).join(', ')}`);
  if (failed.length) process.exit(1);
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
