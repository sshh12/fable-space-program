// JPL Horizons state vectors (https://ssd.jpl.nasa.gov/api/horizons.api), cached under
// data/cache/bodies/horizons/. Always ICRF axes (REF_PLANE = FRAME, i.e. the ICRF / J2000 equator, not the
// ecliptic Horizons uses by default), geometric (no light-time or aberration correction), TDB, km and km/s.
// The request carries a generic client name only.
import { fetchCached, sha256 } from './http.mjs';

export const HORIZONS_URL = 'https://ssd.jpl.nasa.gov/api/horizons.api';

const q = (v) => `'${v}'`;

function buildUrl(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) usp.set(k, v);
  return `${HORIZONS_URL}?${usp.toString()}`;
}

function baseParams(command, center) {
  return {
    format: 'text',
    COMMAND: q(command),
    OBJ_DATA: q('NO'),
    MAKE_EPHEM: q('YES'),
    EPHEM_TYPE: q('VECTORS'),
    CENTER: q(center),
    REF_PLANE: q('FRAME'),
    REF_SYSTEM: q('ICRF'),
    VEC_TABLE: q('2'),
    VEC_CORR: q('NONE'),
    VEC_LABELS: q('NO'),
    OUT_UNITS: q('KM-S'),
    CSV_FORMAT: q('YES'),
    TIME_TYPE: q('TDB'),
    TIME_DIGITS: q('FRACSEC'),
  };
}

/** Parse the $$SOE..$$EOE block of a VECTORS / CSV reply into [{ jd, r: [x,y,z] m, v: [vx,vy,vz] m/s }]. */
export function parseVectors(text) {
  const start = text.indexOf('$$SOE');
  const end = text.indexOf('$$EOE');
  if (start < 0 || end < 0) {
    const err = text.split('\n').slice(0, 40).join('\n');
    throw new Error(`Horizons reply has no $$SOE/$$EOE block:\n${err}`);
  }
  const rows = [];
  for (const line of text.slice(start + 5, end).split('\n')) {
    const t = line.trim();
    if (!t) continue;
    const f = t.split(',').map((s) => s.trim());
    const nums = [f[0], f[2], f[3], f[4], f[5], f[6], f[7]].map(Number);
    if (nums.some((n) => !Number.isFinite(n))) throw new Error(`bad Horizons row: ${t}`);
    rows.push({ jd: nums[0], r: [nums[1] * 1e3, nums[2] * 1e3, nums[3] * 1e3], v: [nums[4] * 1e3, nums[5] * 1e3, nums[6] * 1e3] });
  }
  return rows;
}

async function query(params, label) {
  const url = buildUrl(params);
  const name = `${label}-${sha256(url).slice(0, 12)}.txt`;
  const res = await fetchCached('horizons', name, url);
  try {
    return { rows: parseVectors(res.text), meta: res.meta };
  } catch (err) {
    throw new Error(`${label}: ${err.message}`);
  }
}

/** States of `command` relative to `center` at the listed Julian dates (TDB). */
export async function vectorsAt(command, center, jds, label) {
  const params = { ...baseParams(command, center), TLIST: jds.map((j) => j.toFixed(6)).join(' ') };
  const out = await query(params, label);
  if (out.rows.length !== jds.length) throw new Error(`${label}: asked for ${jds.length} epochs, got ${out.rows.length}`);
  return out;
}

/** States of `command` relative to `center` from `startJd` to `stopJd` (TDB) at `step` (Horizons step syntax, e.g. '1 d'). */
export async function vectorsRange(command, center, startJd, stopJd, step, label) {
  const params = { ...baseParams(command, center), START_TIME: q(`JD ${startJd}`), STOP_TIME: q(`JD ${stopJd}`), STEP_SIZE: q(step) };
  return query(params, label);
}
