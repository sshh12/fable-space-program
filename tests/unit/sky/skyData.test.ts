import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { SkyManifest } from '@/core/contracts/sky';
import { STAR_MAG0_ILLUMINANCE, STAR_RECORD_FLOATS } from '@/core/contracts/sky';
import { decodeHalf, decodeRgb9e5, faceFileBytes, faceMipLayout, parseStarCatalogue, rgb9e5LuminanceHalf, validateSkyManifest } from '@/render/sky/skyData';
import { cubeFaceUv, raDecToDir } from '@/render/sky/photometry';

const skyDir = path.resolve(__dirname, '../../../data/sky');
const haveSky = fs.existsSync(path.join(skyDir, 'manifest.json'));

describe('sky data layout', () => {
  it('face files hold the full mip chain, level 0 first', () => {
    const l = faceMipLayout(2048, 12);
    expect(l[0]).toEqual({ offset: 0, size: 2048 });
    expect(l[1]!.offset).toBe(2048 * 2048 * 4);
    expect(l[11]!.size).toBe(1);
    expect(faceFileBytes(2048, 12)).toBe(5_592_405 * 4);
  });

  it('rgb9e5 decodes exactly for representable values', () => {
    // (1, 0.5, 0.25): exponent 16 (2^1 scale with bias 15, 9 bits), mantissas 256, 128, 64.
    const v = 256 | (128 << 9) | (64 << 18) | (16 << 27);
    expect(decodeRgb9e5(v >>> 0)).toEqual([1, 0.5, 0.25]);
  });

  it('the luminance detail layer: rgb9e5 texels to half-float luminance within the precision of a half', () => {
    const texels = new Uint32Array([
      256 | (128 << 9) | (64 << 18) | (16 << 27), // (1, 0.5, 0.25)
      0,
      511 | (511 << 9) | (511 << 18) | (31 << 27), // the largest value, 65408
      1 | (0 << 9) | (0 << 18) | (0 << 27), // the smallest non-zero red, 2^-24
      300 | (17 << 9) | (455 << 18) | (9 << 27),
    ]);
    const half = rgb9e5LuminanceHalf(texels);
    for (let i = 0; i < texels.length; i++) {
      const [r, g, b] = decodeRgb9e5(texels[i]!);
      const l = 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const got = decodeHalf(half[i]!);
      // 11 significant bits; below 2^-14 a half is denormal (absolute step 2^-24).
      expect(Math.abs(got - l)).toBeLessThanOrEqual(Math.max(l * 2 ** -11, 2 ** -24));
    }
    expect(half[1]).toBe(0);
  });

  it('rejects manifests that break the contract', () => {
    expect(() => validateSkyManifest({ formatVersion: 2 })).toThrow(/formatVersion/);
  });
});

describe.runIf(haveSky)('baked sky data (data/sky)', () => {
  const manifest = validateSkyManifest(JSON.parse(fs.readFileSync(path.join(skyDir, 'manifest.json'), 'utf8')) as SkyManifest);

  it('the catalogue parses: unit directions, lux from V, brightest first', () => {
    const buf = fs.readFileSync(path.join(skyDir, manifest.stars.file));
    const cat = parseStarCatalogue(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength), manifest.stars.count);
    expect(cat.count).toBe(manifest.stars.count);
    for (let i = 0; i < cat.count; i += 97) {
      const o = i * STAR_RECORD_FLOATS;
      expect(cat.records[o + 3]! / (STAR_MAG0_ILLUMINANCE * 10 ** (-0.4 * cat.records[o + 7]!))).toBeCloseTo(1, 4);
    }
    // Sirius is the first record, at RA 101.287 deg, Dec -16.716 deg.
    const s = raDecToDir((101.2872 * Math.PI) / 180, (-16.7161 * Math.PI) / 180);
    const d = { x: cat.records[0]!, y: cat.records[1]!, z: cat.records[2]! };
    // atan2 of |cross| and dot: acos of a float32 dot product would be off by a minute of arc.
    const cr = Math.hypot(s.y * d.z - s.z * d.y, s.z * d.x - s.x * d.z, s.x * d.y - s.y * d.x);
    expect(Math.atan2(cr, s.x * d.x + s.y * d.y + s.z * d.z) * (180 / Math.PI) * 3600).toBeLessThan(5);
  });

  it('every face file has the byte size of a full rgb9e5 mip chain', () => {
    const want = faceFileBytes(manifest.milkyWay.faceSize, manifest.milkyWay.mipLevels);
    for (const f of manifest.milkyWay.files) expect(fs.statSync(path.join(skyDir, f)).size).toBe(want);
  });

  it('the Milky Way is brighter towards the galactic centre than towards the galactic poles (cube lookup in ROOT axes)', () => {
    // Mean luminance of a 3 x 3 block of level 5 (64^2 per face) around a direction.
    const level = 5;
    const layout = faceMipLayout(manifest.milkyWay.faceSize, manifest.milkyWay.mipLevels)[level]!;
    const faces = manifest.milkyWay.files.map((f) => {
      const fd = fs.openSync(path.join(skyDir, f), 'r');
      const b = Buffer.alloc(layout.size * layout.size * 4);
      fs.readSync(fd, b, 0, b.length, layout.offset);
      fs.closeSync(fd);
      return new Uint32Array(b.buffer, b.byteOffset, b.length / 4);
    });
    const lum = (raDeg: number, decDeg: number): number => {
      const { face, s, t } = cubeFaceUv(raDecToDir((raDeg * Math.PI) / 180, (decDeg * Math.PI) / 180));
      const x = Math.min(layout.size - 2, Math.max(1, Math.floor(s * layout.size)));
      const y = Math.min(layout.size - 2, Math.max(1, Math.floor(t * layout.size)));
      let sum = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const [r, g, b] = decodeRgb9e5(faces[face]![(y + j) * layout.size + x + i]!);
          sum += 0.2126 * r + 0.7152 * g + 0.0722 * b;
        }
      }
      return (sum / 9) * manifest.milkyWay.luminanceScale;
    };
    const centre = lum(266.4, -28.9);
    const cygnus = lum(305, 40);
    const northPole = lum(192.9, 27.1);
    const southPole = lum(12.9, -27.1);
    expect(centre).toBeGreaterThan(5e-4);
    expect(centre).toBeLessThan(5e-3);
    expect(centre / northPole).toBeGreaterThan(5);
    expect(centre / southPole).toBeGreaterThan(5);
    expect(cygnus / northPole).toBeGreaterThan(2);
  });
});
