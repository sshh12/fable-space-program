#!/usr/bin/env node
// Downloads the source documents of tools/bodies (cached under data/cache/bodies/<id>/) and extracts the tables
// the generator reads into tools/bodies/sources/<id>.json. Each extracted file carries `source` = the URL, the
// time of retrieval and the sha256 of the document it was read from. Run it to refresh the tables (with
// --refresh to download again); `generate.mjs` itself never goes to the network.
//
//   node tools/bodies/fetch-sources.mjs [--refresh]
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { CATALOGUE, BODY_ORDER, NAIF_IDS, SAT_NAMES } from './lib/catalogue.mjs';
import { extractApproxPos, extractAstroPar, extractPck, extractPlanetPhys, extractSatElem, extractSatPhys, extractSbdb, horizonsAlbedo, nssdcRow, tableRows } from './lib/extract.mjs';
import { fetchCached, REPO_ROOT } from './lib/http.mjs';
import { NSSDC_SHEETS, SOURCES, nssdcSource } from './lib/sourceList.mjs';

const refresh = process.argv.includes('--refresh');
const OUT = join(REPO_ROOT, 'tools/bodies/sources');
mkdirSync(OUT, { recursive: true });

const write = (id, data) => {
  writeFileSync(join(OUT, `${id}.json`), `${JSON.stringify(data, null, 2)}\n`);
  console.log(`wrote tools/bodies/sources/${id}.json`);
};
const src = (meta) => ({ url: meta.url, retrievedAt: meta.retrievedAt, sha256: meta.sha256, bytes: meta.bytes });

const docs = {};
for (const s of SOURCES) docs[s.id] = await fetchCached(s.id, s.file, s.url, { refresh });

write('jpl-approx-pos', { source: src(docs['jpl-approx-pos'].meta), ...extractApproxPos(docs['jpl-approx-pos'].text) });
write('jpl-sat-elem', { source: src(docs['jpl-sat-elem'].meta), ...extractSatElem(docs['jpl-sat-elem'].text, SAT_NAMES) });
write('jpl-sat-phys', { source: src(docs['jpl-sat-phys'].meta), ...extractSatPhys(docs['jpl-sat-phys'].text) });
write('jpl-planet-phys', { source: src(docs['jpl-planet-phys'].meta), ...extractPlanetPhys(docs['jpl-planet-phys'].text) });
write('jpl-astro-par', { source: src(docs['jpl-astro-par'].meta), ...extractAstroPar(docs['jpl-astro-par'].text) });
write('naif-pck00011', { source: src(docs['naif-pck00011'].meta), ...extractPck(docs['naif-pck00011'].text, NAIF_IDS) });
write('sbdb-ceres', { source: src(docs['sbdb-ceres'].meta), ...extractSbdb(docs['sbdb-ceres'].text) });
write('sbdb-pluto', { source: src(docs['sbdb-pluto'].meta), ...extractSbdb(docs['sbdb-pluto'].text) });

// Horizons object-data headers: the geometric albedo JPL lists for each body (JPL's own number for the
// satellites, whose physical-parameter table has no albedo column).
const objdata = {};
for (const id of BODY_ORDER) {
  const c = CATALOGUE[id];
  const url = `https://ssd.jpl.nasa.gov/api/horizons.api?format=text&COMMAND=${encodeURIComponent(`'${c.horizons}'`)}&OBJ_DATA=%27YES%27&MAKE_EPHEM=%27NO%27`;
  const r = await fetchCached('horizons-objdata', `${id}.txt`, url, { refresh });
  const line = r.text.split('\n').find((l) => /Geometric\s+albedo|ALBEDO=/i.test(l)) ?? null;
  objdata[id] = { source: src(r.meta), geometricAlbedo: horizonsAlbedo(r.text), line: line ? line.trim() : null };
}
write('horizons-objdata', { description: 'JPL Horizons object-data headers (OBJ_DATA): the geometric albedo line of each body', bodies: objdata });

