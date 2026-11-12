// Readers that turn the cached source documents into the tables the generator uses. Each returns plain data
// (numbers exactly as printed in the source, parsed to JSON numbers); `fetch-sources.mjs` writes them, with the
// download's URL, time of retrieval and sha256, to tools/bodies/sources/<id>.json. Every reader fails loudly
// when a row it needs is missing, so a changed page cannot slip a wrong number in.
import { num, tableRows, textLines } from './html.mjs';

const need = (cond, msg) => {
  if (!cond) throw new Error(msg);
};
const n = (s, what) => {
  const v = num(s);
  need(Number.isFinite(v), `${what}: "${s}" is not a number`);
  return v;
};
/** "2440.53 [ D ] ±0.04" -> 2440.53 */
const lead = (s, what) => n(String(s).split(/\s+\[|\s+±|\s+\+-/)[0].trim(), what);

// ------------------------------------------------------------------------------- JPL approximate positions

export const APPROX_POS_NAMES = ['Mercury', 'Venus', 'EM Bary', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune'];

export function extractApproxPos(html) {
  const lines = textLines(html);
  const t1 = lines.findIndex((l) => /^Table 1$/.test(l));
  const t2 = lines.findIndex((l) => /^Table 2a$/.test(l));
  need(t1 >= 0 && t2 > t1, 'approx_pos: Table 1 / Table 2a not found');
  const table1 = {};
  const block = lines.slice(t1, t2).join('\n').split('\n');
  for (let i = 0; i < block.length; i++) {
    const name = APPROX_POS_NAMES.find((p) => block[i].startsWith(`${p} `));
    if (!name) continue;
    const v = block[i].slice(name.length).trim().split(/\s+/);
    if (!v.every((x) => Number.isFinite(num(x)))) continue; // the footnote "EM Bary = Earth/Moon Barycenter"
    const r = block[i + 1].trim().split(/\s+/);
    need(v.length === 6 && r.length === 6, `approx_pos: Table 1 row ${name} has ${v.length} / ${r.length} fields`);
    const [a, e, I, L, longPeri, longNode] = v.map((x) => n(x, `Table 1 ${name}`));
    const [ra, re, rI, rL, rPeri, rNode] = r.map((x) => n(x, `Table 1 ${name} rates`));
    table1[name] = { a, e, I, L, longPeri, longNode, ratesPerCentury: { a: ra, e: re, I: rI, L: rL, longPeri: rPeri, longNode: rNode } };
  }
  need(APPROX_POS_NAMES.every((p) => table1[p]), 'approx_pos: Table 1 incomplete');

  // Accuracy table: name, then 3 numbers for 1800-2050 AD, then 3 for 3000 BC - 3000 AD.
  const acc = {};
  const aStart = lines.findIndex((l) => l === 'Accuracy');
  const aEnd = lines.findIndex((l, i) => i > aStart && /^Formulae/.test(l));
  need(aStart >= 0 && aEnd > aStart, 'approx_pos: accuracy table not found');
  const units = lines.slice(aStart, aEnd).join(' ');
  need(/arcsec/.test(units) && /1000 km/.test(units), 'approx_pos: accuracy table units changed');
  const toks = lines.slice(aStart, aEnd).join(' ').replace(/†/g, ' ').split(/\s+/);
  for (const name of APPROX_POS_NAMES) {
    const words = name.split(' ');
    let k = -1;
    for (let i = 0; i < toks.length; i++) if (words.every((w, j) => toks[i + j] === w)) { k = i + words.length; break; }
    need(k > 0, `approx_pos: accuracy row ${name} not found`);
    const vals = [];
    while (vals.length < 6 && k < toks.length) {
      const v = num(toks[k++]);
      if (Number.isFinite(v)) vals.push(v);
    }
    need(vals.length === 6, `approx_pos: accuracy row ${name}`);
    acc[name] = {
      table1: { longitudeArcsec: vals[0], latitudeArcsec: vals[1], distanceKkm: vals[2] },
      table2: { longitudeArcsec: vals[3], latitudeArcsec: vals[4], distanceKkm: vals[5] },
    };
  }
  return {
    description: 'JPL Keplerian elements for approximate positions of the major planets, Table 1 (mean ecliptic and equinox of J2000, valid 1800-2050 AD), and the nominal errors of the approximation',
    units: { a: 'au', e: '1', angles: 'deg', ratesPerCentury: 'per Julian century of TDB', accuracy: 'heliocentric longitude and latitude in arcsec, distance in 1000 km' },
    table1,
    accuracy: acc,
  };
}

// ---------------------------------------------------------------------------- JPL satellite mean elements

export function extractSatElem(html, names) {
  const rows = tableRows(html).filter((r) => r.length >= 19 && /^\d+$/.test(r[0]));
  const out = {};
  for (const name of names) {
    const r = rows.find((x) => x[2] === name);
    need(r, `sat elem: no row for ${name}`);
    const [, planet, sat, code, ephemeris, frame, epoch, a, e, w, M, i, node, P, Papsis, Pnode, ra, dec, tilt] = r;
    out[name] = {
      planet,
      satellite: sat,
      code: n(code, `${name} code`),
      ephemeris,
      frame,
      epoch,
      aKm: n(a, `${name} a`),
      e: n(e, `${name} e`),
      argPeDeg: n(w, `${name} w`),
      meanAnomalyDeg: n(M, `${name} M`),
      iDeg: n(i, `${name} i`),
      nodeDeg: n(node, `${name} node`),
      periodDays: n(P, `${name} P`),
      // "-" in the table: no precession period listed (a circular orbit has no apsis to precess)
      apsisPeriodYears: Papsis === '-' ? null : n(Papsis, `${name} P apsis`),
      nodePeriodYears: Pnode === '-' ? null : n(Pnode, `${name} P node`),
      laplacePole: frame === 'Laplace' ? { raDeg: n(ra, `${name} RA`), decDeg: n(dec, `${name} Dec`), tiltDeg: n(tilt, `${name} tilt`) } : null,
    };
  }
  return {
    description: 'JPL planetary satellite mean elements (precessing ellipses fitted to the satellite ephemerides); node measured from the node of the reference plane on the ICRF equator; P = period; P apsis / P node = precession periods of the argument of periapsis and of the node',
    units: { aKm: 'km', angles: 'deg', periodDays: 'd', apsisPeriodYears: 'Julian years', nodePeriodYears: 'Julian years' },
    rows: out,
  };
}

// ---------------------------------------------------------------------- JPL satellite physical parameters

export function extractSatPhys(html) {
  const rows = tableRows(html);
  const sats = [];
  // Each of the GM / radius cells holds "value sigma ref" (or "n/a ref" when the value is not determined).
  const cell = (s) => {
    const t = s.split(/\s+/);
    const v = num(t[0]);
    return Number.isFinite(v) ? { value: v, sigma: Number.isFinite(num(t[1])) ? num(t[1]) : null, ref: t.slice(2).join(' ') || null } : { value: null, sigma: null, ref: t.slice(1).join(' ') || null };
  };
  for (const r of rows) {
    if (r.length !== 6 || !/^\d+$/.test(r[2])) continue;
    const gm = cell(r[3]);
    const radius = cell(r[4]);
    sats.push({ planet: r[0], name: r[1], code: Number(r[2]), gm: gm.value, gmSigma: gm.sigma, gmRef: gm.ref, meanRadiusKm: radius.value, meanRadiusSigmaKm: radius.sigma });
  }
  need(sats.length > 40, `sat phys: only ${sats.length} satellite rows`);
  const planetGm = {};
  for (const r of rows) {
    if (r.length !== 3) continue;
    const m = /^([\d.]+)\s*±\s*([\d.]+)$/.exec(r[1]);
    if (m && ['Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune', 'Pluto'].includes(r[0])) {
      planetGm[r[0]] = { gm: Number(m[1]), sigma: Number(m[2]), ref: r[2] };
    }
  }
  need(Object.keys(planetGm).length === 7, 'sat phys: planet GM table incomplete');
  return {
    description: 'JPL planetary satellite physical parameters (GM from the satellite ephemerides, mean radius) and the planet-only GM values of the same ephemerides',
    units: { gm: 'km^3/s^2', meanRadiusKm: 'km' },
    satellites: sats,
    planetGm,
  };
}

// ------------------------------------------------------------------------ JPL planet physical parameters

export function extractPlanetPhys(html) {
  const rows = tableRows(html);
  const cols = ['equatorialRadiusKm', 'meanRadiusKm', 'mass', 'bulkDensity', 'siderealRotationDays', 'siderealOrbitYears', 'v10', 'geometricAlbedo', 'equatorialGravity', 'escapeVelocity'];
  const read = (names) => {
    const out = {};
    for (const name of names) {
      const r = rows.find((x) => x[0] === name && x.length === 11);
      need(r, `planet phys: no row ${name}`);
      out[name] = Object.fromEntries(cols.map((c, i) => [c, lead(r[i + 1], `${name} ${c}`)]));
    }
    return out;
  };
  return {
    description: 'JPL planetary physical parameters (planets and dwarf planets)',
    units: { radii: 'km', massPlanets: '1e24 kg', massDwarfPlanets: '1e18 kg', bulkDensity: 'g/cm^3', siderealRotationDays: 'd (negative = retrograde)', siderealOrbitYears: 'yr', equatorialGravity: 'm/s^2', escapeVelocity: 'km/s' },
    planets: read(['Mercury', 'Venus', 'Earth', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']),
    dwarfPlanets: read(['Ceres', 'Pluto']),
  };
}

// --------------------------------------------------------------------------- JPL astrodynamic parameters

export function extractAstroPar(html) {
  const rows = tableRows(html);
  const find = (re) => rows.find((r) => re.test(r[0]));
  const au = find(/^astronomical unit$/);
  const obl = find(/^obliquity of ecliptic \(J2000\) \[IAU 1976\]$/);
  const gms = find(/^heliocentric gravitational constant$/);
  need(au && obl && gms, 'astro par: au / obliquity / GM sun row missing');
  const gmSunMatch = /^([\d.]+) x 10 (\d+) m 3 s -2$/.exec(gms[2]);
  need(gmSunMatch, `astro par: GM sun "${gms[2]}"`);
  const systemGm = {};
  for (const r of rows) {
    if (r.length !== 2) continue;
    const v = num(r[1]);
    if (Number.isFinite(v)) systemGm[r[0]] = v;
  }
  for (const k of ['Mercury', 'Venus', 'Earth', 'Moon', 'Mars system', 'Jupiter system', 'Saturn system', 'Uranus system', 'Neptune system', 'Pluto system']) need(k in systemGm, `astro par: no GM for ${k}`);
  return {
    description: 'JPL astrodynamic parameters: astronomical unit, J2000 obliquity (IAU 1976, the value of the JPL element tables), heliocentric GM, DE440 planetary-system GMs',
    units: { auM: 'm', obliquityArcsec: 'arcsec', gmSunM3s2: 'm^3/s^2', systemGm: 'km^3/s^2' },
    auM: n(au[2].replace(/ m$/, ''), 'au'),
    obliquityArcsec: n(obl[2].replace(/ arcsec$/, ''), 'obliquity'),
    gmSunM3s2: Number(gmSunMatch[1]) * 10 ** Number(gmSunMatch[2]),
    systemGm,
  };
}

// --------------------------------------------------------------------------------- NAIF text PCK (pck00011)

/** Kernel-pool assignments of the \begindata blocks (last assignment wins, += appends). */
export function parsePck(text) {
  const vars = {};
  let inData = false;
  let buf = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '\\begindata') { inData = true; continue; }
    if (line === '\\begintext') { inData = false; continue; }
    if (inData) buf += ` ${raw}`;
    else if (buf) { buf += '\n'; }
  }
  const re = /([A-Za-z0-9_]+)\s*(\+?=)\s*(\([^)]*\)|[^\s()]+)/g;
  let m;
  while ((m = re.exec(buf)) !== null) {
    const name = m[1].toUpperCase();
    const body = m[3].startsWith('(') ? m[3].slice(1, -1) : m[3];
    const values = body.split(/[\s,]+/).filter(Boolean).map((t) => {
      const v = num(t);
      need(Number.isFinite(v), `pck: ${name}: "${t}"`);
      return v;
    });
    vars[name] = m[2] === '+=' && vars[name] ? vars[name].concat(values) : values;
  }
  return vars;
}

export function extractPck(text, naifIds) {
  const all = parsePck(text);
  const keep = {};
  const systems = new Set(naifIds.filter((id) => id >= 100 && id < 1000).map((id) => Math.floor(id / 100)));
  for (const [k, v] of Object.entries(all)) {
    const m = /^BODY(\d+)_/.exec(k);
    if (!m) continue;
    const id = Number(m[1]);
    if (naifIds.includes(id) || (systems.has(id) && /_(NUT_PREC_ANGLES|MAX_PHASE_DEGREE)$/.test(k))) keep[k] = v;
  }
  for (const id of naifIds) for (const s of ['POLE_RA', 'POLE_DEC', 'PM', 'RADII']) need(`BODY${id}_${s}` in keep, `pck: BODY${id}_${s} missing`);
  return {
    description: 'NAIF generic text PCK pck00011 (IAU WGCCRE 2009/2015 rotation models and radii): data-block assignments for the bodies of this tool',
    units: { POLE: 'deg, deg/century, deg/century^2', PM: 'deg, deg/day, deg/day^2', NUT_PREC: 'deg', NUT_PREC_ANGLES: 'deg, deg/century (+ deg/century^2 when MAX_PHASE_DEGREE = 2)', RADII: 'km' },
    vars: keep,
  };
}

// ----------------------------------------------------------------------------------- JPL SBDB (dwarf planets)

export function extractSbdb(json) {
  const d = JSON.parse(json);
  need(d.orbit && Array.isArray(d.orbit.elements), 'sbdb: no orbit');
  const el = Object.fromEntries(d.orbit.elements.map((e) => [e.name, Number(e.value)]));
  for (const k of ['e', 'a', 'i', 'om', 'w', 'ma', 'n']) need(Number.isFinite(el[k]), `sbdb: element ${k}`);
  const phys = {};
  for (const p of d.phys_par ?? []) phys[p.name] = { value: p.value, ref: p.ref ?? null };
  return {
    description: 'JPL Small-Body Database: heliocentric osculating elements (ecliptic and equinox of J2000) and physical parameters',
    object: { fullname: d.object.fullname, spkid: d.object.spkid },
    epochJdTdb: Number(d.orbit.epoch),
    equinox: d.orbit.equinox,
    orbitSource: d.orbit.source ?? null,
    solutionDate: d.orbit.soln_date ?? null,
    units: { a: 'au', angles: 'deg', n: 'deg/d' },
    elements: { a: el.a, e: el.e, iDeg: el.i, nodeDeg: el.om, argPeDeg: el.w, meanAnomalyDeg: el.ma, meanMotionDegPerDay: el.n },
    phys,
  };
}

// ------------------------------------------------------------------------------ Horizons object-data headers

/** "Geometric Albedo = 0.63 +- 0.02" (any spelling) -> 0.63, or null when the header leaves it blank. */
export function horizonsAlbedo(text) {
  const m = /Geometric\s+albedo\s*=\s*([0-9.]+)/i.exec(text) ?? /ALBEDO=\s*([0-9.]+)/.exec(text);
  return m ? Number(m[1]) : null;
}

// --------------------------------------------------------------------------------------- NSSDC fact sheets

export function nssdcLines(html) {
  return textLines(html);
}

/** Row "Geometric albedo" (or "Visual geometric albedo" column) of a fact sheet table, by first column label. */
export function nssdcRow(html, label) {
  return tableRows(html).find((r) => r[0] === label) ?? null;
}

export { tableRows, textLines, num };
