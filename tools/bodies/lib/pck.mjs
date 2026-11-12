// IAU rotation models from the NAIF text PCK (pck00011, tools/bodies/sources/naif-pck00011.json), evaluated as
// SPICE does (Archinal et al. 2018):
//   theta_i = A_i + B_i T (+ C_i T^2 when BODYn_MAX_PHASE_DEGREE = 2), T = Julian centuries of TDB from J2000
//   RA  = RA0 + RA1 T + RA2 T^2 + sum a_i sin theta_i
//   DEC = DEC0 + DEC1 T + DEC2 T^2 + sum d_i cos theta_i
//   W   = W0 + W1 d + W2 d^2 + sum w_i sin theta_i,   d = days of TDB from J2000
// The body contract has a fixed pole and a uniform prime-meridian rate (RotationDef 'fixedRate'), so the
// generator evaluates the full model at one epoch and keeps the mean rate W1 + 2 W2 d there. `ut` is the game's
// clock (seconds since J2000 treated as UTC); the model is evaluated at the TDB instant (kepler.mjs utToJd).
import { JD_J2000, utToJd } from './kepler.mjs';

export function pckRotation(vars, naif) {
  const get = (k) => vars[`BODY${naif}_${k}`];
  const ra = get('POLE_RA');
  const dec = get('POLE_DEC');
  const pm = get('PM');
  if (!ra || !dec || !pm) throw new Error(`pck: no rotation model for body ${naif}`);
  const system = naif >= 100 && naif < 1000 ? Math.floor(naif / 100) : null;
  const degree = system !== null && vars[`BODY${system}_MAX_PHASE_DEGREE`] ? vars[`BODY${system}_MAX_PHASE_DEGREE`][0] : 1;
  const anglesFlat = system !== null ? vars[`BODY${system}_NUT_PREC_ANGLES`] ?? [] : [];
  const stride = degree + 1;
  const angles = [];
  for (let i = 0; i + stride <= anglesFlat.length; i += stride) angles.push(anglesFlat.slice(i, i + stride));
  const nRa = get('NUT_PREC_RA') ?? [];
  const nDec = get('NUT_PREC_DEC') ?? [];
  const nPm = get('NUT_PREC_PM') ?? [];
  for (const [arr, what] of [[nRa, 'RA'], [nDec, 'DEC'], [nPm, 'PM']]) {
    if (arr.length > angles.length) throw new Error(`pck: BODY${naif}_NUT_PREC_${what} has ${arr.length} terms, system has ${angles.length} angles`);
  }
  const poly = (c, x) => c.reduce((s, v, k) => s + v * x ** k, 0);
  return {
    naif,
    /** Pole (deg) and prime meridian (deg) at `ut` seconds of TDB from J2000, with the mean rate (deg/day). */
    at(ut) {
      const d = utToJd(ut) - JD_J2000;
      const T = d / 36525;
      const theta = angles.map((c) => (poly(c, T) * Math.PI) / 180);
      const sum = (coef, f) => coef.reduce((s, v, i) => s + v * f(theta[i]), 0);
      const poleRaDeg = poly(ra, T) + sum(nRa, Math.sin);
      const poleDecDeg = poly(dec, T) + sum(nDec, Math.cos);
      const W = poly(pm, d) + sum(nPm, Math.sin);
      const rateDegPerDay = (pm[1] ?? 0) + 2 * (pm[2] ?? 0) * d;
      return { poleRaDeg, poleDecDeg, wDeg: W, rateDegPerDay };
    },
  };
}
