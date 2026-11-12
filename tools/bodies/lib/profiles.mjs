// Atmosphere tables (AtmosphereDef model 'table') from measured or reference profiles.
//
// Titan: Huygens HASI level-4 profiles (Fulchignoni et al. 2005, Nature 438; PDS data set
// HP-SSA-HASI-2-3-4-MISSION-V1.1, hphasi_0001), entry (1,380 to 157 km: pressure and temperature) and descent
// (147 km to the surface: pressure, temperature, density). The entry file has no density: it is p M / (R T)
// with the molar mass M the descent file itself implies over its top 10 km (mean of rho R T / p there).
// Each table row is the average of the samples within a window about the row's altitude (log-average of
// pressure and density, mean temperature), the windows narrow below 150 km and wider in the noisier entry part.
import { R_UNIVERSAL } from './atmospheres.mjs';

export const TITAN_ROWS_KM = [0, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120, 130, 140, 150, 160, 180, 200, 225, 250, 300, 350, 400, 450, 500, 550, 600, 650, 700, 800, 900, 1000, 1100, 1200, 1300];

export function parseHasi(text, { withDensity }) {
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const f = line.split(';').map((s) => s.trim());
    const alt = Number(f[1]);
    const p = Number(f[2]);
    const T = Number(f[3]);
    const rho = withDensity ? Number(f[4]) : NaN;
    if (![alt, p, T].every(Number.isFinite) || (withDensity && !Number.isFinite(rho))) throw new Error(`HASI: bad row "${line}"`);
    rows.push({ hKm: alt / 1000, p, T, rho });
  }
  return rows;
}

export function titanTable(entryText, descentText) {
  const descent = parseHasi(descentText, { withDensity: true });
  const entry = parseHasi(entryText, { withDensity: false });
  const topD = Math.max(...descent.map((r) => r.hKm));
  const top = descent.filter((r) => r.hKm > topD - 10);
  const molarMass = top.reduce((s, r) => s + (r.rho * R_UNIVERSAL * r.T) / r.p, 0) / top.length;
  for (const r of entry) r.rho = (r.p * molarMass) / (R_UNIVERSAL * r.T);
  const all = [...descent, ...entry].sort((a, b) => a.hKm - b.hKm);
  const out = [];
  for (const h of TITAN_ROWS_KM) {
    const w = h < 150 ? 0.5 : 5;
    let win = all.filter((r) => Math.abs(r.hKm - h) <= w);
    if (win.length === 0) {
      const below = all.filter((r) => r.hKm < h).pop();
      const above = all.find((r) => r.hKm > h);
      if (!below || !above) throw new Error(`Titan table: no data about ${h} km`);
      const t = (h - below.hKm) / (above.hKm - below.hKm);
      const lg = (a, b) => Math.exp(Math.log(a) + t * (Math.log(b) - Math.log(a)));
      win = [{ hKm: h, p: lg(below.p, above.p), rho: lg(below.rho, above.rho), T: below.T + t * (above.T - below.T) }];
    }
    const mlog = (k) => Math.exp(win.reduce((s, r) => s + Math.log(r[k]), 0) / win.length);
    out.push({ hKm: h, rho: Number(mlog('rho').toPrecision(5)), p: Number(mlog('p').toPrecision(5)), T: Number((win.reduce((s, r) => s + r.T, 0) / win.length).toFixed(2)), samples: win.length });
  }
  return { rows: out, molarMassKgPerMol: molarMass, descentRows: descent.length, entryRows: entry.length };
}
