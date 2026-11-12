// Physical atmospheres of the staged bodies (AtmosphereDef), from tools/bodies/sources/atmospheres.json:
//
//   exponential  Mars (surface values) and the four giants (1-bar values): rho0, p0, scale height and
//                temperature of the NASA NSSDC fact sheets; gas constant = R / mean molecular weight.
//   table        Venus and Titan: altitude, density, pressure, temperature rows of the cited profiles.
//   gamma        cp / cv of the ideal mixture of the listed composition at the reference temperature, from the
//                pure-gas cp and cv of the NIST Chemistry WebBook fluid tables (sources file, per gas).
//   simTop       the altitude where the model density falls to Earth's density at its own simTop (the v1
//                rails boundary: USSA-76 at 140 km, 3.831e-9 kg/m^3 in src/sim/bodies/atmosphere.ts).
//   floorAltitude  (giants, surface 'none') the 10-bar level of the exponential model: -H ln 10.
//   heating      the Sutton-Graves constant and the radiative set of the body's gas class (sources file).
import { round } from './orbits.mjs';

/** Earth's density at its v1 simTop (USSA-76, 140 km), kg/m^3; tests/unit/bodies pins it to the runtime model. */
export const EARTH_SIMTOP_DENSITY = 3.831e-9;
export const R_UNIVERSAL = 8.314462618;

const src = (s) => ({ url: s.url, retrievedAt: s.retrievedAt });

/** Altitude (m) where a log-linear table's density reaches `rho` (end segments extrapolated). */
export function tableAltitudeAtDensity(rows, rho) {
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1];
    const b = rows[i];
    if (b.rho <= rho || i === rows.length - 1) {
      const t = Math.log(rho / a.rho) / Math.log(b.rho / a.rho);
      return (a.hKm + t * (b.hKm - a.hKm)) * 1000;
    }
  }
  throw new Error('table too short');
}

export function buildAtmosphere(id, S, { prov }) {
  const A = S.atmospheres.bodies[id];
  if (!A) return null;
  const heating = S.atmospheres.heating[id];
  if (!heating) throw new Error(`${id}: no heating set`);
  const gasConstant = R_UNIVERSAL / (A.meanMolecularWeight / 1000);
  let def;
  if (A.model === 'exponential') {
    const H = A.scaleHeightKm * 1000;
    const simTop = H * Math.log(A.rho0 / EARTH_SIMTOP_DENSITY);
    def = { model: 'exponential', rho0: A.rho0, p0: A.p0, scaleHeight: round(H, 9), temperature: A.temperature, simTop: Math.round(simTop) };
    if (A.floor) def.floorAltitude = round(-H * Math.log(A.floor.pressureRatio), 6);
    prov('atmosphere', { rho0: A.rho0, p0: A.p0, scaleHeightKm: A.scaleHeightKm, temperature: A.temperature }, A.source, A.note);
    prov('atmosphere.simTop', def.simTop, null, `H ln(rho0 / ${EARTH_SIMTOP_DENSITY}): where the model density falls to Earth's density at its simTop (USSA-76, 140 km)`);
    if (A.floor) prov('atmosphere.floorAltitude', def.floorAltitude, null, `the ${A.floor.pressureRatio}-bar level of the exponential model, -H ln ${A.floor.pressureRatio} (ARCHITECTURE 8.3: about the 10 bar level)`);
  } else {
    const rows = A.rows.map((r) => ({ hKm: r.hKm, rho: r.rho, p: r.p, T: r.T }));
    const simTop = tableAltitudeAtDensity(rows, EARTH_SIMTOP_DENSITY);
    def = { model: 'table', table: rows, simTop: Math.round(simTop) };
    prov('atmosphere', `${rows.length} rows, ${rows[0].hKm}-${rows[rows.length - 1].hKm} km`, A.source, A.note);
    prov('atmosphere.simTop', def.simTop, null, `altitude where the table density (log-linear) falls to ${EARTH_SIMTOP_DENSITY} kg/m^3, Earth's density at its simTop`);
  }
  def.gamma = round(A.gamma.value, 6);
  def.gasConstant = round(gasConstant, 9);
  def.heating = heating.set;
  prov('atmosphere.gamma', def.gamma, A.gamma.source ?? null, A.gamma.note);
  prov('atmosphere.gasConstant', def.gasConstant, A.source, `${R_UNIVERSAL} / mean molecular weight ${A.meanMolecularWeight} g/mol`);
  prov('atmosphere.heating', heating.set, heating.source ? src(heating.source) : null, heating.note);
  return def;
}
