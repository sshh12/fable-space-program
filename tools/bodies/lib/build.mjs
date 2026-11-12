// Builds the staged library: one BodyDef per body of ARCHITECTURE 8.1, the terrain section of each new solid
// body, the radii table, and the provenance of every generated number. Pure function of the source tables
// (tools/bodies/sources) and the live v1 Earth / Moon / Sun files; no network, no clock.
import { CATALOGUE, BODY_ORDER } from './catalogue.mjs';
import { AU_M, DEG } from './kepler.mjs';
import { LOBBY_EPOCH_UT, approxPosOrbit, readingName, round, roundDef, satFrame, satelliteOrbit, sbdbOrbit } from './orbits.mjs';
import { pckRotation } from './pck.mjs';
import { buildAtmosphere } from './atmospheres.mjs';
import { meanColourFromIndices } from './colour.mjs';

const capital = (s) => s[0].toUpperCase() + s.slice(1);
const src = (s) => ({ url: s.url, retrievedAt: s.retrievedAt });

/** Tile edge of the deepest render level, metres: the Earth (level 20) and Moon (level 18) precedent. */
const DEEPEST_TILE_EDGE_M = 10;

export function buildLibrary(S, live, bake) {
  const bodies = {};
  const terrain = {};
  const radii = [];
  const provenance = {};
  const paths = {};
  const pck = S.pck.vars;
  const AU = S.astroPar.auM === AU_M ? AU_M : (() => { throw new Error(`astro_par au ${S.astroPar.auM} differs from the runtime AU ${AU_M}`); })();
  const rot = (id) => pckRotation(pck, CATALOGUE[id].naif).at(LOBBY_EPOCH_UT);
  const pckSrc = src(S.pck.source);

  // ------------------------------------------------------------------ GM (km^3/s^2), radius, radii, albedo
  const gmKm = {};
  const meanRadiusKm = {};
  const albedo = {};
  const prov = (id, field, value, source, note) => {
    (provenance[id] ??= {})[field] = { value, ...(source ? { source } : {}), ...(note ? { note } : {}) };
  };
  const satRow = (name) => S.satPhys.satellites.find((s) => s.name === name);
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (id === 'sun') {
      gmKm[id] = S.astroPar.gmSunM3s2 / 1e9;
      prov(id, 'mu', S.astroPar.gmSunM3s2, src(S.astroPar.source), 'heliocentric gravitational constant (DE440)');
      meanRadiusKm[id] = pck.BODY10_RADII[0];
      prov(id, 'radius', meanRadiusKm[id] * 1e3, pckSrc, 'BODY10_RADII (IAU 2015 nominal solar radius)');
      continue;
    }
    if (id === 'earth' || id === 'moon') continue;
    if (c.kind === 'planet' || id === 'pluto') {
      const name = capital(id);
      const sys = S.astroPar.systemGm[`${name} system`];
      if (sys !== undefined) {
        const moons = S.satPhys.satellites.filter((s) => s.planet === name && s.gm !== null);
        const sum = moons.reduce((a, s) => a + s.gm, 0);
        gmKm[id] = sys - sum;
        prov(id, 'mu', gmKm[id] * 1e9, src(S.astroPar.source), `DE440 system GM ${sys} km^3/s^2 minus the ${moons.length} satellites with a GM in the JPL satellite table (${sum.toPrecision(10)} km^3/s^2, ${S.satPhys.source.url}); planet-only GM of the satellite ephemeris for comparison: ${S.satPhys.planetGm[name].gm} (${S.satPhys.planetGm[name].ref})`);
      } else {
        gmKm[id] = S.astroPar.systemGm[name];
        prov(id, 'mu', gmKm[id] * 1e9, src(S.astroPar.source), 'DE440 GM (no satellites)');
      }
      const pp = c.kind === 'planet' ? S.planetPhys.planets[name] : S.planetPhys.dwarfPlanets[name];
      meanRadiusKm[id] = pp.meanRadiusKm;
      prov(id, 'radius', pp.meanRadiusKm * 1e3, src(S.planetPhys.source), 'JPL mean radius');
    } else if (id === 'ceres') {
      const sb = S.sbdb['sbdb-ceres'];
      gmKm[id] = Number(sb.phys.GM.value);
      prov(id, 'mu', gmKm[id] * 1e9, src(sb.source), `SBDB GM (${sb.phys.GM.ref})`);
      meanRadiusKm[id] = S.planetPhys.dwarfPlanets.Ceres.meanRadiusKm;
      prov(id, 'radius', meanRadiusKm[id] * 1e3, src(S.planetPhys.source), 'JPL mean radius');
    } else {
      const r = satRow(c.satName);
      if (!r || r.gm === null || r.meanRadiusKm === null) throw new Error(`satellite physical parameters missing for ${c.satName}`);
      gmKm[id] = r.gm;
      meanRadiusKm[id] = r.meanRadiusKm;
      prov(id, 'mu', r.gm * 1e9, src(S.satPhys.source), `JPL satellite GM (${r.gmRef})`);
      prov(id, 'radius', r.meanRadiusKm * 1e3, src(S.satPhys.source), 'JPL satellite mean radius');
    }
  }
  for (const id of BODY_ORDER) {
    if (id === 'sun' || id === 'earth' || id === 'moon') continue;
    // JPL first: the planetary physical parameters for planets and dwarf planets, the Horizons object data
    // for satellites; the NASA NSSDC fact sheet where JPL lists none.
    const h = S.objdata.bodies[id];
    const c = CATALOGUE[id];
    if (c.kind === 'planet' || c.kind === 'dwarf') {
      const name = capital(id);
      const pp = c.kind === 'planet' ? S.planetPhys.planets[name] : S.planetPhys.dwarfPlanets[name];
      albedo[id] = pp.geometricAlbedo;
      prov(id, 'render.geometricAlbedo', albedo[id], src(S.planetPhys.source), `JPL planetary physical parameters (Horizons header: ${h.line ?? 'none'})`);
    } else if (h.geometricAlbedo !== null) {
      albedo[id] = h.geometricAlbedo;
      prov(id, 'render.geometricAlbedo', albedo[id], h.source, `JPL Horizons object data: ${h.line}`);
    } else {
      const n = S.nssdc.geometricAlbedo[id];
      if (!n) throw new Error(`no geometric albedo for ${id}`);
      albedo[id] = Number(n.value);
      prov(id, 'render.geometricAlbedo', albedo[id], src(n.source), 'NASA NSSDC fact sheet (the JPL Horizons header leaves it blank)');
    }
    if (!(albedo[id] > 0)) throw new Error(`bad albedo for ${id}`);
  }

  // ------------------------------------------------------------------------------------------- rotations
  const rotation = {};
  for (const id of BODY_ORDER) {
    if (id === 'earth' || id === 'moon') continue;
    const r = rot(id);
    rotation[id] = { mode: 'fixedRate', poleRaDeg: round(r.poleRaDeg, 12), poleDecDeg: round(r.poleDecDeg, 12), w0Deg: round(((r.wDeg % 360) + 360) % 360), rateDegPerDay: round(r.rateDegPerDay), epochUt: LOBBY_EPOCH_UT };
    prov(id, 'rotation', rotation[id], pckSrc, `pck00011 BODY${CATALOGUE[id].naif} pole and prime meridian (linear, quadratic and nutation-precession terms) evaluated at the lobby epoch ut ${LOBBY_EPOCH_UT}; rate = the mean rate W1 + 2 W2 d there`);
  }
  const poleOf = (id) => (id === 'earth' ? { raDeg: live.earth.json.rotation.poleRaDeg, decDeg: live.earth.json.rotation.poleDecDeg } : { raDeg: rotation[id].poleRaDeg, decDeg: rotation[id].poleDecDeg });

  // ---------------------------------------------------------------------------------------------- orbits
  const orbit = {};
  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (id === 'sun' || id === 'earth' || id === 'moon') continue;
    if (c.approxPos) {
      const t = S.approxPos.table1[c.approxPos];
      orbit[id] = approxPosOrbit(t, AU);
      paths[id] = { path: 'approx-pos', note: `JPL Table 1 row "${c.approxPos}"` };
      prov(id, 'orbit', 'JPL Table 1', src(S.approxPos.source), 'elements and rates of Table 1 (mean ecliptic and equinox of J2000); M = L - long.peri., argPe = long.peri. - node, mean motion = L rate - long.peri. rate');
    } else if (c.sbdb) {
      const sb = S.sbdb[c.sbdb];
      orbit[id] = sbdbOrbit(sb, AU);
      paths[id] = { path: 'sbdb', note: `${sb.object.fullname}, osculating at JD ${sb.epochJdTdb} TDB (${sb.orbitSource ?? 'JPL'} solution ${sb.solutionDate ?? ''})`.trim() };
      prov(id, 'orbit', `SBDB osculating elements at JD ${sb.epochJdTdb}`, src(sb.source), 'heliocentric ecliptic J2000 osculating elements and mean motion');
    } else {
      const row = S.satElem.rows[c.satName];
      let frame = satFrame(row, c.parent);
      if (frame === 'positive-pole-of-parent') {
        const p = poleOf(c.parent);
        frame = { pole: { raDeg: round((p.raDeg + 180) % 360, 12), decDeg: round(-p.decDeg, 12) } };
      }
      const ctx = { parentPole: poleOf(c.parent), muSum: (gmKm[c.parent] + gmKm[id]) * 1e9 };
      const cal = S.states.calibration[id].rows;
      const table = satelliteOrbit({ row, frame, path: 'sat-table', calibration: cal, ctx, muSum: ctx.muSum });
      let chosen = table.best;
      let path = 'sat-table';
      if (c.parent === 'saturn' && table.best.calibrationMaxDeg > 1) {
        const span = S.states.fitSpans[id];
        if (!span) throw new Error(`no Horizons fit span for ${id}`);
        const fit = satelliteOrbit({ row, frame, path: 'sat-fit', calibration: cal, fitSpan: span.rows, ctx, muSum: ctx.muSum });
        chosen = fit.best;
        path = 'sat-fit';
        paths[id] = { path, reading: readingName(chosen.reading), calibrationMaxDeg: round(chosen.calibrationMaxDeg, 4), tablePathCalibrationMaxDeg: round(table.best.calibrationMaxDeg, 4), fit: chosen.fit, ...(chosen.apsisDropped ? { apsisDropped: "the listed apsidal period is too short for a slowly precessing ellipse: periapsis held fixed (moves the position by at most e a)" } : {}) };
      } else {
        paths[id] = { path, reading: readingName(chosen.reading), calibrationMaxDeg: round(chosen.calibrationMaxDeg, 4) };
      }
      orbit[id] = chosen.def;
      const frameText = typeof frame === 'string' ? `${frame} (the parent's pole)` : `pole RA ${frame.pole.raDeg} Dec ${frame.pole.decDeg}`;
      prov(id, 'orbit', `JPL satellite mean elements (${row.ephemeris}), ${path}`, src(S.satElem.source), `${row.frame} frame -> ${frameText}; reading: ${readingName(chosen.reading)} (chosen over the calibration window 2010-2029 against Horizons, ${S.states.calibration[id].source.url})${path === 'sat-fit' ? `; inclination, node, periapsis and mean anomaly fitted at the lobby epoch to ${chosen.fit.samples} Horizons states (${S.states.fitSpans[id].source.url}), rms ${chosen.fit.rmsKm.toFixed(1)} km` : ''}`);
    }
    orbit[id] = roundDef(orbit[id]);
  }

  // ---------------------------------------------------------------------------------------- the bodies
  const earthLive = live.earth.json;
  const moonLive = live.moon.json;
  const sunLive = live.sun.json;
  const navAtm = earthLive.navballSwitchAltitude / earthLive.atmosphere.simTop;
  const navAirless = moonLive.navballSwitchAltitude / moonLive.radius;
  const soiAuto = (a, m, M, R) => Math.min(a * Math.cbrt(m / (3 * M)), Math.max(a * (m / M) ** 0.4, 2.5 * R));

  for (const id of BODY_ORDER) {
    const c = CATALOGUE[id];
    if (id === 'moon') {
      bodies.moon = { json: moonLive, text: live.moon.text };
      paths.moon = { path: 'frozen-v1', note: 'data/defs/bodies/moon.json copied byte for byte (ARCHITECTURE 8.2: the Moon keeps its frozen ellipse)' };
      radii.push(radiiRow(id, moonLive.radius, pck, c.naif));
      continue;
    }
    if (id === 'earth') {
      const a = 1.00014 * AU; // the mean distance of the Almanac formula (its R = 1.00014 - 0.01671 cos g - 0.00014 cos 2g AU)
      const soi = round(soiAuto(a, earthLive.mu, gmKm.sun * 1e9, earthLive.radius), 9);
      const json = { ...earthLive, parent: 'sun', soiRadius: soi, orbit: { kind: 'sunLowPrecision', inverted: true } };
      bodies.earth = { json };
      paths.earth = { path: 'sun-v1', note: 'the v1 Almanac low-precision Sun, inverted; every other field is data/defs/bodies/earth.json' };
      prov('earth', 'soiRadius', soi, null, 'min(Hill, max(a (m/M)^0.4, 2.5 R)) with a = 1.00014 au (the mean distance of the Almanac formula), m = the v1 Earth mu, M = the DE440 Sun GM; a number because the sunLowPrecision orbit has no semi-major axis for "auto"');
      radii.push(radiiRow(id, earthLive.radius, pck, c.naif));
      continue;
    }
    const R = meanRadiusKm[id] * 1e3;
    const mu = gmKm[id] * 1e9;
    const shape = shapeOf(pck, c.naif);
    const atmosphere = buildAtmosphere(id, S, { R, mu, prov: (f, v, s, n) => prov(id, f, v, s, n) });
    const def = {
      id,
      name: c.name,
      parent: c.parent,
      mu: round(mu),
      radius: round(R, 12),
      soiRadius: id === 'sun' ? null : 'auto',
      orbit: id === 'sun' ? null : orbit[id],
      rotation: rotation[id],
      gravityRole: 'attractor',
    };
    if (shape && id !== 'sun') {
      def.shape = shape;
      prov(id, 'shape', shape, pckSrc, `pck00011 BODY${c.naif}_RADII (a = b > c: an oblate spheroid)`);
    }
    if (c.surface === 'none' && id !== 'sun') def.surface = 'none';
    if (id === 'saturn') {
      def.rings = saturnRings(S);
      prov(id, 'rings', def.rings, src(S.nssdc.saturnRings.source), 'C ring inner edge to A ring outer edge (NSSDC Saturnian rings fact sheet); texture = the asset id of the ring strip that planet-bake stages; opticalDepthScale 1 (the strip carries the optical depth)');
    }
    def.emission = id === 'sun' ? sunLive.emission : null;
    def.atmosphere = atmosphere;
    def.ocean = null;
    const solidNew = c.surface === 'solid' && c.class !== null;
    def.terrain = solidNew ? { $ref: `../terrain/${id}.terrain.json` } : null;
    def.navballSwitchAltitude = id === 'sun' ? sunLive.navballSwitchAltitude : round(atmosphere ? atmosphere.simTop * navAtm : R * navAirless, 6);
    if (id !== 'sun') prov(id, 'navballSwitchAltitude', def.navballSwitchAltitude, null, atmosphere ? `simTop x ${earthLive.navballSwitchAltitude}/${earthLive.atmosphere.simTop} (the Earth precedent)` : `radius x ${moonLive.navballSwitchAltitude}/${moonLive.radius} (the Moon precedent)`);
    def.render = id === 'sun' ? sunLive.render : { meanColor: meanColorOf(id, S, albedo[id], (f, v, s, n) => prov(id, f, v, s, n)), geometricAlbedo: albedo[id], surface: null, atmosphere: null, clouds: null, ocean: null };
    bodies[id] = { json: def };
    if (solidNew) {
      terrain[id] = terrainSection(id, c, R, pck, bake, S.demRelief.bodies, moonLive.terrain.surfaceFriction, (f, v, s, n) => prov(id, f, v, s, n));
    }
    radii.push(radiiRow(id, R, pck, c.naif));
    if (id === 'sun') paths.sun = { path: 'root', note: 'root attractor; emission block of data/defs/bodies/sun.json' };
  }
  return { bodies, terrain, radii, provenance, paths };
}

