/**
 * The UI scrim step (src/render/core/post/scrim.ts, the shader in tonemap.ts): the levels of the bloom chain it
 * reads, the packing of 'ui.scrimRects' in the contract's layout, the coverage of a rounded rectangle, the
 * scissor rectangles the step is drawn in, what the core knows of a buffer's contents, and the two shader
 * texts of the pass against the contract's constants and against each other.
 */
import { describe, expect, it } from 'vitest';
import { UI_SCRIM_BYTES, UI_SCRIM_SLOTS } from '@/core/contracts/render';
import { bloomLevelCount } from '@/render/core/post/postProcess';
import { packScrimRects, SCRIM_LEVELS, scrimCoverage, scrimLevelIndices, scrimLevelOf, scrimRectsOf, scrimScissors, writeScrimRects, type ScrimScissor, type UiScrimRect } from '@/render/core/post/scrim';
import { TONEMAP_BASE_WGSL, TONEMAP_WGSL } from '@/render/core/post/tonemap';

const rect = (o: Partial<UiScrimRect> = {}): UiScrimRect => ({ x0: 100, y0: 50, x1: 500, y1: 350, cornerRadius: 24, blur: 0.6, dim: 0.5, opacity: 1, ...o });

describe('scrim levels', () => {
  it('are the widest levels of the bloom chain, so a blur is as wide relative to the frame at every resolution', () => {
    // 720p: six levels, all of them. Level l is 1 / 2^(l + 1) of the frame: the widest is 720 / 64 texels high.
    expect(scrimLevelIndices(bloomLevelCount(720))).toEqual([0, 1, 2, 3, 4, 5]);
    // 1440p: seven levels; the scrim reads 1..6, each as wide in the frame as 0..5 at 720p.
    expect(scrimLevelIndices(bloomLevelCount(1440))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(scrimLevelIndices(bloomLevelCount(2160))).toEqual([2, 3, 4, 5, 6, 7]);
    for (const h of [720, 1440, 2880]) {
      const idx = scrimLevelIndices(bloomLevelCount(h));
      // Texels of the widest and of the finest scrim level across the frame height: the same at every height.
      expect(h / 2 ** (idx[SCRIM_LEVELS - 1]! + 1)).toBeCloseTo(720 / 64, 9);
      expect(h / 2 ** (idx[0]! + 1)).toBeCloseTo(360, 9);
    }
  });

  it('repeat the finest level where the chain is shorter than the scrim', () => {
    expect(bloomLevelCount(90)).toBe(3);
    expect(scrimLevelIndices(3)).toEqual([0, 0, 0, 0, 1, 2]);
    expect(scrimLevelIndices(9)).toEqual([3, 4, 5, 6, 7, 8]);
  });

  it('map blur 0..1 onto the levels, clamped', () => {
    expect(scrimLevelOf(0)).toBe(0);
    expect(scrimLevelOf(1)).toBe(SCRIM_LEVELS - 1);
    expect(scrimLevelOf(0.6)).toBeCloseTo(3, 12);
    expect(scrimLevelOf(-2)).toBe(0);
    expect(scrimLevelOf(7)).toBe(SCRIM_LEVELS - 1);
  });
});

describe("the 'ui.scrimRects' buffer", () => {
  it('has the contract layout: a header with the count, then two vec4 per slot', () => {
    const f = packScrimRects([rect(), rect({ x0: 0, y0: 0, x1: 10, y1: 20, cornerRadius: 0, blur: 1, dim: 0.25, opacity: 0.5 })]);
    expect(f.byteLength).toBe(UI_SCRIM_BYTES);
    expect([...f.subarray(0, 4)]).toEqual([2, 0, 0, 0]);
    expect([...f.subarray(4, 12)]).toEqual([100, 50, 500, 350, 24, Math.fround(0.6), 0.5, 1]);
    expect([...f.subarray(12, 20)]).toEqual([0, 0, 10, 20, 0, 1, 0.25, 0.5]);
    expect([...f.subarray(20)].every((x) => x === 0)).toBe(true);
  });

  it('is written whole, so a rectangle that went away leaves nothing behind', () => {
    const f = packScrimRects([rect(), rect(), rect()]);
    packScrimRects([rect({ x0: 1 })], f);
    expect(f[0]).toBe(1);
    expect(f[4]).toBe(1);
    expect([...f.subarray(12)].every((x) => x === 0)).toBe(true);
    packScrimRects([], f);
    expect([...f].every((x) => x === 0)).toBe(true);
  });

  it('refuses more rectangles than the step holds, and a buffer of another size', () => {
    expect(() => packScrimRects(new Array<UiScrimRect>(UI_SCRIM_SLOTS + 1).fill(rect()))).toThrow(/9 rectangles/);
    expect(packScrimRects(new Array<UiScrimRect>(UI_SCRIM_SLOTS).fill(rect()))[0]).toBe(UI_SCRIM_SLOTS);
    expect(() => packScrimRects([rect()], new Float32Array(8))).toThrow(/8 floats/);
  });
});

describe('the coverage of a rounded rectangle', () => {
  const r = rect();
  it('is 1 inside, 0 outside and ramps over one pixel across a straight edge', () => {
    expect(scrimCoverage(r, 300.5, 200.5)).toBe(1);
    expect(scrimCoverage(r, 50.5, 200.5)).toBe(0);
    expect(scrimCoverage(r, 300.5, 400.5)).toBe(0);
    // Pixel centres half a pixel inside and outside the left edge at x = 100: fully in, fully out; on the edge, half.
    expect(scrimCoverage(r, 100.5, 200.5)).toBe(1);
    expect(scrimCoverage(r, 99.5, 200.5)).toBe(0);
    expect(scrimCoverage(r, 100, 200.5)).toBe(0.5);
  });

  it('cuts the corners by the radius', () => {
    // The corner pixel of the bounding box is outside the 24 px arc; the arc's own point on the diagonal is on the edge.
    expect(scrimCoverage(r, 100.5, 50.5)).toBe(0);
    const onArc = 24 - 24 / Math.SQRT2;
    expect(scrimCoverage(r, 100 + onArc, 50 + onArc)).toBeCloseTo(0.5, 9);
    expect(scrimCoverage({ ...r, cornerRadius: 0 }, 100.5, 50.5)).toBe(1);
  });

  it('clamps a radius larger than the rectangle and covers nothing for an empty rectangle', () => {
    const pill = rect({ x0: 0, y0: 0, x1: 200, y1: 40, cornerRadius: 1000 });
    expect(scrimCoverage(pill, 100, 20)).toBe(1);
    expect(scrimCoverage(pill, 1, 1)).toBe(0);
    expect(scrimCoverage(pill, 0, 20)).toBeCloseTo(0.5, 9);
    expect(scrimCoverage(rect({ x0: 300, x1: 300 }), 300, 200)).toBe(0);
    expect(scrimCoverage(rect({ x0: 400, x1: 300 }), 350, 200)).toBe(0);
  });
});

describe('the scissors of the published rectangles', () => {
  const W = 1280;
  const H = 720;
  const scissors = (rects: UiScrimRect[], w = W, h = H): ScrimScissor[] => {
    const s = scrimScissors(packScrimRects(rects), w, h);
    if (s === null) throw new Error('the contents were not read');
    return s;
  };
  /** How many scissors hold each pixel of a w x h canvas. */
  const held = (list: readonly ScrimScissor[], w: number, h: number): Uint8Array => {
    const n = new Uint8Array(w * h);
    for (const s of list) for (let y = s.y; y < s.y + s.height; y++) for (let x = s.x; x < s.x + s.width; x++) n[y * w + x]!++;
    return n;
  };
  /** The shader's decision for a pixel: some rectangle's coverage times its opacity is above zero. */
  const touched = (rects: readonly UiScrimRect[], x: number, y: number): boolean => rects.some((r) => scrimCoverage(r, x + 0.5, y + 0.5) * Math.min(Math.max(r.opacity, 0), 1) > 0);

  it('are none without a rectangle, whatever the unused slots hold', () => {
    expect(scissors([])).toEqual([]);
    const f = packScrimRects([rect(), rect()]);
    f[0] = 0;
    expect(scrimScissors(f, W, H)).toEqual([]);
  });

  it('hold a rectangle with its one-pixel ramp and a pixel to spare, in whole pixels', () => {
    expect(scissors([rect()])).toEqual([{ x: 99, y: 49, width: 402, height: 302 }]);
    // Edges between pixels: the box is grown to whole pixels first.
    expect(scissors([rect({ x0: 100.25, y0: 50.75, x1: 499.5, y1: 349.01 })])).toEqual([{ x: 99, y: 49, width: 402, height: 302 }]);
    // The outermost ring of the scissor is not covered at all: the ramp ends a pixel inside it.
    const r = rect({ cornerRadius: 0 });
    const s = scissors([r])[0]!;
    for (let x = s.x; x < s.x + s.width; x++) {
      expect(scrimCoverage(r, x + 0.5, s.y + 0.5)).toBe(0);
      expect(scrimCoverage(r, x + 0.5, s.y + s.height - 0.5)).toBe(0);
    }
    for (let y = s.y; y < s.y + s.height; y++) {
      expect(scrimCoverage(r, s.x + 0.5, y + 0.5)).toBe(0);
      expect(scrimCoverage(r, s.x + s.width - 0.5, y + 0.5)).toBe(0);
    }
    // One pixel further in the ramp may begin (an edge on a pixel centre: half covered).
    expect(scrimCoverage(rect({ x0: 100.5, cornerRadius: 0 }), 100.5, 200.5)).toBe(0.5);
    expect(scissors([rect({ x0: 100.5 })])[0]!.x).toBe(99);
  });

  it('cost nothing for a rectangle without an area, one of opacity 0 and one off the canvas', () => {
    expect(scissors([rect({ x1: 100 })])).toEqual([]);
    expect(scissors([rect({ x1: 90 })])).toEqual([]);
    expect(scissors([rect({ y1: 50 })])).toEqual([]);
    expect(scissors([rect({ opacity: 0 })])).toEqual([]);
    expect(scissors([rect({ opacity: -1 })])).toEqual([]);
    expect(scissors([rect({ x0: 1400, x1: 1800 })])).toEqual([]);
    expect(scissors([rect({ y0: -400, y1: -100 })])).toEqual([]);
    // Among others: only the ones that can change a pixel are drawn.
    expect(scissors([rect({ opacity: 0 }), rect({ x0: 600, x1: 700 }), rect({ x0: 5, x1: 5 })])).toEqual([{ x: 599, y: 49, width: 102, height: 302 }]);
  });

  it('are cut to the canvas for a rectangle partly off it', () => {
    expect(scissors([rect({ x0: -80, y0: -40, x1: 200, y1: 120 })])).toEqual([{ x: 0, y: 0, width: 201, height: 121 }]);
    expect(scissors([rect({ x0: 1100, y0: 600, x1: 1500, y1: 900 })])).toEqual([{ x: 1099, y: 599, width: 181, height: 121 }]);
    // The whole canvas and more.
    expect(scissors([rect({ x0: -10, y0: -10, x1: 5000, y1: 5000 })])).toEqual([{ x: 0, y: 0, width: W, height: H }]);
  });

  it('do not overlap where rectangles do: a pixel under two panels is in one scissor', () => {
    const a = rect({ x0: 100, y0: 100, x1: 300, y1: 300 });
    const b = rect({ x0: 200, y0: 200, x1: 400, y1: 400 });
    const s = scissors([a, b]);
    expect(s).toEqual([
      { x: 99, y: 99, width: 202, height: 100 },
      { x: 99, y: 199, width: 302, height: 102 },
      { x: 199, y: 301, width: 202, height: 100 },
    ]);
    const n = held(s, W, H);
    expect(n.reduce((p, c) => Math.max(p, c), 0)).toBe(1);
    // The union of the two grown boxes: 202 x 202 each, 102 x 102 shared.
    expect(n.reduce((p, c) => p + c, 0)).toBe(2 * 202 * 202 - 102 * 102);
    // The order of the rectangles does not change where the step is drawn (the shader composes them in order).
    expect(scissors([b, a])).toEqual(s);
  });

  it('join what touches: two panels side by side are one scissor, a cross is three', () => {
    expect(scissors([rect({ x0: 100, x1: 300 }), rect({ x0: 301, x1: 500 })])).toEqual([{ x: 99, y: 49, width: 402, height: 302 }]);
    expect(scissors([rect({ x0: 100, x1: 300 }), rect({ x0: 320, x1: 500 })])).toHaveLength(2);
    const cross = scissors([rect({ x0: 300, y0: 100, x1: 400, y1: 500 }), rect({ x0: 100, y0: 250, x1: 600, y1: 350 })]);
    expect(cross).toEqual([
      { x: 299, y: 99, width: 102, height: 150 },
      { x: 99, y: 249, width: 502, height: 102 },
      { x: 299, y: 351, width: 102, height: 150 },
    ]);
    // A panel inside another adds nothing.
    expect(scissors([rect(), rect({ x0: 200, y0: 100, x1: 300, y1: 200 })])).toEqual(scissors([rect()]));
  });

  it('hold every pixel a rectangle can change exactly once, for any eight rectangles', () => {
    const w = 96;
    const h = 64;
    let seed = 12345;
    const rnd = (): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    for (let round = 0; round < 200; round++) {
      const rects: UiScrimRect[] = [];
      const count = 1 + Math.floor(rnd() * UI_SCRIM_SLOTS);
      for (let i = 0; i < count; i++) {
        // Quarter-pixel edges, some off the canvas, some without an area, some not faded in.
        const x0 = Math.round((rnd() * 140 - 20) * 4) / 4;
        const y0 = Math.round((rnd() * 100 - 20) * 4) / 4;
        const kind = rnd();
        rects.push({ x0, y0, x1: x0 + (kind < 0.1 ? 0 : Math.round(rnd() * 60 * 4) / 4), y1: y0 + Math.round(rnd() * 40 * 4) / 4, cornerRadius: rnd() * 30, blur: rnd(), dim: rnd(), opacity: kind > 0.9 ? 0 : rnd() });
      }
      const s = scissors(rects, w, h);
      for (const q of s) {
        expect(q.width).toBeGreaterThan(0);
        expect(q.height).toBeGreaterThan(0);
        expect(q.x).toBeGreaterThanOrEqual(0);
        expect(q.y).toBeGreaterThanOrEqual(0);
        expect(q.x + q.width).toBeLessThanOrEqual(w);
        expect(q.y + q.height).toBeLessThanOrEqual(h);
        expect([q.x, q.y, q.width, q.height].every(Number.isInteger)).toBe(true);
      }
      const n = held(s, w, h);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const c = n[y * w + x]!;
          if (c > 1) throw new Error(`round ${round}: pixel ${x},${y} is in ${c} scissors`);
          if (c === 0 && touched(rects, x, y)) throw new Error(`round ${round}: pixel ${x},${y} is covered by a rectangle and in no scissor`);
        }
      }
    }
  });

  it('read the header as the shader does, and give up on contents that are not numbers', () => {
    const f = packScrimRects([rect(), rect({ x0: 600, x1: 700 }), rect({ x0: 800, x1: 900 })]);
    f[0] = 2.9; // u32(2.9) = 2
    expect(scrimScissors(f, W, H)).toHaveLength(2);
    f[0] = -3;
    expect(scrimScissors(f, W, H)).toEqual([]);
    f[0] = 100; // min(100, slots): the five unused slots are zero and have no area
    expect(scrimScissors(f, W, H)).toHaveLength(3);
    f[0] = NaN;
    expect(scrimScissors(f, W, H)).toBeNull();
    f[0] = 3;
    f[4 + 8 + 2] = Infinity;
    expect(scrimScissors(f, W, H)).toBeNull();
    // A slot that is not in use is not read.
    f[0] = 1;
    expect(scrimScissors(f, W, H)).toHaveLength(1);
    expect(() => scrimScissors(new Float32Array(8), W, H)).toThrow(/8 floats/);
  });
});