// Horizons states the generator needs (committed so generation never goes to the network):
//  - calibration: every satellite at ten epochs from 2010-01-01 to 2029-09-01 TDB (before the validation
//    window), to choose the reading of each satellite-table row (lib/orbits.mjs);
//  - fitSpans: the Saturnian satellites over +-3 periods about the lobby epoch at a 24th of a period, for the
//    brief's fit path.
{
  const { vectorsAt, vectorsRange } = await import('./lib/horizons.mjs');
  const { horizonsCenter } = await import('./lib/catalogue.mjs');
  const { LOBBY_EPOCH_UT } = await import('./lib/orbits.mjs');
  const { utToJd } = await import('./lib/kepler.mjs');
  const satElem = JSON.parse((await import('node:fs')).readFileSync(join(OUT, 'jpl-sat-elem.json'), 'utf8')).rows;
  const C0 = 2455197.5; // 2010-01-01 TDB
  const C1 = 2462380.5; // 2029-09-01 TDB
  const calJds = Array.from({ length: 10 }, (_, k) => C0 + (k * (C1 - C0)) / 9);
  const calibration = {};
  const fitSpans = {};
  const jdL = utToJd(LOBBY_EPOCH_UT);
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (c.kind !== 'moon' || id === 'moon') continue;
    const center = horizonsCenter(id);
    const cal = await vectorsAt(c.horizons, center, calJds, `cal-${id}`);
    calibration[id] = { command: c.horizons, center, source: src(cal.meta), rows: cal.rows };
    if (c.parent === 'saturn') {
      const P = satElem[c.satName].periodDays;
      const stepMin = Math.max(1, Math.round((P * 1440) / 24));
      const span = await vectorsRange(c.horizons, center, (jdL - 3 * P).toFixed(6), (jdL + 3 * P).toFixed(6), `${stepMin} m`, `fit-${id}`);
      fitSpans[id] = { command: c.horizons, center, stepMinutes: stepMin, source: src(span.meta), rows: span.rows };
    }
  }
  write('horizons-states', {
    description: 'JPL Horizons state vectors (ICRF axes, geometric, TDB; position m, velocity m/s, relative to the parent body centre) used by the generator: calibration epochs of every satellite and the fit spans of the Saturnian satellites about the lobby epoch',
    lobbyEpochUt: LOBBY_EPOCH_UT,
    calibrationJds: calJds,
    calibration,
    fitSpans,
  });
}

// NASA NSSDC fact sheets: geometric albedos (cross-check and the values JPL does not list), the atmosphere
// lines of the planets with atmospheres, Saturn's ring table.
const nssdc = {};
for (const sheet of NSSDC_SHEETS) {
  const s = nssdcSource(sheet);
  const r = await fetchCached(s.id, s.file, s.url, { refresh });
  nssdc[sheet] = { source: src(r.meta), html: r.text };
}
const sheetLines = (sheet) =>
  nssdc[sheet].html
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&gt;/g, '>')
    .replace(/&lt;/g, '<')
    .split('\n')
    .map((x) => x.replace(/\s+/g, ' ').trim())
    .filter((x) => x.length > 0);
