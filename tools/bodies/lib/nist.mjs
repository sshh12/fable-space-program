// Ratio of specific heats of an atmosphere from the NIST Chemistry WebBook fluid tables (Thermophysical
// Properties of Fluid Systems): each listed gas at the reference temperature and at its partial pressure, the
// mixture taken as ideal: gamma = sum(x cp) / sum(x cv), molar heat capacities, mole fractions renormalised over
// the listed gases. A temperature below the lower limit of a fluid's equation of state is raised to that limit
// (recorded in the result).
import { fetchCached } from './http.mjs';

export const NIST_IDS = { CO2: 'C124389', N2: 'C7727379', Ar: 'C7440371', H2: 'C1333740', He: 'C7440597', CH4: 'C74828' };
/** Lower temperature limits of the WebBook's equations of state (triple points), K. */
export const NIST_TMIN = { CO2: 216.592, N2: 63.151, Ar: 83.806, H2: 13.957, He: 2.1768, CH4: 90.6941 };

export function nistUrl(gas, T, pMPa) {
  const q = new URLSearchParams({ Action: 'Load', ID: NIST_IDS[gas], Type: 'IsoTherm', Digits: '6', PLow: String(pMPa), PHigh: String(pMPa), PInc: '0.01', T: String(T), RefState: 'DEF', TUnit: 'K', PUnit: 'MPa', DUnit: 'mol/l', HUnit: 'kJ/mol', WUnit: 'm/s', VisUnit: 'uPa*s', STUnit: 'N/m' });
  return `https://webbook.nist.gov/cgi/fluid.cgi?${q.toString()}`;
}

/** cp and cv (J/(mol K)) of one gas; throws unless the WebBook reports the vapour phase. */
export async function nistHeatCapacities(gas, T, pMPa) {
  const url = nistUrl(gas, T, pMPa);
  const name = `${gas}-${T}K-${pMPa}MPa.html`.replace(/[^A-Za-z0-9._-]/g, '_');
  const r = await fetchCached('nist-fluid', name, url);
  const t = r.text.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
  const head = t.indexOf('Temperature (K) Pressure (MPa)');
  if (head < 0) throw new Error(`NIST ${gas} ${T} K ${pMPa} MPa: no property table (${t.slice(0, 200)})`);
  const cols = ['Temperature (K)', 'Pressure (MPa)', 'Density (mol/l)', 'Volume (l/mol)', 'Internal Energy (kJ/mol)', 'Enthalpy (kJ/mol)', 'Entropy (J/mol*K)', 'Cv (J/mol*K)', 'Cp (J/mol*K)'];
  for (const c of cols) if (!t.includes(c)) throw new Error(`NIST ${gas}: column "${c}" missing`);
  const after = t.slice(head).split('Phase ')[1].trim().split(' ');
  const v = after.slice(0, 9).map(Number);
  const phase = after.slice(13).find((x) => /^[a-z]+$/.test(x));
  if (!v.every(Number.isFinite)) throw new Error(`NIST ${gas}: unreadable row`);
  if (phase !== 'vapor' && phase !== 'supercritical') throw new Error(`NIST ${gas} at ${T} K, ${pMPa} MPa is ${phase}`);
  return { gas, T: v[0], pMPa: v[1], cv: v[7], cp: v[8], phase, source: { url: r.meta.url, retrievedAt: r.meta.retrievedAt } };
}

/** gamma of an ideal mixture of `composition` (mole fractions) at T (K) and total pressure p (Pa). */
export async function mixtureGamma(composition, T, pPa) {
  const gases = Object.entries(composition).filter(([g]) => g in NIST_IDS);
  const total = gases.reduce((s, [, x]) => s + x, 0);
  const parts = [];
  for (const [g, x] of gases) {
    const Tg = Math.max(T, Math.ceil(NIST_TMIN[g] * 10) / 10);
    const pMPa = Number(((x / total) * pPa * 1e-6).toPrecision(4));
    parts.push({ x: x / total, ...(await nistHeatCapacities(g, Tg, pMPa)) });
  }
  const cp = parts.reduce((s, p) => s + p.x * p.cp, 0);
  const cv = parts.reduce((s, p) => s + p.x * p.cv, 0);
  return { value: cp / cv, cp, cv, T, pPa, parts };
}