function shapeOf(pck, naif) {
  const r = pck[`BODY${naif}_RADII`];
  if (!r) return null;
  const [a, b, cc] = r;
  if (a === b && cc < a) return { equatorialRadius: round(a * 1e3, 12), polarRadius: round(cc * 1e3, 12) };
  return null;
}

function radiiRow(id, meanM, pck, naif) {
  const r = pck[`BODY${naif}_RADII`].map((x) => round(x * 1e3, 12));
  return { id, meanRadius: round(meanM, 12), equatorialRadius: r[0], polarRadius: r[2], radiiAbc: r };
}

function saturnRings(S) {
  const rows = S.nssdc.saturnRings.rows;
  const get = (label) => {
    const r = rows.find((x) => x[0] === label);
    if (!r) throw new Error(`Saturn ring row "${label}" missing`);
    return Number(r[1].replace(/,/g, '')) * 1e3;
  };
  return [{ innerRadius: get('C inner edge'), outerRadius: get('A outer edge'), texture: 'saturn-rings', opticalDepthScale: 1 }];
}

/**
 * The terrain section of a new solid body. The amplification is planet-bake's (it defines the models and
 * bakes the large craters of the same population, so seed and parameters must be the ones its bake used):
 * the model key, seed and overrides of tools/bake/planet/bodies/<id>.json over the model's parameter file
 * data/defs/terrain/<model>.amplification.json (both read only). The elevation bounds enclose everything the
 * height function can return: the bake's reference surface (ellipsoid radii or a DEM's sphere) relative to the
 * mean radius, the DEM's published range, the bake's procedural craters (depth and rim of the largest), and the
 * run-time crater classes below the data level.
 */
