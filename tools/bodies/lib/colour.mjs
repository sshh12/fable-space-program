// Mean colour of a body's lit disc (BodyRenderDef.meanColor, linear sRGB albedo) from its broadband colour
// indices and its geometric albedo:
//   reflectance relative to V:  R_B / R_V = 10^(-0.4 ((B-V) - (B-V)sun)),  R_R / R_V = 10^(0.4 ((V-R) - (V-R)sun))
//   where only B-V is known, the reflectance is taken as linear in wavelength through B (440 nm) and V (550 nm)
//   and continued to R (Cousins, 640 nm): R_R / R_V = 1 + (1 - R_B / R_V) (640 - 550) / (550 - 440);
//   linear sRGB ~ (R_R, R_V, R_B) (the R, V and B bands stand for the red, green and blue primaries), scaled so
//   that its luminance (Rec. 709 weights) equals the geometric albedo (a V-band quantity).
// The v1 Moon (meanColor luminance 0.127, geometric albedo 0.12) is the precedent for luminance ~ albedo.

export const LUMA = [0.2126, 0.7152, 0.0722];
const BAND_NM = { B: 440, V: 550, R: 640 };

export function meanColourFromIndices({ bv, vr, linearRgb }, sun, albedo) {
  if (linearRgb) {
    // a measured mean colour (a global colour map): keep its chromaticity, luminance = the geometric albedo
    const y0 = linearRgb[0] * LUMA[0] + linearRgb[1] * LUMA[1] + linearRgb[2] * LUMA[2];
    return linearRgb.map((x) => Number(((x * albedo) / y0).toPrecision(4)));
  }
  const b = 10 ** (-0.4 * (bv - sun.bv));
  const r = vr === null || vr === undefined ? 1 + (1 - b) * ((BAND_NM.R - BAND_NM.V) / (BAND_NM.V - BAND_NM.B)) : 10 ** (0.4 * (vr - sun.vr));
  const rgb = [r, 1, b];
  const y = rgb[0] * LUMA[0] + rgb[1] * LUMA[1] + rgb[2] * LUMA[2];
  return rgb.map((x) => Number(((x * albedo) / y).toPrecision(4)));
}
