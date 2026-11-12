// Readers for the second group of sources (atmosphere profiles, heating constants, ratios of specific heats,
// colour indices, DEM ranges). Each returns plain data with its source; fetch-sources.mjs writes the results
// to tools/bodies/sources/{atmospheres,colours,dem-relief}.json. PDFs are read by tools/bodies/pdftext.py
// (python -I, pypdf), only as text.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchCached, REPO_ROOT } from './http.mjs';
import { mixtureGamma } from './nist.mjs';
import { composition, nssdcAtmosphere } from './nssdcAtmo.mjs';
import { titanTable } from './profiles.mjs';

const src = (m) => ({ url: m.url, retrievedAt: m.retrievedAt, sha256: m.sha256 });
const need = (c, msg) => {
  if (!c) throw new Error(msg);
};

export function pdfText(path, pages) {
  return execFileSync('python', ['-I', join(REPO_ROOT, 'tools/bodies/pdftext.py'), path, ...pages.map(String)], { encoding: 'utf8', maxBuffer: 1 << 26 });
}

// ------------------------------------------------------------------------------------------- documents

export const DOCS = {
  justusBraun: { id: 'ntrs-justus-braun-2007', file: '20070032693.pdf', url: 'https://ntrs.nasa.gov/api/citations/20070032693/downloads/20070032693.pdf', cite: 'Justus, C. G. & Braun, R. D. (2007), Atmospheric Environments for Entry, Descent and Landing (EDL), NASA NTRS 20070032693' },
  suttonGraves: { id: 'ntrs-sutton-graves-1971', file: '19720003329.pdf', url: 'https://ntrs.nasa.gov/api/citations/19720003329/downloads/19720003329.pdf', cite: 'Sutton, K. & Graves, R. A. (1971), A General Stagnation-Point Convective-Heating Equation for Arbitrary Gas Mixtures, NASA TR R-376' },
  venusGram: { id: 'amat-venus-gram', file: 'venus-gram-avg.dat', url: 'https://raw.githubusercontent.com/athulpg007/AMAT/master/atmdata/Venus/venus-gram-avg.dat', cite: 'Venus-GRAM (Justus et al., NASA; VIRA, Kliore et al. 1986) average profile as distributed with AMAT (Girija et al. 2021, JOSS 6(67) 3710, doi:10.21105/joss.03710)' },
  hasiEntry: { id: 'pds-huygens-hasi', file: 'HASI_L4_ATMO_PROFILE_ENTRY.TAB', url: 'https://atmos.nmsu.edu/PDS/data/hphasi_0001/DATA/PROFILES/HASI_L4_ATMO_PROFILE_ENTRY.TAB', cite: 'Huygens HASI (Fulchignoni et al. 2005, Nature 438, 785), PDS data set HP-SSA-HASI-2-3-4-MISSION-V1.1' },
  hasiDescent: { id: 'pds-huygens-hasi', file: 'HASI_L4_ATMO_PROFILE_DESCEN.TAB', url: 'https://atmos.nmsu.edu/PDS/data/hphasi_0001/DATA/PROFILES/HASI_L4_ATMO_PROFILE_DESCEN.TAB', cite: 'Huygens HASI (Fulchignoni et al. 2005, Nature 438, 785), PDS data set HP-SSA-HASI-2-3-4-MISSION-V1.1' },
  ramirez: { id: 'arxiv-ramirez-2012', file: 'abs-1204.0828.html', url: 'https://arxiv.org/abs/1204.0828', cite: 'Ramirez, I. et al. (2012), The UBV(RI)c colors of the Sun, ApJ 752, 5 (arXiv:1204.0828)' },
  mallama: { id: 'arxiv-mallama-2017', file: '1609.05048v1.pdf', url: 'https://arxiv.org/pdf/1609.05048v1', cite: 'Mallama, A., Krobusek, B. & Pavlov, H. (2017), Comprehensive wide-band magnitudes and albedos for the planets, Icarus 282, 19 (arXiv:1609.05048), Table 3' },
  satcol: { id: 'pds-sbn-satcol', file: 'satcol.tab', url: 'https://sbnarchive.psi.edu/pds4/non_mission/compil.satellite.colors/data/satcol.tab', cite: 'PDS Small Bodies Node, Small Planetary Satellite Colors V1.0 (Cruikshank 1980 values)' },
  burns: { id: 'uapress-burns-1977', file: 'planetary-satellites.pdf', url: 'https://open.uapress.arizona.edu/system/actioncallout/f/c/8/fc8e6b81-8b9a-4138-b2da-0d2698521f31/attachment/f80a804bf9ccb6af095cdc9c2cb4deef.pdf', cite: 'Burns, J. A. (ed.) (1977), Planetary Satellites, University of Arizona Press (open access): Tables 9.2, 9.9, 22.3' },
  buie: { id: 'arxiv-buie-2006', file: 'astro-ph-0512491v2.pdf', url: 'https://arxiv.org/pdf/astro-ph/0512491v2', cite: 'Buie, M. W. et al. (2006), Orbits and photometry of Pluto\'s satellites, AJ 132, 290 (arXiv:astro-ph/0512491), Table 4' },
};

