#!/usr/bin/env node
// Validates the staged body definitions (data/staged/bodies) against JPL Horizons at ten epochs over 2030-2060
// (2030-01-01 to 2060-01-01 TDB, evenly spaced), ICRF axes, parent-centred, body centres.
//
//   planets (JPL Table 1)        heliocentric ecliptic longitude, latitude and distance against the table's
//                                stated accuracy for 1800-2050 (approx_pos "Accuracy", the 1800-2050 column)
//   satellites, Ceres, Pluto     angle between the positions seen from the parent <= 1 degree and radial
//                                distance within 2 % (the brief's satellite tolerance; it states none for the
//                                osculating dwarf-planet elements, which therefore get the same)
//   Earth, Moon                  pinned to v1 by the design (ARCHITECTURE 8.2): reported, not gated
//
// Writes tools/bodies/validation-report.json and prints a table; exits 1 when a gated body fails.
//   node tools/bodies/validate.mjs [--quiet]
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_ORDER, CATALOGUE, horizonsCenter } from './lib/catalogue.mjs';
import { formatJson } from './lib/format.mjs';
import { vectorsAt } from './lib/horizons.mjs';
import { REPO_ROOT } from './lib/http.mjs';
import { DEG, ECLIPTIC_TO_ICRF, angleBetween, jdToUt, len, matVec, orbitState, rotZ, transpose, wrap180 } from './lib/kepler.mjs';

export const VALIDATION_JDS = Array.from({ length: 10 }, (_, k) => 2462502.5 + (k * (2473459.5 - 2462502.5)) / 9);
const TOL_ANGLE_DEG = 1;
const TOL_RADIAL = 0.02;

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
const lonLatDist = (r) => {
  const e = matVec(toEcliptic, r);
  return { lon: Math.atan2(e[1], e[0]) / DEG, lat: Math.asin(e[2] / len(e)) / DEG, dist: len(e) };
};
/** General precession in longitude from J2000 (IAU 2006, Capitaine et al. 2003), degrees. */
const precessionDeg = (T) => (5028.796195 * T + 1.1054348 * T * T) / 3600;

export async function validate() {
  const defs = loadStaged();
  const approx = readJson('tools/bodies/sources/jpl-approx-pos.json');
  const prov = readJson('tools/bodies/provenance.json');
  const rows = [];
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (c.parent === null) continue;
    const h = await vectorsAt(c.horizons, horizonsCenter(id), VALIDATION_JDS, `val-${id}`);
    const epochs = [];
    for (const s of h.rows) {
      const ut = jdToUt(s.jd);
      const m = stagedState(defs, id, ut).r;
      const ang = angleBetween(m, s.r) / DEG;
      const radial = (len(m) - len(s.r)) / len(s.r);
      const A = lonLatDist(m);
      const B = lonLatDist(s.r);
      const e = { jd: s.jd, angleDeg: ang, radial, dLonArcsec: wrap180(A.lon - B.lon) * 3600, dLatArcsec: (A.lat - B.lat) * 3600, dDistKm: (A.dist - B.dist) / 1e3 };
      if (id === 'earth') {
        // The v1 Almanac formula is referred to the mean equinox of date: compare in that frame too.
        const T = (s.jd - 2451545) / 36525;
        const ofDate = matVec(rotZ(precessionDeg(T) * DEG), matVec(toEcliptic, s.r));
        const Bd = { lon: Math.atan2(ofDate[1], ofDate[0]) / DEG };
        e.dLonOfDateArcsec = wrap180(A.lon - Bd.lon) * 3600;
      }
      epochs.push(e);
    }
    const worst = (f) => epochs.reduce((w, e) => (Math.abs(e[f]) > Math.abs(w) ? e[f] : w), 0);
    const path = prov.paths[id]?.path ?? null;
    const row = { id, path, reading: prov.paths[id]?.reading ?? null, horizons: { command: c.horizons, center: horizonsCenter(id), url: h.meta.url, retrievedAt: h.meta.retrievedAt } };
    row.worst = { angleDeg: worst('angleDeg'), radial: worst('radial'), dLonArcsec: worst('dLonArcsec'), dLatArcsec: worst('dLatArcsec'), dDistKm: worst('dDistKm') };
    if (id === 'earth') row.worst.dLonOfDateArcsec = worst('dLonOfDateArcsec');
    if (path === 'approx-pos') {
      const acc = approx.accuracy[c.approxPos].table1;
      row.tolerance = { dLonArcsec: acc.longitudeArcsec, dLatArcsec: acc.latitudeArcsec, dDistKm: acc.distanceKkm * 1000 };
      row.gated = true;
      row.pass = Math.abs(row.worst.dLonArcsec) <= acc.longitudeArcsec && Math.abs(row.worst.dLatArcsec) <= acc.latitudeArcsec && Math.abs(row.worst.dDistKm) <= acc.distanceKkm * 1000;
      row.factor = Math.max(Math.abs(row.worst.dLonArcsec) / acc.longitudeArcsec, Math.abs(row.worst.dLatArcsec) / acc.latitudeArcsec, Math.abs(row.worst.dDistKm) / (acc.distanceKkm * 1000));
      // Within the table's stated validity (1800-2050) only:
      const inRange = epochs.filter((e) => e.jd <= 2469807.5);
      const wIn = (f) => inRange.reduce((w, e) => Math.max(w, Math.abs(e[f])), 0);
      row.factorTo2050 = Math.max(wIn('dLonArcsec') / acc.longitudeArcsec, wIn('dLatArcsec') / acc.latitudeArcsec, wIn('dDistKm') / (acc.distanceKkm * 1000));
    } else if (id === 'earth' || id === 'moon') {
      row.gated = false;
      row.pass = null;
      row.note = id === 'earth' ? 'pinned to the v1 Almanac Sun (inverted) by ARCHITECTURE 8.2; the formula is referred to the mean equinox of date, so in ICRF it differs by the precession since J2000 (dLonOfDateArcsec removes it)' : 'pinned to the frozen v1 ellipse by ARCHITECTURE 8.2 (no node regression, no apsidal precession)';
    } else {
      row.tolerance = { angleDeg: TOL_ANGLE_DEG, radial: TOL_RADIAL };
      row.gated = true;
      row.pass = Math.abs(row.worst.angleDeg) <= TOL_ANGLE_DEG && Math.abs(row.worst.radial) <= TOL_RADIAL;
      row.factor = Math.max(Math.abs(row.worst.angleDeg) / TOL_ANGLE_DEG, Math.abs(row.worst.radial) / TOL_RADIAL);
    }
    row.epochs = epochs;
    rows.push(row);
  }
  return rows;
}

