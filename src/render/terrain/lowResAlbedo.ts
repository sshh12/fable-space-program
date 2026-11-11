/**
 * The body's low-resolution colour map (`globals.albedoLowRes` of the tile set: equirectangular, row 0 =
 * north, column 0 = longitude -180) on the CPU, so that things placed by the CPU (rocks) can take the
 * colour of the ground they stand on.
 */
import type { TileManifest } from '@/core/contracts/terrain';
import type { Vec3, Vec3Tuple } from '@/core/math';
import { IMAGE_DECODE_OPTIONS } from './workerProtocol';

export const srgbToLinear = (c: number): number => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);

/**
 * Sampler of the linear albedo at a body-fixed direction. A tile set without the global map yields the
 * body's mean colour everywhere (`meanColor`, BodyDef.render.meanColor).
 */
export async function loadLowResAlbedo(tilesUrl: string, manifest: TileManifest, meanColor: Vec3Tuple): Promise<(dir: Vec3) => Vec3Tuple> {
  const g = manifest.globals?.albedoLowRes;
  if (!g) return () => [meanColor[0], meanColor[1], meanColor[2]];
  const res = await fetch(`${tilesUrl}/${manifest.tileset}/${g.path}?v=${encodeURIComponent(manifest.contentHash)}`);
  if (!res.ok) throw new Error(`tile set "${manifest.tileset}": ${g.path} HTTP ${res.status}`);
  const bitmap = await createImageBitmap(await res.blob(), IMAGE_DECODE_OPTIONS);
  const w = bitmap.width;
  const h = bitmap.height;
  const canvas = new OffscreenCanvas(w, h);
  const c2d = canvas.getContext('2d', { willReadFrequently: true })!;
  c2d.drawImage(bitmap, 0, 0);
  bitmap.close();
  const px = c2d.getImageData(0, 0, w, h).data;
  const lin = new Float32Array(w * h * 3);
  for (let i = 0, o = 0; i < px.length; i += 4, o += 3) {
    lin[o] = srgbToLinear(px[i]! / 255);
    lin[o + 1] = srgbToLinear(px[i + 1]! / 255);
    lin[o + 2] = srgbToLinear(px[i + 2]! / 255);
  }
  return (dir: Vec3): Vec3Tuple => {
    const lon = Math.atan2(dir.y, dir.x);
    const lat = Math.atan2(dir.z, Math.hypot(dir.x, dir.y));
    const fx = (lon / (2 * Math.PI) + 0.5) * w - 0.5;
    const fy = (0.5 - lat / Math.PI) * h - 0.5;
    const x0 = Math.floor(fx);
    const y0 = Math.min(h - 1, Math.max(0, Math.floor(fy)));
    const y1 = Math.min(h - 1, y0 + 1);
    const tx = fx - x0;
    const ty = Math.min(1, Math.max(0, fy - y0));
    const xa = ((x0 % w) + w) % w;
    const xb = (xa + 1) % w;
    const at = (x: number, y: number, c: number): number => lin[(y * w + x) * 3 + c]!;
    const mix = (c: number): number => (at(xa, y0, c) * (1 - tx) + at(xb, y0, c) * tx) * (1 - ty) + (at(xa, y1, c) * (1 - tx) + at(xb, y1, c) * tx) * ty;
    return [mix(0), mix(1), mix(2)];
  };
}