export async function fetchDoc(d, opts) {
  return fetchCached(d.id, d.file, d.url, opts);
}

// ------------------------------------------------------------------------------------- Sutton-Graves K

/** Table II of TR R-376 (PDF page 41): K in kg/(s m^3/2 atm^1/2) for the pure gases and air, by row order. */
export function suttonGravesTable(text) {
  const i = text.indexOf('TABLE II');
  need(i >= 0, 'TR R-376: no Table II');
  const t = text.slice(i);
  for (const label of ['He', 'Ne', 'Ar', 'CH4', '(air)']) need(t.includes(label), `TR R-376 Table II: row label ${label} not found (layout changed)`);
  const k = t.slice(t.indexOf('atm 1/2')).match(/(?:^|\s)(0?\.\d{4})(?=\s)/g).map((x) => Number(x.trim()));
  need(k.length >= 10, 'TR R-376 Table II: K column too short');
  const rows = ['N2', 'O2', 'H2', 'He', 'Ne', 'Ar', 'CO2', 'NH3', 'CH4', 'air'];
  return Object.fromEntries(rows.map((r, j) => [r, k[j]]));
}

const MOLAR_MASS = { CO2: 44.0095, N2: 28.0134, Ar: 39.948, H2: 2.01588, He: 4.002602, CH4: 16.0425, O2: 31.9988 };

/** Sutton-Graves mixing rule (TR R-376 eq. 44): 1/K^2 = sum c_i / K_i^2, c = mass fractions. */
export function mixtureK(composition, K) {
  const gases = Object.entries(composition).filter(([g]) => g in K);
  const mass = gases.map(([g, x]) => [g, x * MOLAR_MASS[g]]);
  const total = mass.reduce((s, [, m]) => s + m, 0);
  const inv = mass.reduce((s, [g, m]) => s + m / total / K[g] ** 2, 0);
  return 1 / Math.sqrt(inv);
}

// ------------------------------------------------------------------------------- the atmospheres file

const VENUS_ROWS_KM = [0, 10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200];