function fmtRow(r) {
  const w = r.worst;
  const pos = r.path === 'approx-pos' || r.id === 'earth' ? `dLon ${w.dLonArcsec.toFixed(1)}" dLat ${w.dLatArcsec.toFixed(1)}" dDist ${w.dDistKm.toFixed(0)} km` : `angle ${w.angleDeg.toFixed(3)} deg radial ${(w.radial * 100).toFixed(2)} %`;
  const extra = r.id === 'earth' ? ` (of date: dLon ${w.dLonOfDateArcsec.toFixed(1)}")` : '';
  const verdict = r.pass === null ? 'reported' : r.pass ? 'PASS' : `FAIL x${r.factor.toFixed(2)}`;
  return `${r.id.padEnd(10)} ${(r.path ?? '').padEnd(10)} ${verdict.padEnd(11)} ${pos}${extra}`;
}

async function main() {
  const rows = await validate();
  const failed = rows.filter((r) => r.gated && !r.pass);
  writeFileSync(join(REPO_ROOT, 'tools/bodies/validation-report.json'), formatJson({
    description: 'tools/bodies/validate.mjs: staged definitions against JPL Horizons at ten epochs over 2030-2060 (worst deviation per body; signed: model minus Horizons)',
    epochsJdTdb: VALIDATION_JDS,
    summary: { gated: rows.filter((r) => r.gated).length, passed: rows.filter((r) => r.pass === true).length, failed: failed.map((r) => r.id), reported: rows.filter((r) => !r.gated).map((r) => r.id) },
    bodies: rows,
  }));
  if (!process.argv.includes('--quiet')) for (const r of rows) console.log(fmtRow(r));
  console.log(`\n${rows.filter((r) => r.pass === true).length} of ${rows.filter((r) => r.gated).length} gated bodies within tolerance; reported only: ${rows.filter((r) => !r.gated).map((r) => r.id).join(', ')}`);
  if (failed.length) {
    console.log(`outside tolerance: ${failed.map((r) => r.id).join(', ')} (tools/bodies/validation-report.json)`);
    process.exit(1);
  }
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/\\/g, '/').split('/').pop())) await main();
