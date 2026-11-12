/**
 * Airglow: the faint light the upper atmosphere emits by itself (recombination of oxygen and the
 * sodium / hydroxyl chemistry of the mesopause), in the march as optically thin Gaussian layers.
 *
 * The layers are per-body data, `AtmosphereRenderDef.airglow` (`AirglowLayerDef`: peak altitude, full width
 * at half maximum, luminance seen straight up from under the layer, linear sRGB colour of any scale). A body
 * without it has no airglow. Data files are not checked against the types at run time: every layer is
 * validated here like the cloud tunables, and a malformed one is reported and left out.
 */
import type { AtmosphereRenderDef } from '@/core/contracts/defs';

/** At most this many layers per body reach the shaders. */
export const AIRGLOW_MAX_LAYERS = 2;

/** One layer as the shaders take it: peak altitude and Gaussian sigma (m), emission per metre at the peak (cd/m^2 per m, rgb). */
export interface AirglowLayer {
  altitude: number;
  sigma: number;
  emission: [number, number, number];
}

const FWHM_PER_SIGMA = 2 * Math.sqrt(2 * Math.LN2);

/** The airglow layers of an atmosphere definition; malformed entries are reported in `problems` and left out. */
export function resolveAirglow(def: AtmosphereRenderDef): { layers: AirglowLayer[]; problems: string[] } {
  const raw: unknown = def.airglow;
  const problems: string[] = [];
  const layers: AirglowLayer[] = [];
  if (raw === undefined) return { layers, problems };
  if (!Array.isArray(raw)) return { layers, problems: ['atmosphere "airglow" must be an array of layers'] };
  const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  raw.forEach((entry: unknown, i) => {
    const e = (typeof entry === 'object' && entry !== null ? entry : {}) as Record<string, unknown>;
    const altitude = num(e.altitude);
    const thickness = num(e.thickness);
    const zenith = num(e.zenithLuminance);
    const color = Array.isArray(e.color) && e.color.length === 3 ? e.color.map(num) : [];
    const [r, g, b] = color;
    if (altitude === null || thickness === null || !(thickness > 0) || zenith === null || r == null || g == null || b == null) {
      problems.push(`atmosphere airglow layer ${i} is malformed (altitude, thickness > 0, zenithLuminance, color [r, g, b], all finite and not negative)`);
      return;
    }
    const y = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!(y > 0)) {
      problems.push(`atmosphere airglow layer ${i} has a black color`);
      return;
    }
    const sigma = thickness / FWHM_PER_SIGMA;
    // The zenith luminance is the emission integrated straight through the layer: peak x sigma sqrt(2 pi).
    const peak = zenith / (sigma * Math.sqrt(2 * Math.PI) * y);
    layers.push({ altitude, sigma, emission: [r * peak, g * peak, b * peak] });
  });
  if (layers.length > AIRGLOW_MAX_LAYERS) problems.push(`atmosphere airglow has ${layers.length} layers; the first ${AIRGLOW_MAX_LAYERS} are drawn`);
  return { layers: layers.slice(0, AIRGLOW_MAX_LAYERS), problems };
}

/** Highest altitude (m) at which the airglow of an atmosphere definition still counts (peak + 3 sigma of its drawn layers; 0 = none). */
export function airglowTop(def: AtmosphereRenderDef): number {
  let top = 0;
  for (const l of resolveAirglow(def).layers) top = Math.max(top, l.altitude + 3 * l.sigma);
  return top;
}

/**
 * The brightest the airglow of a body of radius `bodyRadius` (m) can look, cd/m^2: a layer seen edge-on,
 * along the ray that touches the shell of its peak. (A Gaussian layer of sigma s at radius r, crossed at the
 * tangent: the integral of exp(-x^4 / (8 r^2 s^2)) dx = 2 Gamma(5/4) (8 r^2 s^2)^(1/4).)
 */
export function airglowPeakLuminance(layers: readonly AirglowLayer[], bodyRadius: number): number {
  let peak = 0;
  for (const l of layers) {
    const r = bodyRadius + l.altitude;
    const path = 1.8128 * (8 * r * r * l.sigma * l.sigma) ** 0.25;
    peak = Math.max(peak, (0.2126 * l.emission[0] + 0.7152 * l.emission[1] + 0.0722 * l.emission[2]) * path);
  }
  return peak;
}

/**
 * Whether the airglow can show in a frame of this exposure (`FrameContext.exposure`: pre-exposed value per
 * cd/m^2): its brightest line of sight reaches a tenth of the first step of an 8-bit display. Under
 * daylight and through most of twilight it does not, by orders of magnitude, and the march does not
 * integrate it.
 */
export function airglowShows(layers: readonly AirglowLayer[], bodyRadius: number, exposure: number): boolean {
  return airglowPeakLuminance(layers, bodyRadius) * exposure >= 3e-5;
}