describe('what the core knows of a buffer', () => {
  const fake = () => {
    const writes: { buffer: unknown; offset: number; data: Float32Array }[] = [];
    const device = { queue: { writeBuffer: (buffer: unknown, offset: number, data: Float32Array) => writes.push({ buffer, offset, data: data.slice() }) } } as unknown as GPUDevice;
    return { device, writes };
  };

  it('is what writeScrimRects wrote: the packed rectangles go to the buffer and are remembered', () => {
    const { device, writes } = fake();
    const buffer = {} as GPUBuffer;
    expect(scrimRectsOf(buffer)).toBeUndefined();
    writeScrimRects(device, buffer, [rect()]);
    expect(writes).toHaveLength(1);
    expect(writes[0]!.buffer).toBe(buffer);
    expect(writes[0]!.offset).toBe(0);
    expect([...writes[0]!.data]).toEqual([...packScrimRects([rect()])]);
    const first = scrimRectsOf(buffer)!;
    expect([...first]).toEqual([...packScrimRects([rect()])]);
    // Every write is a new array (the pass keeps its scissors for as long as it sees the same one).
    writeScrimRects(device, buffer, [rect()]);
    expect(scrimRectsOf(buffer)).not.toBe(first);
    writeScrimRects(device, buffer, []);
    expect([...scrimRectsOf(buffer)!].every((x) => x === 0)).toBe(true);
    // Another buffer is another matter.
    expect(scrimRectsOf({} as GPUBuffer)).toBeUndefined();
  });

  it('is unchanged by a write that is refused', () => {
    const { device, writes } = fake();
    const buffer = {} as GPUBuffer;
    writeScrimRects(device, buffer, [rect()]);
    const before = scrimRectsOf(buffer);
    expect(() => writeScrimRects(device, buffer, new Array<UiScrimRect>(UI_SCRIM_SLOTS + 1).fill(rect()))).toThrow(/9 rectangles/);
    expect(writes).toHaveLength(1);
    expect(scrimRectsOf(buffer)).toBe(before);
  });
});

