// Atmosphere tables (AtmosphereDef model 'table') from measured or reference profiles.
//
// Titan: Huygens HASI level-4 profiles (Fulchignoni et al. 2005, Nature 438; PDS data set
// HP-SSA-HASI-2-3-4-MISSION-V1.1, hphasi_0001), entry (1,380 to 157 km: pressure and temperature) and descent
// (147 km to the surface: pressure, temperature, density). The entry file has no density: it is p M / (R T)
// with the molar mass M the descent file itself implies over its top 10 km (mean of rho R T / p there).
// Each table row is a local least-squares line through the samples within a window about the row's altitude
// (log pressure, log density and temperature against altitude), evaluated AT the row's altitude, so a row at the
// edge of the data (the surface) is not biased by a one-sided average; windows +-0.5 km below 150 km and +-5 km
// in the noisier entry part.
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
    const at = (f) => {
      const n = win.length;
      const xs = win.map((r) => r.hKm - h);
      const ys = win.map(f);
      const mx = xs.reduce((a, b) => a + b, 0) / n;
      const my = ys.reduce((a, b) => a + b, 0) / n;
      const sxx = xs.reduce((a, x) => a + (x - mx) ** 2, 0);
      if (n < 3 || sxx === 0) return my;
      const slope = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0) / sxx;
      return my - slope * mx;
    };
    out.push({ hKm: h, rho: Number(Math.exp(at((r) => Math.log(r.rho))).toPrecision(5)), p: Number(Math.exp(at((r) => Math.log(r.p))).toPrecision(5)), T: Number(at((r) => r.T).toFixed(2)), samples: win.length });
  }
  return { rows: out, molarMassKgPerMol: molarMass, descentRows: descent.length, entryRows: entry.length };
}
