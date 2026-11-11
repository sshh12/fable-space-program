/**
 * Bake of the planet-fixed roughness field of brdf_water (WATER_FIELD_WGSL) into an r16float texture over the
 * near field, for the forward pass: evaluated per pixel there it cost 0.15 ms at 1440p, the texture costs one
 * bilinear sample. A fullscreen pass over the texture (core fullscreenPipeline, group 0 = frame): texel uv maps
 * to the plane offset centre + (uv - 0.5) x extent from this frame's reference point, and that point's
 * body-fixed position is R cHat + oceanSphereOffset(plane), the same chart the surface is drawn on. The field
 * varies over 1-90 km; at 1024 texels over 80 km the bilinear error is below 0.5 % of its slick contrast.
 */
import { WATER_FIELD_WGSL } from './waterBrdf';

export const FIELD_SIZE = 1024;

export const FIELD_BAKE_WGSL = /* wgsl */ `
struct OceanFieldBake {
  area: vec4f,   // xy = plane offset of the texture centre from the reference point (m), z = extent (m)
  body: vec4f,   // the body's brdf_water row: (foam albedo, wind direction (rad), variability, slick strength)
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
  let p = oceanU.cHat.xyz * oceanU.cHat.w + oceanSphereOffset(plane);
  return vec4f(waterRoughnessFieldFixed(p, bake.body), 0.0, 0.0, 1.0);
}
`;
