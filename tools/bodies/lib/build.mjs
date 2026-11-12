// Builds the staged library: one BodyDef per body of ARCHITECTURE 8.1, the terrain section of each new solid
// body, the radii table, and the provenance of every generated number. Pure function of the source tables
// (tools/bodies/sources) and the live v1 Earth / Moon / Sun files; no network, no clock.
import { CATALOGUE, BODY_ORDER } from './catalogue.mjs';
import { AU_M } from './kepler.mjs';
import { LOBBY_EPOCH_UT, round } from './orbits.mjs';
import { pckRotation } from './pck.mjs';
import { buildAtmosphere } from './atmospheres.mjs';
import { meanColourFromIndices } from './colour.mjs';

const capital = (s) => s[0].toUpperCase() + s.slice(1);
/** Geometric albedos taken from the NSSDC sheet instead of JPL's table, with the reason. */
const ALBEDO_FROM_NSSDC = {
  pluto: "NASA NSSDC Pluto fact sheet (0.52): JPL's dwarf-planet table lists 0.3, a pre-New Horizons value that would draw Pluto darker than Charon (0.42 on the same NSSDC sheet)",
};
const src = (s) => ({ url: s.url, retrievedAt: s.retrievedAt });

/** Tile edge of the deepest render level, metres: the Earth (level 20) and Moon (level 18) precedent. */
const DEEPEST_TILE_EDGE_M = 10;
/** BodyTerrainDef.residentLevel of a generated body (the contract's rule, request bodies-ephemeris-3). */
const RESIDENT_LEVEL = 3;

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
    if (ALBEDO_FROM_NSSDC[id]) {
      albedo[id] = Number(S.nssdc.geometricAlbedo[id].value);
      prov(id, 'render.geometricAlbedo', albedo[id], src(S.nssdc.geometricAlbedo[id].source), ALBEDO_FROM_NSSDC[id]);
    } else if (c.kind === 'planet' || c.kind === 'dwarf') {
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
    const sync = S.orbitFits.bodies[id]?.rotation;
    if (sync) {
      // A synchronous satellite (fit-orbits.mjs synchronousRotation): W0 and rate keep its face to the parent on
      // the fitted orbit; the pole stays the full model's at the epoch.
      rotation[id] = { ...rotation[id], w0Deg: round(sync.w0Deg), rateDegPerDay: round(sync.rateDegPerDay) };
      prov(id, 'rotation', rotation[id], pckSrc, `synchronous: pole of pck00011 BODY${CATALOGUE[id].naif} at the lobby epoch; prime meridian by ${sync.method} (sub-parent longitude within ${sync.maxSubParentErrorDeg.toFixed(2)} deg of Horizons + the full pck model over the window; the other candidate ${sync.otherCandidate.maxSubParentErrorDeg.toFixed(2)} deg)`);
    } else {
      prov(id, 'rotation', rotation[id], pckSrc, `pck00011 BODY${CATALOGUE[id].naif} pole and prime meridian (linear, quadratic and nutation-precession terms) evaluated at the lobby epoch ut ${LOBBY_EPOCH_UT}; rate = the mean rate W1 + 2 W2 d there`);
    }
  }

  // ---------------------------------------------------------------------------------------------- orbits
  // The lead's decision on request bodies-ephemeris-4: every orbit but Earth's and the Moon's is the precessing
  // ellipse fitted to Horizons over the validity window (tools/bodies/fit-orbits.mjs); the published tables are
  // its starting values and provenance.
  const orbit = {};
  for (const id of BODY_ORDER) {
    if (id === 'sun' || id === 'earth' || id === 'moon') continue;
    const f = S.orbitFits.bodies[id];
    if (!f) throw new Error(`${id}: no fitted orbit in tools/bodies/sources/orbit-fits.json (run node tools/bodies/fit-orbits.mjs)`);
    orbit[id] = f.def;
    paths[id] = { path: 'fit', startFrom: f.startFrom, ratesFitted: f.ratesFitted, residual: { maxAngleDeg: round(f.residual.maxAngleDeg, 4), maxRadial: round(f.residual.maxRadial, 4), rmsAngleDeg: round(f.residual.rmsAngleDeg, 4), samples: f.residual.samples } };
    prov(id, 'orbit', 'fitted to JPL Horizons over 2029-09-01..2060-01-01', f.horizons.map((h) => ({ url: h.url, retrievedAt: h.retrievedAt })), `precessing ellipse (a, e, i, node, argPe, M at the lobby epoch, mean motion${f.ratesFitted ? ', node and apsis rates' : "; the starting values' node and apsis rates"}) fitted to ${f.residual.samples} window states${f.horizons.length > 1 ? ' and a dense span about the epoch' : ''}; started from ${f.startFrom}`);
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

  // Elevation bounds (m, relative to the datum sphere R). Once planet-bake has baked the body, its manifest's
  // recorded height range is the basis; before that, the bake's inputs bound what it can produce.
  const p = amplification.params;
  const h = cfg.height;
  const ref = h.reference;
  let lo;
  let hi;
  const parts = [];
  const baked = bake.manifests[id]?.layers?.height?.elevation;
  if (baked) {
    lo = baked.min;
    hi = baked.max;
    parts.push(`the baked height range of data/tiles/${id}/manifest.json (${lo}..${hi} m)`);
  } else if (ref === 'ellipsoid') {
    const r = pck[`BODY${c.naif}_RADII`].map((x) => x * 1e3);
    lo = Math.min(...r) - R;
    hi = Math.max(...r) - R;
    parts.push(`ellipsoid ${lo.toFixed(0)}..${hi.toFixed(0)} m`);
  } else {
    lo = hi = ref.sphere - R;
    parts.push(`DEM sphere ${ref.sphere} m (${lo.toFixed(0)} m)`);
  }
  if (h.dem && !baked) {
    const d = relief[id];
    if (!d) throw new Error(`${id}: the bake has a DEM but tools/bodies/sources/dem-relief.json has no range for it`);
    lo += d.min * h.dem.scale + h.dem.offset;
    hi += d.max * h.dem.scale + h.dem.offset;
    parts.push(`DEM ${d.min}..${d.max} (x ${h.dem.scale} + ${h.dem.offset})`);
  }
  if (h.craters && !baked) {
    // the bake's crater population uses the same depth-to-diameter ratio at every size (src/terrain/craters.ts),
    // so its largest craters are that deep; request bodies-ephemeris-5 asks planet-bake about complex craters
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
  if (!baked && !h.dem && !h.craters) parts.push('no DEM and no baked craters: the ellipsoid and the run-time craters only');

  const def = {
    tileset: id,
    maxElevation: Math.ceil(hi),
    minElevation: Math.floor(lo),
    maxRenderLevel: level,
    residentLevel: Math.min(RESIDENT_LEVEL, h.maxLevel),
    modifiers: [],
    surfaceFriction: friction,
    amplification,
  };
  prov('terrain.maxRenderLevel', level, null, `round(log2(R pi/2 / ${DEEPEST_TILE_EDGE_M} m)): the deepest tile edge of the Earth (level 20) and Moon (level 18) precedent`);
  prov('terrain.elevation', [def.minElevation, def.maxElevation], !baked && h.dem ? relief[id].source : null, parts.join('; '));
  prov('terrain.amplification', `${a.model} seed ${a.seed} overrides ${JSON.stringify(a.params)}`, null, `planet-bake: tools/bake/planet/bodies/${id}.json over data/defs/terrain/${a.model}.amplification.json`);
  prov('terrain.residentLevel', def.residentLevel, null, `min(${RESIDENT_LEVEL}, the pyramid's depth ${h.maxLevel}): the contract's rule for generated bodies (BodyTerrainDef.residentLevel, request bodies-ephemeris-3)`);
  prov('terrain.surfaceFriction', friction, null, "the Moon's (data/defs/bodies/moon.json): regolith-covered surfaces");
  return def;
}


function meanColorOf(id, S, albedo, prov) {
  const col = S.colours.bodies[id];
  if (!col) throw new Error(`no colour indices for ${id} in tools/bodies/sources/colours.json`);
  const value = meanColourFromIndices(col, S.colours.sun, albedo);
  prov('render.meanColor', value, col.source, col.linearRgb ? `${col.note}; luminance scaled to the geometric albedo ${albedo}` : `B-V ${col.bv}, ${col.vr === null ? 'red from the B-V slope' : `V-R ${col.vr}`} (${col.note}); Sun B-V ${S.colours.sun.bv}, V-R ${S.colours.sun.vr}; luminance scaled to the geometric albedo ${albedo} (tools/bodies/lib/colour.mjs)`);
  return value;
}