describe('the tonemap shader', () => {
  it('without the scrim has no scrim binding, function or branch, and is otherwise the shader with it', () => {
    expect(TONEMAP_BASE_WGSL).not.toMatch(/scrim/i);
    expect(TONEMAP_BASE_WGSL).not.toContain('@binding(3)');
    expect(TONEMAP_BASE_WGSL.match(/@binding\(/g)).toHaveLength(3);
    // The fragment function: the one with the scrim, less the scrim step, to the character.
    const fsOf = (t: string): string => t.slice(t.indexOf('@fragment fn fs'));
    const withScrim = fsOf(TONEMAP_WGSL);
    const from = withScrim.indexOf('  // The UI scrim:');
    const to = withScrim.indexOf('  var o = srgbOetf(');
    expect(from).toBeGreaterThan(0);
    expect(to).toBeGreaterThan(from);
    expect(withScrim.slice(from, to)).toMatch(/^ {2}\/\/ The UI scrim:[^\n]*\n {2}let scrimCount/);
    expect(withScrim.slice(0, from) + withScrim.slice(to)).toBe(fsOf(TONEMAP_BASE_WGSL));
    // What comes before the scrim step and after it: sharpening and the bloom mix, then the display transform and the dither.
    expect(withScrim.slice(0, from)).toMatch(/c = mix\(c, bloom, tm\.params\.x\);\n$/);
    expect(withScrim.slice(to)).toBe('  var o = srgbOetf(displayTransform(c));\n  let n = blueNoise(vec2u(in.position.xy));\n  o += vec3f((n.x + n.y - 1.0) * tm.params.z / 255.0);\n  return vec4f(o, 1.0);\n}\n');
    // The display transform and the helpers before the fragment function are the same text in both.
    const display = (t: string): string => t.slice(t.indexOf('fn agxContrast'), t.indexOf('fn expand'));
    expect(display(TONEMAP_BASE_WGSL).length).toBeGreaterThan(1500);
    expect(display(TONEMAP_BASE_WGSL)).toBe(display(TONEMAP_WGSL));
    // And the bindings both have.
    const head = (t: string): string => t.slice(0, t.indexOf('var bloomTex'));
    expect(head(TONEMAP_BASE_WGSL)).toBe(head(TONEMAP_WGSL));
  });

  it('declares the scrim uniform with the contract slots and reads SCRIM_LEVELS textures', () => {
    expect(TONEMAP_WGSL).toContain(`rects: array<ScrimRect, ${UI_SCRIM_SLOTS}>`);
    for (let i = 0; i < SCRIM_LEVELS; i++) expect(TONEMAP_WGSL).toContain(`var scrimLevel${i}: texture_2d<f32>`);
    expect(TONEMAP_WGSL).not.toContain(`var scrimLevel${SCRIM_LEVELS}:`);
    // Two vec4f per slot after a vec4f header: the size the contract states.
    expect(16 + UI_SCRIM_SLOTS * 32).toBe(UI_SCRIM_BYTES);
  });

  it('does the scrim only when the header counts a rectangle', () => {
    expect(TONEMAP_WGSL).toMatch(/let scrimCount = min\(u32\(scrim\.header\.x\), \d+u\);\s*if \(scrimCount > 0u\)/);
  });
});
