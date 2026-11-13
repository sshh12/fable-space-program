/**
 * Where two captures differ (tests/browser/exactProbe.ts): the map the lead's probe prints for a checkpoint
 * that is not frame-exact, and the picture with the differing pixels marked.
 */
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { describeDifferenceMap, differenceMap, markDifferences } from '../../tests/browser/exactProbe';

const W = 160;
const H = 90;

/** A picture of one colour with some pixels set. */
function picture(base: [number, number, number], set: { x: number; y: number; rgb: [number, number, number] }[] = [], w = W, h = H): Buffer {
  const png = new PNG({ width: w, height: h });
  for (let i = 0; i < png.data.length; i += 4) {
    png.data[i] = base[0];
    png.data[i + 1] = base[1];
    png.data[i + 2] = base[2];
    png.data[i + 3] = 255;
  }
  for (const p of set) {
    const i = (p.y * w + p.x) * 4;
    png.data[i] = p.rgb[0];
    png.data[i + 1] = p.rgb[1];
    png.data[i + 2] = p.rgb[2];
  }
  return PNG.sync.write(png);
}
const pixel = (buf: Buffer, x: number, y: number): number[] => {
  const png = PNG.sync.read(buf);
  const i = (y * png.width + x) * 4;
  return [png.data[i]!, png.data[i + 1]!, png.data[i + 2]!];
};

describe('where two captures differ', () => {
  it('identical captures have no box, no samples and say so', () => {
    const a = picture([10, 20, 30]);
    const m = differenceMap(a, picture([10, 20, 30]));
    expect(m).toMatchObject({ width: W, height: H, differingPixels: 0, maxAbs: 0, box: null, samples: [] });
    expect(m.cells.every((n) => n === 0)).toBe(true);
    expect(describeDifferenceMap(m)).toBe('identical');
  });

  it('counts the pixels, bounds them, places them in the grid and samples both values', () => {
    const a = picture([10, 20, 30]);
    const b = picture([10, 20, 30], [
      { x: 5, y: 3, rgb: [11, 20, 30] },
      { x: 6, y: 3, rgb: [10, 21, 30] },
      { x: 150, y: 80, rgb: [10, 20, 37] },
    ]);
    const m = differenceMap(a, b);
    expect(m.differingPixels).toBe(3);
    expect(m.maxAbs).toBe(7);
    expect(m.box).toEqual({ x0: 5, y0: 3, x1: 150, y1: 80 });
    expect(m.grid).toEqual([16, 9]);
    // Cells of 10 x 10 pixels: (0,0) holds two, (15,8) one.
    expect(m.cells[0]).toBe(2);
    expect(m.cells[8 * 16 + 15]).toBe(1);
    expect(m.cells.reduce((s, n) => s + n, 0)).toBe(3);
    expect(m.samples).toEqual([
      { x: 5, y: 3, a: [10, 20, 30], b: [11, 20, 30] },
      { x: 6, y: 3, a: [10, 20, 30], b: [10, 21, 30] },
      { x: 150, y: 80, a: [10, 20, 30], b: [10, 20, 37] },
    ]);
    expect(describeDifferenceMap(m)).toBe(
      `3 of ${W * H} pixels differ by up to 7 level(s); box x 5-150, y 3-80 (146 x 78); cells of 16 x 9 (column,row: pixels): 0,0: 2; 15,8: 1; ` +
        'pixels: (5,3) 10,20,30 -> 11,20,30; (6,3) 10,20,30 -> 10,21,30; (150,80) 10,20,30 -> 10,20,37',
    );
  });

  it('samples the first pixels in reading order and always the one that differs most', () => {
    const set = [];
    for (let x = 0; x < 40; x++) set.push({ x, y: 2, rgb: [11, 20, 30] as [number, number, number] });
    set.push({ x: 100, y: 70, rgb: [90, 20, 30] as [number, number, number] });
    const m = differenceMap(picture([10, 20, 30]), picture([10, 20, 30], set), { samples: 4 });
    expect(m.differingPixels).toBe(41);
    expect(m.samples.map((s) => `${s.x},${s.y}`)).toEqual(['0,2', '1,2', '2,2', '3,2', '100,70']);
    expect(m.maxAbs).toBe(80);
  });

  it('refuses captures of different sizes', () => {
    expect(() => differenceMap(picture([0, 0, 0]), picture([0, 0, 0], [], 80, 45))).toThrow(/different sizes/);
    expect(() => markDifferences(picture([0, 0, 0]), picture([0, 0, 0], [], 80, 45))).toThrow(/different sizes/);
  });
});

describe('the picture with the differing pixels marked', () => {
  it('is the first capture dimmed and lifted, with a magenta outline around each differing pixel that leaves the pixel itself visible', () => {
    const a = picture([0, 0, 0], [{ x: 50, y: 40, rgb: [200, 100, 50] }]);
    const b = picture([0, 0, 0], [{ x: 50, y: 40, rgb: [201, 100, 50] }]);
    const marked = markDifferences(a, b, 4);
    // A black pixel away from the difference is lifted to a dark grey, so that a night picture stays readable.
    expect(pixel(marked, 10, 10)).toEqual([24, 24, 24]);
    // The differing pixel shows the first capture's colour, dimmed.
    expect(pixel(marked, 50, 40)).toEqual([24 + 120, 24 + 60, 24 + 30]);
    // The outline at Chebyshev distance 4, and nothing inside it or beyond it.
    for (const [x, y] of [[46, 40], [54, 40], [50, 36], [50, 44], [46, 36], [54, 44]] as const) expect(pixel(marked, x, y)).toEqual([255, 0, 255]);
    expect(pixel(marked, 47, 40)).toEqual([24, 24, 24]);
    expect(pixel(marked, 55, 40)).toEqual([24, 24, 24]);
  });

  it('marks nothing on identical captures and stays inside the picture at its edges', () => {
    const a = picture([40, 40, 40]);
    const same = PNG.sync.read(markDifferences(a, picture([40, 40, 40])));
    let magenta = 0;
    for (let i = 0; i < same.data.length; i += 4) if (same.data[i] === 255 && same.data[i + 1] === 0 && same.data[i + 2] === 255) magenta++;
    expect(magenta).toBe(0);
    const edge = markDifferences(a, picture([40, 40, 40], [{ x: 0, y: 0, rgb: [41, 40, 40] }, { x: W - 1, y: H - 1, rgb: [41, 40, 40] }]), 3);
    expect(pixel(edge, 3, 0)).toEqual([255, 0, 255]);
    expect(pixel(edge, 0, 3)).toEqual([255, 0, 255]);
    expect(pixel(edge, W - 4, H - 1)).toEqual([255, 0, 255]);
    expect(PNG.sync.read(edge)).toMatchObject({ width: W, height: H });
  });
});
