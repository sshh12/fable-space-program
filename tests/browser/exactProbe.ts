/**
 * Where two captures of one page differ (no Playwright in here; unit-tested by tools/dev/exact-probe.test.ts).
 *
 * A checkpoint that fails the two-identical-captures rule of the reference images (baselineLogic.ts,
 * NotFrameExactError) is a finding against the element that still moves when every feature reports idle.
 * The count of differing pixels does not name that element; their place does. The probe spec
 * (tests/browser/shell/baseline-exact-probe.spec.ts) takes several captures of the checkpoint and uses
 * this module to say where consecutive captures differ and to write a picture with the places marked.
 */
import { PNG } from 'pngjs';

export interface DifferingPixel {
  x: number;
  y: number;
  /** RGB of the first and of the second capture there. */
  a: [number, number, number];
  b: [number, number, number];
}

export interface DifferenceMap {
  width: number;
  height: number;
  differingPixels: number;
  /** Largest difference of one channel, in levels of 255. */
  maxAbs: number;
  /** Smallest rectangle that holds every differing pixel (inclusive), or null when the captures are identical. */
  box: { x0: number; y0: number; x1: number; y1: number } | null;
  /** The grid the picture is divided into (columns, rows) and the differing pixels per cell, row-major. */
  grid: [number, number];
  cells: number[];
  /** The first differing pixels in reading order (at most `samples`), then the one with the largest difference if it is not among them. */
  samples: DifferingPixel[];
}

/** Where captures `a` and `b` (PNG buffers of one size) differ. */
export function differenceMap(a: Buffer, b: Buffer, opts: { samples?: number; grid?: [number, number] } = {}): DifferenceMap {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error(`two captures of one page have different sizes (${A.width}x${A.height} and ${B.width}x${B.height})`);
  const maxSamples = opts.samples ?? 12;
  const grid = opts.grid ?? [16, 9];
  const cells = new Array<number>(grid[0] * grid[1]).fill(0);
  const samples: DifferingPixel[] = [];
  let largest: (DifferingPixel & { d: number }) | null = null;
  let differingPixels = 0;
  let maxAbs = 0;
  let box: DifferenceMap['box'] = null;
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      const d = Math.max(Math.abs(A.data[i]! - B.data[i]!), Math.abs(A.data[i + 1]! - B.data[i + 1]!), Math.abs(A.data[i + 2]! - B.data[i + 2]!), Math.abs(A.data[i + 3]! - B.data[i + 3]!));
      if (d === 0) continue;
      differingPixels++;
      if (d > maxAbs) maxAbs = d;
      box = box ? { x0: Math.min(box.x0, x), y0: Math.min(box.y0, y), x1: Math.max(box.x1, x), y1: Math.max(box.y1, y) } : { x0: x, y0: y, x1: x, y1: y };
      cells[Math.min(grid[1] - 1, Math.floor((y * grid[1]) / A.height)) * grid[0] + Math.min(grid[0] - 1, Math.floor((x * grid[0]) / A.width))]!++;
      const px: DifferingPixel = { x, y, a: [A.data[i]!, A.data[i + 1]!, A.data[i + 2]!], b: [B.data[i]!, B.data[i + 1]!, B.data[i + 2]!] };
      if (samples.length < maxSamples) samples.push(px);
      if (!largest || d > largest.d) largest = { ...px, d };
    }
  }
  if (largest && !samples.some((s) => s.x === largest!.x && s.y === largest!.y)) samples.push({ x: largest.x, y: largest.y, a: largest.a, b: largest.b });
  return { width: A.width, height: A.height, differingPixels, maxAbs, box, grid, cells, samples };
}

/** The map in one line: how many pixels, by how much, where (box and grid cells), and the sampled pixels with both values. */
export function describeDifferenceMap(m: DifferenceMap): string {
  if (m.differingPixels === 0) return 'identical';
  const box = m.box!;
  const cells = m.cells
    .map((n, i) => ({ n, col: i % m.grid[0], row: Math.floor(i / m.grid[0]) }))
    .filter((c) => c.n > 0)
    .sort((p, q) => q.n - p.n)
    .slice(0, 8)
    .map((c) => `${c.col},${c.row}: ${c.n}`)
    .join('; ');
  const samples = m.samples.map((s) => `(${s.x},${s.y}) ${s.a.join(',')} -> ${s.b.join(',')}`).join('; ');
  return (
    `${m.differingPixels} of ${m.width * m.height} pixels differ by up to ${m.maxAbs} level(s); ` +
    `box x ${box.x0}-${box.x1}, y ${box.y0}-${box.y1} (${box.x1 - box.x0 + 1} x ${box.y1 - box.y0 + 1}); ` +
    `cells of ${m.grid[0]} x ${m.grid[1]} (column,row: pixels): ${cells}; pixels: ${samples}`
  );
}

/**
 * Capture `a`, dimmed and lifted to a grey so that a dark picture stays readable, with a magenta square of
 * side 2 * radius + 1 around every pixel in which `b` differs from it: a picture to look at, on which a
 * handful of pixels that differ by one level can be found.
 */
export function markDifferences(a: Buffer, b: Buffer, radius = 4): Buffer {
  const A = PNG.sync.read(a);
  const B = PNG.sync.read(b);
  if (A.width !== B.width || A.height !== B.height) throw new Error(`two captures of one page have different sizes (${A.width}x${A.height} and ${B.width}x${B.height})`);
  const out = new PNG({ width: A.width, height: A.height });
  for (let i = 0; i < A.data.length; i += 4) {
    out.data[i] = 24 + Math.round(A.data[i]! * 0.6);
    out.data[i + 1] = 24 + Math.round(A.data[i + 1]! * 0.6);
    out.data[i + 2] = 24 + Math.round(A.data[i + 2]! * 0.6);
    out.data[i + 3] = 255;
  }
  for (let y = 0; y < A.height; y++) {
    for (let x = 0; x < A.width; x++) {
      const i = (y * A.width + x) * 4;
      if (A.data[i] === B.data[i] && A.data[i + 1] === B.data[i + 1] && A.data[i + 2] === B.data[i + 2] && A.data[i + 3] === B.data[i + 3]) continue;
      for (let yy = Math.max(0, y - radius); yy <= Math.min(A.height - 1, y + radius); yy++) {
        for (let xx = Math.max(0, x - radius); xx <= Math.min(A.width - 1, x + radius); xx++) {
          // The square's outline only, so that what lies under the differing pixel stays visible.
          if (Math.max(Math.abs(xx - x), Math.abs(yy - y)) !== radius) continue;
          const j = (yy * A.width + xx) * 4;
          out.data[j] = 255;
          out.data[j + 1] = 0;
          out.data[j + 2] = 255;
        }
      }
    }
  }
  return PNG.sync.write(out);
}