const lineOf = (sheet, re) => {
  const l = sheetLines(sheet).find((x) => re.test(x));
  if (!l) throw new Error(`nssdc ${sheet}: no line matching ${re}`);
  return l;
};
/** The line after the one matching `re` (the composition continues on it: methane, argon). */
const lineAfter = (sheet, re) => {
  const ls = sheetLines(sheet);
  const i = ls.findIndex((x) => re.test(x));
  if (i < 0 || i + 1 >= ls.length) throw new Error(`nssdc ${sheet}: no line after ${re}`);
  return ls[i + 1];
};
const firstNumber = (s) => Number(/(-?[\d,]*\.?\d+)/.exec(s.replace(/,/g, ''))[1]);
const albedoRow = (sheet) => {
  const row = nssdcRow(nssdc[sheet].html, 'Geometric albedo');
  if (!row) throw new Error(`nssdc ${sheet}: no geometric albedo row`);
  return Number(row[1]);
};
const satAlbedo = (sheet, label) => {
  const row = tableRows(nssdc[sheet].html).find((r) => r[0].startsWith(label) && r.length === 5);
  if (!row) throw new Error(`nssdc ${sheet}: no satellite row ${label}`);
  return row[4];
};
const mars = tableRows(nssdc.marsfact.html);
const marsMoons = mars.find((r) => r[0] === 'Geometric albedo' && r.length === 3);
// Charon has its own text block on the Pluto sheet ("Charon (P1)" ... "Geometric Albedo 0.42").
const plutoText = nssdc.plutofact.html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
const charonBlock = /Charon \(P1\)(.*?)Other Moons of Pluto/.exec(plutoText);
if (!charonBlock) throw new Error('nssdc plutofact: no Charon block');
const charonAlbedo = /Geometric Albedo ([0-9.]+)/.exec(charonBlock[1]);
if (!charonAlbedo) throw new Error('nssdc plutofact: no Charon geometric albedo');
const charonRow = [charonAlbedo[1]];
const atmo = {};
for (const [sheet, labels] of Object.entries({
  venusfact: [/^Surface pressure:/, /^Surface density:/, /^Scale height:/, /^Average temperature:/, /^Mean molecular weight:/, /^Major:/],
  marsfact: [/^Surface pressure:/, /^Surface density:/, /^Scale height:/, /^Average temperature:/, /^Mean molecular weight:/, /^Major/],
  jupiterfact: [/^Density at 1 bar:/, /^Temperature at 1 bar:/, /^Scale height:/, /^Mean molecular weight:/, /^Major:/],
  saturnfact: [/^Density at 1 bar:/, /^Temperature at 1 bar:/, /^Scale height:/, /^Mean molecular weight:/, /^Major:/],
  uranusfact: [/^Density at 1 bar:/, /^Temperature at 1 bar:/, /^Scale height:/, /^Mean molecular weight:/, /^Major:/],
  neptunefact: [/^Density at 1 bar:/, /^Temperature at 1 bar:/, /^Scale height:/, /^Mean molecular weight:/, /^Major:/],
})) {
  atmo[sheet] = { source: src(nssdc[sheet].source), lines: [...labels.map((re) => lineOf(sheet, re)), lineAfter(sheet, /^Major/)] };
}
const ringRows = tableRows(nssdc.satringfact.html).filter((r) => r.length >= 3);
write('nssdc', {
  description: 'NASA NSSDC planetary fact sheets: geometric albedos, atmosphere lines (verbatim), Saturn ring table (verbatim rows)',
  geometricAlbedo: {
    mercury: { value: albedoRow('mercuryfact'), source: src(nssdc.mercuryfact.source) },
    venus: { value: albedoRow('venusfact'), source: src(nssdc.venusfact.source) },
    mars: { value: albedoRow('marsfact'), source: src(nssdc.marsfact.source) },
    jupiter: { value: albedoRow('jupiterfact'), source: src(nssdc.jupiterfact.source) },
    saturn: { value: albedoRow('saturnfact'), source: src(nssdc.saturnfact.source) },
    uranus: { value: albedoRow('uranusfact'), source: src(nssdc.uranusfact.source) },
    neptune: { value: albedoRow('neptunefact'), source: src(nssdc.neptunefact.source) },
    pluto: { value: albedoRow('plutofact'), source: src(nssdc.plutofact.source) },
    phobos: { value: Number(marsMoons[1]), source: src(nssdc.marsfact.source) },
    deimos: { value: Number(marsMoons[2]), source: src(nssdc.marsfact.source) },
    charon: { value: Number(charonRow[charonRow.length - 1]), source: src(nssdc.plutofact.source) },
    io: { value: satAlbedo('joviansatfact', 'Io ('), source: src(nssdc.joviansatfact.source) },
    europa: { value: satAlbedo('joviansatfact', 'Europa'), source: src(nssdc.joviansatfact.source) },
    ganymede: { value: satAlbedo('joviansatfact', 'Ganymede'), source: src(nssdc.joviansatfact.source) },
    callisto: { value: satAlbedo('joviansatfact', 'Callisto'), source: src(nssdc.joviansatfact.source) },
    mimas: { value: satAlbedo('saturniansatfact', 'Mimas'), source: src(nssdc.saturniansatfact.source) },
    enceladus: { value: satAlbedo('saturniansatfact', 'Enceladus'), source: src(nssdc.saturniansatfact.source) },
    tethys: { value: satAlbedo('saturniansatfact', 'Tethys'), source: src(nssdc.saturniansatfact.source) },
    dione: { value: satAlbedo('saturniansatfact', 'Dione'), source: src(nssdc.saturniansatfact.source) },
    rhea: { value: satAlbedo('saturniansatfact', 'Rhea'), source: src(nssdc.saturniansatfact.source) },
    titan: { value: satAlbedo('saturniansatfact', 'Titan'), source: src(nssdc.saturniansatfact.source) },
    iapetus: { value: satAlbedo('saturniansatfact', 'Iapetus'), source: src(nssdc.saturniansatfact.source) },
    miranda: { value: satAlbedo('uraniansatfact', 'Miranda'), source: src(nssdc.uraniansatfact.source) },
    ariel: { value: satAlbedo('uraniansatfact', 'Ariel'), source: src(nssdc.uraniansatfact.source) },
    umbriel: { value: satAlbedo('uraniansatfact', 'Umbriel'), source: src(nssdc.uraniansatfact.source) },
    titania: { value: satAlbedo('uraniansatfact', 'Titania'), source: src(nssdc.uraniansatfact.source) },
    oberon: { value: satAlbedo('uraniansatfact', 'Oberon'), source: src(nssdc.uraniansatfact.source) },
    triton: { value: satAlbedo('neptuniansatfact', 'Triton'), source: src(nssdc.neptuniansatfact.source) },
  },
  atmosphere: atmo,
  saturnRings: { source: src(nssdc.satringfact.source), rows: ringRows },
});
void firstNumber;

// Atmosphere profiles, heating constants, ratios of specific heats; colour indices; DEM ranges.
{
  const { readFileSync } = await import('node:fs');
  const { buildAtmosphereSources, buildColourSources, buildDemRelief } = await import('./lib/derivedSources.mjs');
  const { loadBake } = await import('./lib/sources.mjs');
  const nssdcJson = JSON.parse(readFileSync(join(OUT, 'nssdc.json'), 'utf8'));
  const earthLive = JSON.parse(readFileSync(join(REPO_ROOT, 'data/defs/bodies/earth.json'), 'utf8'));
  write('atmospheres', await buildAtmosphereSources(nssdcJson, earthLive));
  write('colours', await buildColourSources(JSON.parse(readFileSync(join(OUT, 'sbdb-ceres.json'), 'utf8')), loadBake().configs));
  write('dem-relief', await buildDemRelief(loadBake().configs));
}
