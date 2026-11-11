/**
 * The uniform block shared by every pass of the atmosphere feature (group 1, binding 0). One table of
 * fields generates both the WGSL struct and the offsets used to fill it, so the two cannot drift apart.
 * Every field is a vec4 (16 bytes).
 */

type FieldType = 'vec4f' | 'vec4i';

const FIELDS = [
  // x, y = frame body index of the (up to) two atmosphere bodies that are marched, nearest first (-1 = none);
  // z = frame body index of the body whose clouds are drawn (-1 = none); w = body of the sky-view table (-1 = none)
  ['bodies', 'vec4i', 'atmosphere bodies 0 / 1, cloud body, sky-view body (frame body indices, -1 = none)'],
  // x, y = table layer of atmosphere bodies 0 / 1; z = number of table layers; w = checkerboard phase 0..3
  ['layers', 'vec4i', 'table layers of bodies 0 / 1, layer count, cloud checkerboard phase'],
  ['lutBody', 'vec4i', 'frame body index of each table layer'],
  ['steps', 'vec4f', 'march samples of bodies 0 / 1, sky-view samples, cloud primary step budget'],
  ['halfSize', 'vec4f', 'half-resolution target: w, h, 1 / w, 1 / h'],
  ['misc', 'vec4f', 'exposure / previous exposure, cloud history valid (0 / 1), amplitude of the blue-noise step phase of cloud rays (0 while noise is frozen), weight of a fresh cloud sample against its history'],
  ['shadowOrigin', 'vec4f', 'cloud shadow map: origin relative to the camera (ROOT axes), w = half extent in m (0 = no map)'],
  ['shadowU', 'vec4f', 'unit +u axis, w = number of density steps'],
  ['shadowV', 'vec4f', 'unit +v axis, w = optical depth scale (cos of the projection direction to the vertical at the origin)'],
  ['shadowL', 'vec4f', 'unit projection direction (towards the sun), w = 1 when texels are refreshed incrementally'],
  ['shadowShift', 'vec4f', 'xy = texel shift of the map origin since the previous frame, z = refresh phase 0..3, w = map resolution'],
  ['far', 'vec4f', 'far cloud shadow: layer radius (m), optical depth at coverage 1, longitude offset (rad), enabled (0 / 1)'],
  ['cloudShell', 'vec4f', 'bottom radius, top radius, bottom altitude, top altitude (m)'],
  ['noiseBase', 'vec4f', 'xyz = camera position in the cloud noise frame modulo the base tile (m), w = 1 / tile'],
  ['noiseDetail', 'vec4f', 'the same for the detail tile'],
  ['noiseMeso', 'vec4f', 'the same for the mesoscale tile'],
  ['noiseLarge', 'vec4f', 'the same for the weather-scale tile'],
  ['noiseRot', 'vec4f', 'cos, sin of the noise frame angle about the spin axis; z = coverage longitude offset (rad); w = coverage map width (texels)'],
  ['noiseFadeA', 'vec4f', 'share of the shape-noise amplitude averaged away at mip levels 0..3'],
  ['noiseFadeB', 'vec4f', 'the same at mip levels 4..7'],
  ['reproj0', 'vec4f', 'previous position of a cloud-fixed point: prev = p + M p + t (rows of M)'],
  ['reproj1', 'vec4f', ''],
  ['reproj2', 'vec4f', ''],
  ['reprojT', 'vec4f', 'xyz = t'],
  ['cloudLow', 'vec4f', 'low layer: thickness (m), extinction (1 / m), edge softness, coverage gain of the map'],
  ['cloudLow2', 'vec4f', 'fair-weather coverage, mesoscale amplitude, detail erosion strength, detail fade footprint (m)'],
  ['cloudHigh', 'vec4f', 'high layer: thickness min, thickness max (m), extinction min, extinction max (1 / m)'],
  ['cloudHigh2', 'vec4f', 'coverage where the high layer starts, where it is full, where the column starts to fill, where it is full'],
  ['cloudDeep', 'vec4f', 'deep column extinction (1 / m), ground albedo for the bounce, ambient scale, multi-scatter octave gain'],
  ['cloudLight', 'vec4f', 'strength of the diffuse (high-order) sun term, two-stream attenuation coefficient 0.75 (1 - g), relief of the top of thick sheets (m), quality scale of the governor (light is reused more below 1)'],
  ['cloudPhase', 'vec4f', 'forward g, backward g, lobe mix, sun reach of the cone samples (m)'],
  ['cloudMarch', 'vec4f', 'step factor (step = distance x factor), min step (m), max step (m), angle of a half-resolution pixel (rad)'],
  ['cloudWind', 'vec4f', 'xyz = noise shear per metre of altitude (noise frame), w = scroll of the detail noise (m)'],
] as const satisfies readonly (readonly [string, FieldType, string])[];

export type AtmoField = (typeof FIELDS)[number][0];

export const ATMO_UNIFORM_FLOATS = FIELDS.length * 4;
export const ATMO_UNIFORM_BYTES = ATMO_UNIFORM_FLOATS * 4;

const OFFSETS = new Map<string, { offset: number; type: FieldType }>(FIELDS.map(([name, type], i) => [name, { offset: i * 4, type }]));

/** WGSL declaration of the block; bind it as `@group(1) @binding(0) var<uniform> atmo: AtmoU;`. */
export const ATMO_UNIFORM_WGSL = `struct AtmoU {\n${FIELDS.map(([name, type, doc]) => `  ${name}: ${type},${doc ? `   // ${doc}` : ''}`).join('\n')}\n}`;

/** CPU copy of the block. */
export class AtmoUniforms {
  readonly buffer = new ArrayBuffer(ATMO_UNIFORM_BYTES);
  private readonly f32 = new Float32Array(this.buffer);
  private readonly i32 = new Int32Array(this.buffer);

  set(name: AtmoField, x: number, y = 0, z = 0, w = 0): void {
    const f = OFFSETS.get(name)!;
    const view = f.type === 'vec4i' ? this.i32 : this.f32;
    view[f.offset] = x;
    view[f.offset + 1] = y;
    view[f.offset + 2] = z;
    view[f.offset + 3] = w;
  }

  get(name: AtmoField): [number, number, number, number] {
    const f = OFFSETS.get(name)!;
    const view = f.type === 'vec4i' ? this.i32 : this.f32;
    return [view[f.offset]!, view[f.offset + 1]!, view[f.offset + 2]!, view[f.offset + 3]!];
  }
}