export async function buildAtmosphereSources(nssdc, earthLive) {
  const jb = await fetchDoc(DOCS.justusBraun);
  const jbText = pdfText(jb.path, [10, 16, 21, 28, 33]);
  const gammaOf = (re, what) => {
    const m = re.exec(jbText);
    need(m, `Justus & Braun: no ratio of specific heats for ${what}`);
    return Number(m[1]);
  };
  const jbGamma = {
    venus: gammaOf(/Cp\/Cv is ([0-9.]+) for Venus/, 'Venus'),
    earth: gammaOf(/Cp\/Cv is ([0-9.]+) for Earth/, 'Earth'),
    mars: gammaOf(/C\S*Cv is ([0-9.]+) for Mars/, 'Mars'),
    titan: gammaOf(/Cp\/Cv is ([0-9.]+) for Titan/, 'Titan'),
    // the OCR of the scanned page reads "taken to bel.45" for "taken to be 1.45"
    saturn: Number(`1.${(/Cp\/Cv is taken to be\s*[1l]?\.(\d+)/.exec(jbText) ?? [null, 'x'])[1]}`),
  };
  need(jbGamma.saturn > 1 && jbGamma.saturn < 1.7, 'Justus & Braun: no ratio of specific heats for Saturn');
  need(Math.abs(jbGamma.earth - 1.4) < 1e-9, 'Justus & Braun: Earth gamma is not 1.40 (OCR changed?)');

  const sg = await fetchDoc(DOCS.suttonGraves);
  const K = suttonGravesTable(pdfText(sg.path, [41]));

  // Venus: Venus-GRAM average (VIRA) at the rows; cross-checked against Justus & Braun Table 3.1.1 densities.
  const vg = await fetchDoc(DOCS.venusGram);
  const vrows = vg.text.split(/\r?\n/).filter((l) => /^\s*\d/.test(l)).map((l) => l.trim().split(/\s+/).map(Number));
  need(vrows.length > 200 && vrows.every((r) => r.length >= 4 && r.every(Number.isFinite)), 'venus-gram-avg.dat: unexpected format');
  const venusRows = VENUS_ROWS_KM.map((h) => {
    const r = vrows.find((x) => x[0] === h * 1000);
    need(r, `venus-gram-avg.dat: no row at ${h} km`);
    return { hKm: h, rho: r[3], p: r[2], T: r[1] };
  });
  const jbDens = /Height Density\s*\(km\)\s*\(kg\/m3\)([\s\S]*?)temperature/.exec(jbText);
  need(jbDens, 'Justus & Braun Table 3.1.1 not found');
  const dens = jbDens[1].match(/\d\.\d\dE[+-]\d\d/g).map(Number);
  need(dens.length === 16, `Justus & Braun Table 3.1.1: ${dens.length} densities`);
  const crossCheck = dens.map((d, k) => ({ hKm: 10 * k, viraJustusBraun: d, table: venusRows[k].rho, ratio: Number((venusRows[k].rho / d).toFixed(4)) }));

  // Titan: HASI.
  const he = await fetchDoc(DOCS.hasiEntry);
  const hd = await fetchDoc(DOCS.hasiDescent);
  const titan = titanTable(he.text, hd.text);

  const bodies = {};
  const nssdcBody = (sheet, id, gasClass, floor) => {
    const a = nssdcAtmosphere(sheet, nssdc.atmosphere[sheet].lines);
    bodies[id] = { model: 'exponential', rho0: a.rho0, p0: a.p0, scaleHeightKm: a.scaleHeightKm, temperature: a.temperature, meanMolecularWeight: a.meanMolecularWeight, composition: a.composition, gasClass, floor: floor ? { pressureRatio: 10 } : null, source: nssdc.atmosphere[sheet].source, note: `NASA NSSDC fact sheet, ${a.reference}${a.notes.length ? `; ${a.notes.join('; ')}` : ''}` };
  };
  nssdcBody('marsfact', 'mars', 'co2', false);
  nssdcBody('jupiterfact', 'jupiter', 'h2he', true);
  nssdcBody('saturnfact', 'saturn', 'h2he', true);
  nssdcBody('uranusfact', 'uranus', 'h2he', true);
  nssdcBody('neptunefact', 'neptune', 'h2he', true);
  const vLines = nssdc.atmosphere.venusfact.lines;
  const vMajor = vLines.findIndex((l) => /^Major/.test(l));
  const vMu = /Mean molecular weight:\s*([0-9.]+)/.exec(vLines.find((l) => /^Mean molecular weight/.test(l)) ?? '');
  need(vMajor >= 0 && vMu, 'nssdc venusfact: composition or mean molecular weight missing');
  const venusN = { meanMolecularWeight: Number(vMu[1]), composition: composition(`${vLines[vMajor]} ${vLines[vMajor + 1] ?? ''}`) };
  bodies.venus = { model: 'table', rows: venusRows, meanMolecularWeight: venusN.meanMolecularWeight, composition: venusN.composition, gasClass: 'co2', source: src(vg.meta), note: `${DOCS.venusGram.cite}; rows at ${VENUS_ROWS_KM.join(', ')} km; densities within ${(Math.max(...crossCheck.filter((c) => c.hKm <= 100).map((c) => Math.abs(c.ratio - 1))) * 100).toFixed(1)} % of VIRA as tabulated by ${DOCS.justusBraun.cite}, Table 3.1.1, from 0 to 100 km; above 100 km VIRA depends on local time and the two differ by up to ${Math.round(Math.max(...crossCheck.map((c) => Math.abs(c.ratio - 1))) * 100)} % (the table is the Venus-GRAM average)`, crossCheck };
  bodies.titan = { model: 'table', rows: titan.rows.map(({ samples: _s, ...r }) => r), meanMolecularWeight: Number((titan.molarMassKgPerMol * 1000).toFixed(3)), composition: { N2: 0.95, CH4: 0.05 }, gasClass: 'n2ch4', source: src(he.meta), sources: [src(he.meta), src(hd.meta)], note: `${DOCS.hasiEntry.cite}: descent profile (0-147 km) and entry profile (157-1,380 km; density = p M / (R T) with M = ${(titan.molarMassKgPerMol * 1000).toFixed(3)} g/mol, the descent file's own value over its top 10 km); rows averaged over windows of +-0.5 km below 150 km and +-5 km above` };

  // Ratio of specific heats: Justus & Braun where it states one, else the NIST ideal-mixture value at the
  // reference level (Jupiter, Uranus, Neptune: normal hydrogen at the 1-bar temperature).
  for (const id of Object.keys(bodies)) {
    const b = bodies[id];
    if (jbGamma[id] !== undefined) {
      b.gamma = { value: jbGamma[id], source: src(jb.meta), note: `${DOCS.justusBraun.cite}: "the ratio of specific heats Cp/Cv" for ${id}` };
    } else {
      const g = await mixtureGamma(b.composition, b.temperature, b.p0);
      b.gamma = { value: Number(g.value.toFixed(4)), source: { url: 'https://webbook.nist.gov/chemistry/fluid/', retrievedAt: g.parts[0].source.retrievedAt }, note: `NIST Chemistry WebBook fluid tables (normal hydrogen): ideal mixture of ${g.parts.map((p) => `${p.gas} ${(p.x * 100).toFixed(1)} % (cp ${p.cp}, cv ${p.cv} J/(mol K) at ${p.T} K, ${p.pMPa} MPa)`).join(', ')}; Justus & Braun state none for this planet`, parts: g.parts.map((p) => ({ gas: p.gas, x: p.x, T: p.T, pMPa: p.pMPa, cp: p.cp, cv: p.cv, url: p.source.url })) };
    }
  }

  // Heating sets per gas class: Sutton-Graves k scaled from Earth's v1 constant by K(mixture) / K(air) of TR R-376
  // (the conversion between the two forms of the equation does not depend on the gas); radiative heating only
  // for air (the v1 set): no public CO2, N2-CH4 or H2-He radiative correlation with its velocity table was found.
  const kAir = earthLive.atmosphere.heating.kConv;
  const heating = {};
  for (const [id, b] of Object.entries(bodies)) {
    const comp = b.composition;
    const Kmix = mixtureK(comp, K);
    heating[id] = { set: { kConv: Number((kAir * (Kmix / K.air)).toPrecision(5)), radiative: null }, source: src(sg.meta), note: `${DOCS.suttonGraves.cite}, Table II K and eq. 44 mixing (mass fractions of the mole fractions ${JSON.stringify(comp)}): K = ${Kmix.toFixed(5)}, kConv = Earth's ${kAir} x K / K(air ${K.air}); radiative heating not modelled for this gas (no public correlation with its velocity table found)` };
  }
  return { description: 'Physical atmospheres of the staged bodies: models, rows, ratios of specific heats, the heating set of the gas of each body', bodies, heating, suttonGravesK: K, justusBraunGamma: jbGamma, justusBraunSource: src(jb.meta) };
}