function terrainSection(id, c, R, pck, bake, relief, friction, prov) {
  const level = Math.round(Math.log2((R * Math.PI) / 2 / DEEPEST_TILE_EDGE_M));
  const cfg = bake.configs[id];
  if (!cfg) throw new Error(`${id}: no planet-bake config tools/bake/planet/bodies/${id}.json (planet-bake defines the amplification of every new solid body)`);
  const a = cfg.amplification;
  if (a.model !== `${c.class}-generic`) throw new Error(`${id}: planet-bake config uses ${a.model}, the catalogue's surface class is ${c.class}`);
  const base = bake.models[a.model];
  if (!base) throw new Error(`${id}: no parameter file data/defs/terrain/${a.model}.amplification.json`);
  const unknown = Object.keys(a.params).filter((k) => !(k in base.params));
  if (unknown.length) throw new Error(`${id}: planet-bake overrides ${unknown.join(', ')} are not parameters of ${a.model}`);
  const amplification = { model: a.model, seed: a.seed, params: { ...base.params, ...a.params } };
  if (Math.abs(cfg.radii.mean - R) > 0.5) throw new Error(`${id}: planet-bake mean radius ${cfg.radii.mean} differs from the definition's ${R}`);

  // Elevation bounds (m, relative to the datum sphere R).
  const p = amplification.params;
  const h = cfg.height;
  const ref = h.reference;
  let lo;
  let hi;
  const parts = [];
  if (ref === 'ellipsoid') {
    const r = pck[`BODY${c.naif}_RADII`].map((x) => x * 1e3);
    lo = Math.min(...r) - R;
    hi = Math.max(...r) - R;
    parts.push(`ellipsoid ${lo.toFixed(0)}..${hi.toFixed(0)} m`);
  } else {
    lo = hi = ref.sphere - R;
    parts.push(`DEM sphere ${ref.sphere} m (${lo.toFixed(0)} m)`);
  }
  if (h.dem) {
    const d = relief[id];
    if (!d) throw new Error(`${id}: the bake has a DEM but tools/bodies/sources/dem-relief.json has no range for it`);
    lo += d.min * h.dem.scale + h.dem.offset;
    hi += d.max * h.dem.scale + h.dem.offset;
    parts.push(`DEM ${d.min}..${d.max} (x ${h.dem.scale} + ${h.dem.offset})`);
  }
  if (h.craters) {
    const D = h.craters.maxDiameterRadii * R;
    lo -= p.freshDepthToDiameter * D;
    hi += p.rimHeightToDiameter * D;
    parts.push(`procedural craters to ${(D / 1e3).toFixed(1)} km (depth ${p.freshDepthToDiameter} D, rim ${p.rimHeightToDiameter} D)`);
  }
  const posting = (R * Math.PI) / 2 / (256 * 2 ** h.maxLevel);
  const Dr = p.craterMaxDiameterInPostings * posting;
  lo -= p.freshDepthToDiameter * Dr;
  hi += p.rimHeightToDiameter * Dr;
  parts.push(`run-time craters to ${Dr.toFixed(0)} m`);

  const def = {
    tileset: id,
    maxElevation: Math.ceil(hi),
    minElevation: Math.floor(lo),
    maxRenderLevel: level,
    modifiers: [],
    surfaceFriction: friction,
    amplification,
  };
  prov('terrain.maxRenderLevel', level, null, `round(log2(R pi/2 / ${DEEPEST_TILE_EDGE_M} m)): the deepest tile edge of the Earth (level 20) and Moon (level 18) precedent`);
  prov('terrain.elevation', [def.minElevation, def.maxElevation], h.dem ? relief[id].source : null, parts.join('; '));
  prov('terrain.amplification', `${a.model} seed ${a.seed} overrides ${JSON.stringify(a.params)}`, null, `planet-bake: tools/bake/planet/bodies/${id}.json over data/defs/terrain/${a.model}.amplification.json`);
  prov('terrain.surfaceFriction', friction, null, "the Moon's (data/defs/bodies/moon.json): regolith-covered surfaces");
  return def;
}


function meanColorOf(id, S, albedo, prov) {
  const col = S.colours.bodies[id];
  if (!col) throw new Error(`no colour indices for ${id} in tools/bodies/sources/colours.json`);
  const value = meanColourFromIndices(col, S.colours.sun, albedo);
  prov('render.meanColor', value, col.source, `B-V ${col.bv}, ${col.vr === null ? 'red from the B-V slope' : `V-R ${col.vr}`} (${col.note}); Sun B-V ${S.colours.sun.bv}, V-R ${S.colours.sun.vr}; luminance scaled to the geometric albedo ${albedo} (tools/bodies/lib/colour.mjs)`);
  return value;
}
