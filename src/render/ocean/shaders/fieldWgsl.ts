/**
 * Bake of the planet-fixed roughness field of brdf_water (WATER_FIELD_WGSL) into an r16float texture over the
 * near field, for the forward pass: evaluated per pixel there it cost 0.15 ms at 1440p, the texture costs one
 * filtered sample. A fullscreen pass over the texture (core fullscreenPipeline, group 0 = frame): texel uv maps
 * to the plane offset centre + (uv - 0.5) x extent from this frame's reference point, and that point's wind-chart
 * position is formed from the reference point (the chart's origin) and oceanSphereOffset(plane) (the precise
 * offset), the same split the deferred path makes from the camera. Evaluated with the texel as footprint (37 m at
 * 2048 texels over 75 km), then box-filtered into a mip chain, which the forward pass samples anisotropically with
 * the pixel's footprint.
 */
import { WATER_FIELD_WGSL } from './waterBrdf';

export const FIELD_SIZE = 2048;
export const FIELD_MIPS = 10;

export const FIELD_BAKE_WGSL = /* wgsl */ `
struct OceanFieldBake {
  area: vec4f,   // xy = plane offset of the texture centre from the reference point (m), z = extent (m), w = texel (m)
  wind: vec4f,   // xy = sin / cos of the compass direction the wind blows toward, z = 1 / mean of the raw field
  q: vec4f,      // wind variability, slick strength, gust variability, filament strength
}
@group(1) @binding(0) var<uniform> oceanU: OceanUniforms;
@group(1) @binding(1) var<uniform> bake: OceanFieldBake;
// Declared for the shared chunk; this pass does not read them.
@group(1) @binding(2) var oceanDisp: texture_2d_array<f32>;
@group(1) @binding(3) var oceanDispPrev: texture_2d_array<f32>;
#include "ocean_waves"
${WATER_FIELD_WGSL}

@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let plane = bake.area.xy + (in.uv - 0.5) * bake.area.z;
  let c = oceanU.cHat.xyz * oceanU.cHat.w;
  let dlt = oceanSphereOffset(plane);
  let ch = waterChartOf(c, dlt, oceanU.cHat.w, bake.wind.xy, 0.0);
  return vec4f(waterField(ch, c, dlt, oceanU.cHat.w, bake.wind.xy, bake.q, bake.wind.z, bake.area.w), 0.0, 0.0, 1.0);
}
`;

/** One mip level of the baked field: the 2 x 2 box mean of the level above. */
export const FIELD_MIP_WGSL = /* wgsl */ `
@group(1) @binding(0) var src: texture_2d<f32>;
@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {
  let p = vec2i(in.position.xy) * 2;
  let v = textureLoad(src, p, 0).r + textureLoad(src, p + vec2i(1, 0), 0).r + textureLoad(src, p + vec2i(0, 1), 0).r + textureLoad(src, p + vec2i(1, 1), 0).r;
  return vec4f(v * 0.25, 0.0, 0.0, 1.0);
}
`;