// ------------------------------------------------------------------------------------------- colours



export async function buildColourSources(sbdbCeres) {
  const ra = await fetchDoc(DOCS.ramirez);
  const abs = /citation_abstract" content="([^"]*)/.exec(ra.text);
  need(abs, 'Ramirez 2012: no abstract');
  const bv = /\(B-V\)=([0-9.]+)/.exec(abs[1]);
  const vr = /\(V-R\)(?:_?c|C)?=([0-9.]+)/.exec(abs[1]);
  need(bv && vr, 'Ramirez 2012: solar colours not found in the abstract');
  const sun = { bv: Number(bv[1]), vr: Number(vr[1]), source: src(ra.meta), note: `${DOCS.ramirez.cite} (V-R in the Cousins system)` };

  const bodies = {};
  // Planets: Mallama 2017 Table 3, "Reference" magnitudes B, V, Rc.
  const ma = await fetchDoc(DOCS.mallama);
  const mt = pdfText(ma.path, [9]);
  need(/Table 3\. Johnson-Cousins magnitudes/.test(mt), 'Mallama 2017: Table 3 not on page 9');
  const lines = mt.split('\n');
  for (const p of ['Mercury', 'Venus', 'Mars', 'Jupiter', 'Saturn', 'Uranus', 'Neptune']) {
    const at = lines.findIndex((l) => l.startsWith(p));
    need(at >= 0, `Mallama Table 3: no ${p}`);
    const ref = lines.slice(at, at + 5).find((l) => /Reference/.test(l));
    need(ref, `Mallama Table 3: no Reference row for ${p}`);
    const v = ref.split(/\s+/).filter((x) => /^-?\d+\.\d+$/.test(x)).map(Number);
    need(v.length === 7, `Mallama Table 3: ${p} Reference row has ${v.length} values`);
    const [, B, V, , , Rc] = v;
    bodies[p.toLowerCase()] = { bv: Number((B - V).toFixed(3)), vr: Number((V - Rc).toFixed(3)), source: src(ma.meta), note: `${DOCS.mallama.cite}: B-V and V-Rc of the Reference magnitudes` };
  }
  // Satellites with V-B in the PDS SBN compilation (Cruikshank 1980): B-V = -(V-B), mean of the entries.
  const sc = await fetchDoc(DOCS.satcol);
  for (const [id, name] of [['enceladus', 'Enceladus'], ['tethys', 'Tethys'], ['dione', 'Dione'], ['rhea', 'Rhea'], ['titania', 'Titania'], ['oberon', 'Oberon']]) {
    const vals = sc.text.split(/\r?\n/).filter((l) => new RegExp(`^\\S+\\s+${name}\\s`).test(l) && /\sV-B\s/.test(l)).map((l) => -Number(l.trim().split(/\s+/)[4]));
    need(vals.length > 0, `satcol: no V-B for ${name}`);
    bodies[id] = { bv: Number((vals.reduce((a, b) => a + b, 0) / vals.length).toFixed(3)), vr: null, source: src(sc.meta), note: `${DOCS.satcol.cite}: B-V = -(V-B), ${vals.length} entr${vals.length > 1 ? 'ies' : 'y'}` };
  }
  // Burns 1977: Phobos and Deimos (Table 9.2), Triton (Table 9.9), Titan (Table 22.3, mean of the listed B-V at zero phase).
  const bu = await fetchDoc(DOCS.burns);
  const mars = pdfText(bu.path, [210]);
  const mm = [...mars.matchAll(/^(\d\.\d+)(?:±[\d.]+)?\s+(?:\d\.\d+±[\d.]+\s+)?(Kuiper|Zellner)/gm)];
  need(mm.length === 3 && /Satellites of Mars/.test(mars), `Burns Table 9.2: ${mm.length} B-V entries`);
  bodies.phobos = { bv: Number(mm[0][1]), vr: null, source: src(bu.meta), note: `${DOCS.burns.cite}: Table 9.2, Kuiper (Harris 1961)` };
  bodies.deimos = { bv: Number(mm[2][1]), vr: null, source: src(bu.meta), note: `${DOCS.burns.cite}: Table 9.2, Zellner and Capen (1974), photoelectric` };
  const nep = pdfText(bu.path, [226]);
  const tr = /Triton\s+[\d.]+\s+([\d.]+)\s+([\d.]+)\s+Harris/.exec(nep);
  need(tr, 'Burns Table 9.9: no Triton row');
  bodies.triton = { bv: Number(tr[1]), vr: null, source: src(bu.meta), note: `${DOCS.burns.cite}: Table 9.9 (Harris 1961)` };
  const ti = pdfText(bu.path, [483]);
  need(/Titan: B-V Color/.test(ti), 'Burns Table 22.3 not on page 483');
  const tv = ti.slice(ti.indexOf('Titan: B-V Color')).split('\n').map((l) => l.trim()).filter((l) => /^1\.\d+$/.test(l)).map(Number);
  need(tv.length >= 6, `Burns Table 22.3: ${tv.length} values`);
  bodies.titan = { bv: Number((tv.reduce((a, b) => a + b, 0) / tv.length).toFixed(3)), vr: null, source: src(bu.meta), note: `${DOCS.burns.cite}: Table 22.3, mean of ${tv.length} B-V at zero phase (${tv.join(', ')})` };
  // Pluto and Charon: Buie et al. 2006 Table 4.
  const bp = await fetchDoc(DOCS.buie);
  const pt = pdfText(bp.path, [15]);
  const pc = /\(B\s*[−-]\s*V\s*\)\s+([\d.]+)\s+([\d.]+)/.exec(pt);
  need(pc && /Pluto Charon/.test(pt), 'Buie 2006 Table 4: no B-V row');
  bodies.pluto = { bv: Number(pc[1]), vr: null, source: src(bp.meta), note: `${DOCS.buie.cite}` };
  bodies.charon = { bv: Number(pc[2]), vr: null, source: src(bp.meta), note: `${DOCS.buie.cite} (Charon's value adopted there from Buie et al. 1997)` };
  // Ceres: SBDB (Tedesco UBV mean values).
  bodies.ceres = { bv: Number(sbdbCeres.phys.BV.value), vr: null, source: src(sbdbCeres.source), note: `JPL SBDB B-V (${sbdbCeres.phys.BV.ref})` };
  // The bodies without a published Johnson B-V in the sources above (Io and Ganymede have global colour maps): the
  // CHROMATICITY of planet-bake's baked level-0 albedo (data/staged/render/albedo-means.json, its tracked output,
  // read only; request bodies-ephemeris-5). Its luminance is the bake's calibration and is not used: the
  // generator scales the colour to the body's geometric albedo. Each row states its colour basis (Harris 1961,
  // Karkoschka 2001; Mimas none: neutral grey).
  const meansPath = join(REPO_ROOT, 'data/staged/render/albedo-means.json');
  const means = JSON.parse(readFileSync(meansPath, 'utf8')).bodies;
  for (const id of ['io', 'ganymede', 'europa', 'callisto', 'mimas', 'iapetus', 'miranda', 'ariel', 'umbriel']) {
    const m = means[id];
    need(m && Array.isArray(m.meanLinearRgb) && m.meanLinearRgb.length === 3, `albedo-means.json: no mean colour for ${id}`);
    bodies[id] = { bv: null, vr: null, linearRgb: m.meanLinearRgb, source: { path: 'data/staged/render/albedo-means.json (planet-bake)' }, note: `chromaticity of planet-bake's baked level-0 albedo (${m.colourBasis})` };
  }
  return { description: 'Broadband colour indices (Johnson B-V; V-R in the Cousins system) of the Sun and the bodies, for the mean colour of the far-field disc', sun, bodies };
}

// -------------------------------------------------------------------------------------------- DEM ranges

/**
 * Height range of each DEM planet-bake bakes: the published range where the product states one (Mars: the
 * GDAL statistics of the USGS file; Venus: the USGS product page), otherwise the storage range of the file
 * (its TIFF header: 16-bit signed samples, -32768 = no data), which bounds what the bake can produce.
 */
export async function buildDemRelief(bakeConfigs) {
  const out = {};
  for (const [id, cfg] of Object.entries(bakeConfigs)) {
    if (!cfg.height?.dem) continue;
    const url = cfg.sources[cfg.height.dem.source].url;
    const name = url.split('/').pop();
    if (id === 'mars') {
      const r = await fetchCached('usgs-dem-mars', `${name}.aux.xml`, `${url}.aux.xml`);
      const mn = /STATISTICS_MINIMUM">(-?[\d.]+)</.exec(r.text);
      const mx = /STATISTICS_MAXIMUM">(-?[\d.]+)</.exec(r.text);
      need(mn && mx, 'Mars DEM aux.xml: no statistics');
      out[id] = { min: Number(mn[1]), max: Number(mx[1]), kind: 'published statistics (GDAL .aux.xml of the USGS product)', source: src(r.meta) };
    } else if (id === 'venus') {
      const r = await fetchCached('usgs-dem-venus', 'venus_magellan_global_topography_4641m.html', 'https://astrogeology.usgs.gov/search/map/venus_magellan_global_topography_4641m');
      const m = /data range of (-?\d+) to (-?\d+) meters/.exec(r.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' '));
      need(m, 'Venus DEM product page: no data range');
      out[id] = { min: Number(m[1]), max: Number(m[2]), kind: 'published data range (USGS product page)', source: src(r.meta) };
    } else {
      const r = await fetchCached(`usgs-dem-${id}`, `${name}.head`, url, { headers: { Range: 'bytes=0-65535' } });
      const b = readFileSync(r.path);
      const le = b.toString('latin1', 0, 2) === 'II';
      const u16 = (o) => (le ? b.readUInt16LE(o) : b.readUInt16BE(o));
      const u32 = (o) => (le ? b.readUInt32LE(o) : b.readUInt32BE(o));
      need(u16(2) === 42, `${id} DEM: not a classic TIFF`);
      const ifd = u32(4);
      const tags = {};
      for (let i = 0; i < u16(ifd); i++) {
        const o = ifd + 2 + 12 * i;
        tags[u16(o)] = u16(o + 8);
      }
      need(tags[258] === 16 && tags[339] === 2, `${id} DEM: samples are not 16-bit signed (bits ${tags[258]}, format ${tags[339]})`);
      out[id] = { min: -32767, max: 32767, kind: 'storage range of the file (16-bit signed samples, -32768 = no data; TIFF header), no published range', source: src(r.meta) };
    }
  }
  return { description: 'Height range of the DEM of each body planet-bake bakes from a DEM (DN units before the bake config\'s scale and offset)', bodies: out };
}
