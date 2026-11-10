/**
 * Baked sky data contract: written by the sky bake (tools/bake/sky) into data/sky/, read by the sky renderer.
 *
 * Frame: ROOT axes = J2000 mean equator and equinox (+X vernal equinox, +Z north celestial pole).
 * A direction with right ascension a and declination d is (cos d cos a, cos d sin a, sin d).
 */

/** data/sky/manifest.json (served at /sky/manifest.json). */
export interface SkyManifest {
  formatVersion: 1;
  frame: 'j2000-equatorial';
  /**
   * Milky Way + unresolved faint stars as a cube map. Stars brighter than `stars.catalogCutoffMag` have been
   * removed from it (they are drawn from the catalogue), so nothing is counted twice.
   * Files are raw little-endian `rgb9e5ufloat` texels, one file per face in WebGPU cube order
   * (+X, -X, +Y, -Y, +Z, -Z), each containing the full mip chain (level 0 first, rows top to bottom).
   * `textureSample(cube, sampler, dir)` with `dir` in ROOT axes must return the sky in direction `dir`.
   */
  milkyWay: {
    faceSize: number;
    mipLevels: number;
    format: 'rgb9e5ufloat';
    files: [string, string, string, string, string, string];
    /** Multiply stored values by this to get luminance in cd/m^2. */
    luminanceScale: number;
  };
  /**
   * Star catalogue: little-endian float32 records of STAR_RECORD_FLOATS values, brightest first:
   *   [0..2] unit direction (ROOT axes)   [3] illuminance at Earth in lux (2.54e-6 * 10^(-0.4 V))
   *   [4..6] linear-sRGB colour normalised to luminance 1 (from B-V)   [7] visual magnitude V
   */
  stars: { file: string; count: number; recordFloats: number; catalogCutoffMag: number };
  /** JSON array of { name, index } for named stars (index into the catalogue), for labels and tests. */
  namedStars: string;
  attribution: string[];
}

export const STAR_RECORD_FLOATS = 8;
/** Illuminance in lux of a magnitude-0 star outside the atmosphere. */
export const STAR_MAG0_ILLUMINANCE = 2.54e-6;
