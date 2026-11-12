#!/usr/bin/env node
// Fetches a small HELD-OUT truth sample from JPL Horizons for the unit tests: every body but the Sun at 40
// instants inside the validity window that are not on the fit's sampling grid (a golden-ratio sequence plus an
// odd offset), at the game's clock: JD(TDB) = 2451545 + (ut + 69.184) / 86400. Writes
// tests/unit/bodies/horizons-heldout.json (committed; about 100 KB), which tests/unit/bodies/heldout.test.ts
// evaluates the STAGED files against with tools/bodies/tolerances.json.
//
//   node tools/bodies/fetch-heldout.mjs
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BODY_ORDER, CATALOGUE, horizonsCenter } from './lib/catalogue.mjs';
import { vectorsAt } from './lib/horizons.mjs';
import { REPO_ROOT } from './lib/http.mjs';
import { TT_MINUS_UTC_S, jdToUt, utToJd } from './lib/kepler.mjs';
import { WINDOW_START_JD, WINDOW_STOP_JD } from './lib/window.mjs';

const N = 40;
const GOLDEN = (Math.sqrt(5) - 1) / 2;
const u0 = jdToUt(WINDOW_START_JD);
const span = (WINDOW_STOP_JD - WINDOW_START_JD) * 86400 - 4000;
const uts = Array.from({ length: N }, (_, k) => Math.round(u0 + 1234.567 + span * ((0.5 + k * GOLDEN) % 1))).sort((a, b) => a - b);
const jds = uts.map((u) => Number(utToJd(u).toFixed(6)));

const bodies = {};
for (const id of BODY_ORDER) {
  const c = CATALOGUE[id];
  if (c.parent === null) continue;
  const h = await vectorsAt(c.horizons, horizonsCenter(id), jds, `heldout-${id}`);
  bodies[id] = {
    command: c.horizons,
    center: horizonsCenter(id),
    url: h.meta.url,
    retrievedAt: h.meta.retrievedAt,
    rows: h.rows.map((s) => [Number(jdToUt(s.jd).toFixed(3)), ...s.r.map((x) => Math.round(x)), ...s.v.map((x) => Number(x.toFixed(4)))]),
  };
  console.log(`${id}: ${h.rows.length}`);
}
writeFileSync(
  join(REPO_ROOT, 'tests/unit/bodies/horizons-heldout.json'),
  `${JSON.stringify({
    description: `JPL Horizons states (ICRF, geometric, parent body centre) at ${N} held-out instants of the validity window per body, not on the fit's grid. Rows: [ut (s since J2000 treated as UTC; JD TDB = 2451545 + (ut + ${TT_MINUS_UTC_S}) / 86400), x, y, z (m), vx, vy, vz (m/s)]. Written by tools/bodies/fetch-heldout.mjs.`,
    ttMinusUtcS: TT_MINUS_UTC_S,
    bodies,
  })}\n`,
);
console.log('wrote tests/unit/bodies/horizons-heldout.json');
