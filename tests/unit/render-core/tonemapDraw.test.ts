/**
 * What the tonemap pass draws (src/render/core/post/tonemap.ts Tonemap.draw; finding 12 of the presentation
 * sweep's review), against a device and a pass that only record: the pass without the scrim alone when no
 * rectangle can change a pixel, the scrim shader inside the rectangles' scissors when the core knows the
 * buffer's contents, the scrim shader in one draw when it does not or when the scissors hold most of the frame.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { RenderContext } from '@/core/contracts/render';
import { SCRIM_LEVELS, writeScrimRects, type ScrimLevels, type UiScrimRect } from '@/render/core/post/scrim';
import { SCRIM_SPLIT_MAX_SHARE, Tonemap, tonemapDebug, type Look, type TonemapPath } from '@/render/core/post/tonemap';
import { createShaderLibrary } from '@/render/core/shaders/library';

vi.stubGlobal('GPUShaderStage', { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 });
vi.stubGlobal('GPUBufferUsage', { COPY_DST: 8, UNIFORM: 64 });

const W = 1280;
const H = 720;
const rect = (o: Partial<UiScrimRect> = {}): UiScrimRect => ({ x0: 100, y0: 50, x1: 500, y1: 350, cornerRadius: 24, blur: 0.6, dim: 0.5, opacity: 1, ...o });

interface FakePipeline {
  label: string;
  code: string;
  groupEntries: number;
}

function stand(look: Look = 1) {
  const pipelines: FakePipeline[] = [];
  const groups: string[] = [];
  const errors: string[] = [];
  const device = {
    createBindGroupLayout: (d: { label: string; entries: unknown[] }) => ({ label: d.label, entries: d.entries.length }),
    createBuffer: (d: { label: string }) => ({ label: d.label }),
    createPipelineLayout: (d: { bindGroupLayouts: { entries: number }[] }) => d,
    createShaderModule: (d: { label: string; code: string }) => ({ label: d.label, code: d.code, getCompilationInfo: () => Promise.resolve({ messages: [] }) }),
    createRenderPipeline(d: { label: string; layout: { bindGroupLayouts: { entries: number }[] }; fragment: { module: { code: string } } }) {
      const p = { label: d.label, code: d.fragment.module.code, groupEntries: d.layout.bindGroupLayouts[1]!.entries };
      pipelines.push(p);
      return p;
    },
    createBindGroup(d: { label: string; entries: unknown[] }) {
      groups.push(`${d.label}:${d.entries.length}`);
      return { label: d.label, entries: d.entries.length };
    },
    queue: { writeBuffer: () => {} },
  } as unknown as GPUDevice;
  const shaders = createShaderLibrary(device, (m) => errors.push(m));
  shaders.register('frame', '// frame');
  shaders.register('fullscreen', '// fullscreen');
  const ctx = { device, canvasFormat: 'bgra8unorm', frameBindGroupLayout: { entries: 0 } } as unknown as RenderContext;
  const tonemap = new Tonemap(ctx, shaders, look);

  const view = (name: string): GPUTextureView => ({ name }) as unknown as GPUTextureView;
  const scene = view('scene');
  const bloom = view('bloom');
  const levels: ScrimLevels = { views: Array.from({ length: SCRIM_LEVELS }, (_, i) => view(`level${i}`)), width: W, height: H };
  /** A buffer the core knows the contents of, as its own default and a menu's are. */
  const known = (rects: UiScrimRect[]): GPUBuffer => {
    const b = {} as GPUBuffer;
    writeScrimRects(device, b, rects);
    return b;
  };
  /** One frame: what the pass was told to do, in order. */
  const draw = (rects: GPUBuffer, o: { scene?: GPUTextureView; levels?: ScrimLevels } = {}): string[] => {
    const calls: string[] = [];
    const pass = {
      setPipeline: (p: FakePipeline) => calls.push(`pipeline ${p.label}`),
      setBindGroup: (i: number, g: { label: string; entries: number }) => calls.push(`group ${i} ${g.label}:${g.entries}`),
      setScissorRect: (x: number, y: number, w: number, h: number) => calls.push(`scissor ${x},${y},${w},${h}`),
      draw: (n: number) => calls.push(`draw ${n}`),
    } as unknown as GPURenderPassEncoder;
    tonemap.draw(pass, o.scene ?? scene, bloom, { bloomMix: 0.04, sharpness: 0.2, dither: 1 }, { rects, levels: o.levels ?? levels });
    return calls;
  };
  return { tonemap, device, pipelines, groups, errors, known, draw, view, levels };
}

const BASE = ['pipeline core.tonemap', 'group 1 tonemap:3', 'draw 3'];
const SCRIM = ['pipeline core.tonemap.scrim', `group 1 tonemap.scrim:${4 + SCRIM_LEVELS}`];
const SINGLE = [...SCRIM, 'draw 3'];
const WHOLE = `scissor 0,0,${W},${H}`;

describe('the tonemap pass', () => {
  let saved: TonemapPath;
  beforeEach(() => {
    saved = tonemapDebug.path;
    tonemapDebug.path = 'auto';
  });
  afterEach(() => {
    tonemapDebug.path = saved;
  });

  it('with no rectangle is the pass without the scrim: no scrim pipeline, no scrim bind group', () => {
    const s = stand();
    expect(s.draw(s.known([]))).toEqual(BASE);
    expect(s.pipelines.map((p) => p.label)).toEqual(['core.tonemap']);
    expect(s.pipelines[0]!.groupEntries).toBe(3);
    expect(s.pipelines[0]!.code).not.toMatch(/scrim/i);
    expect(s.groups).toEqual(['tonemap:3']);
    expect(tonemapDebug.last).toEqual({ drawn: 'base', scissors: 0, scissorPixels: 0, look: 1 });
    // The next frame draws with what exists.
    expect(s.draw(s.known([]))).toEqual(BASE);
    expect(s.pipelines).toHaveLength(1);
    expect(s.errors).toEqual([]);
  });

  it('with rectangles that cannot change a pixel is the same pass: no area, opacity 0, off the canvas', () => {
    const s = stand();
    expect(s.draw(s.known([rect({ x1: 100 }), rect({ opacity: 0 }), rect({ x0: 2000, x1: 2400 })]))).toEqual(BASE);
    expect(s.pipelines.map((p) => p.label)).toEqual(['core.tonemap']);
    expect(s.groups).toEqual(['tonemap:3']);
  });

  it('draws the scrim shader inside the scissor of a rectangle, after the pass without it, and gives the canvas back', () => {
    const s = stand();
    expect(s.draw(s.known([rect()]))).toEqual([...BASE, ...SCRIM, 'scissor 99,49,402,302', 'draw 3', WHOLE]);
    expect(s.pipelines.map((p) => `${p.label}:${p.groupEntries}`)).toEqual(['core.tonemap:3', `core.tonemap.scrim:${4 + SCRIM_LEVELS}`]);
    expect(s.pipelines[1]!.code).toContain('scrimCover');
    expect(tonemapDebug.last).toEqual({ drawn: 'split', scissors: 1, scissorPixels: 402 * 302, look: 1 });
  });

  it('draws a pixel under two panels once: the scissors of overlapping rectangles do not overlap', () => {
    const s = stand();
    const calls = s.draw(s.known([rect({ x0: 100, y0: 100, x1: 300, y1: 300 }), rect({ x0: 200, y0: 200, x1: 400, y1: 400 })]));
    expect(calls).toEqual([...BASE, ...SCRIM, 'scissor 99,99,202,100', 'draw 3', 'scissor 99,199,302,102', 'draw 3', 'scissor 199,301,202,100', 'draw 3', WHOLE]);
    expect(tonemapDebug.last).toMatchObject({ drawn: 'split', scissors: 3, scissorPixels: 2 * 202 * 202 - 102 * 102 });
  });

  it('cuts the scissor of a rectangle partly off the canvas to the canvas', () => {
    const s = stand();
    expect(s.draw(s.known([rect({ x0: 1100, y0: 600, x1: 1500, y1: 900 })]))).toEqual([...BASE, ...SCRIM, 'scissor 1099,599,181,121', 'draw 3', WHOLE]);
  });

  it('is the scrim shader in one draw when the core does not know what is in the buffer', () => {
    const s = stand();
    expect(s.draw({} as GPUBuffer)).toEqual(SINGLE);
    expect(s.pipelines.map((p) => p.label)).toEqual(['core.tonemap.scrim']);
    expect(s.groups).toEqual([`tonemap.scrim:${4 + SCRIM_LEVELS}`]);
    expect(tonemapDebug.last).toEqual({ drawn: 'single', scissors: 0, scissorPixels: 0, look: 1 });
  });

  it('is the scrim shader in one draw when the scissors hold most of the frame', () => {
    const s = stand();
    const share = (r: UiScrimRect): number => ((r.x1 - r.x0 + 2) * (r.y1 - r.y0 + 2)) / (W * H);
    const most = rect({ x0: 40, y0: 20, x1: 1240, y1: 700 });
    const less = rect({ x0: 40, y0: 20, x1: 940, y1: 620 });
    expect(share(most)).toBeGreaterThan(SCRIM_SPLIT_MAX_SHARE);
    expect(share(less)).toBeLessThan(SCRIM_SPLIT_MAX_SHARE);
    expect(s.draw(s.known([most]))).toEqual(SINGLE);
    expect(s.draw(s.known([less]))).toEqual([...BASE, ...SCRIM, 'scissor 39,19,902,602', 'draw 3', WHOLE]);
    // The measurement switch 'split' never takes the one draw on account of the area.
    tonemapDebug.path = 'split';
    expect(s.draw(s.known([most]))).toEqual([...BASE, ...SCRIM, 'scissor 39,19,1202,682', 'draw 3', WHOLE]);
    expect(s.draw({} as GPUBuffer)).toEqual(SINGLE);
  });

  it('follows the switch of tests and measurements: the pass as the sweep made it, and the pass before the scrim', () => {
    const s = stand();
    tonemapDebug.path = 'single';
    expect(s.draw(s.known([]))).toEqual(SINGLE);
    expect(s.draw(s.known([rect()]))).toEqual(SINGLE);
    tonemapDebug.path = 'base';
    expect(s.draw(s.known([rect()]))).toEqual(BASE);
    expect(s.draw({} as GPUBuffer)).toEqual(BASE);
    expect(tonemapDebug.last!.drawn).toBe('base');
  });

  it('makes its scissors anew when the rectangles are written again or the canvas has another size', () => {
    const s = stand();
    const buffer = s.known([rect()]);
    expect(s.draw(buffer)).toContain('scissor 99,49,402,302');
    writeScrimRects(s.device, buffer, [rect({ x0: 200 })]);
    expect(s.draw(buffer)).toContain('scissor 199,49,302,302');
    writeScrimRects(s.device, buffer, []);
    expect(s.draw(buffer)).toEqual(BASE);
    writeScrimRects(s.device, buffer, [rect()]);
    const small: ScrimLevels = { ...s.levels, width: 320, height: 180 };
    expect(s.draw(buffer, { levels: small })).toEqual([...BASE, ...SCRIM, 'scissor 99,49,221,131', 'draw 3', 'scissor 0,0,320,180']);
  });

  it('keeps its bind groups from frame to frame and makes them anew for another image', () => {
    const s = stand();
    const buffer = s.known([rect()]);
    s.draw(buffer);
    s.draw(buffer);
    expect(s.groups).toEqual(['tonemap:3', `tonemap.scrim:${4 + SCRIM_LEVELS}`]);
    const another = s.view('another');
    s.draw(buffer, { scene: another });
    s.draw(buffer, { scene: another });
    expect(s.groups).toEqual(['tonemap:3', `tonemap.scrim:${4 + SCRIM_LEVELS}`, 'tonemap:3', `tonemap.scrim:${4 + SCRIM_LEVELS}`]);
    // Another rectangle buffer: the scrim's group only.
    s.draw(s.known([rect()]), { scene: another });
    expect(s.groups).toHaveLength(5);
    expect(s.groups[4]).toBe(`tonemap.scrim:${4 + SCRIM_LEVELS}`);
  });

  it('draws both shaders under the look it was made with', () => {
    for (const look of [1, 2] as const) {
      const s = stand(look);
      s.draw(s.known([rect()]));
      expect(s.pipelines.map((p) => p.label)).toEqual(['core.tonemap', 'core.tonemap.scrim']);
      for (const p of s.pipelines) expect(p.code.includes('camGrey'), `${p.label} under look ${look}`).toBe(look === 2);
      expect(s.pipelines[0]!.code).not.toMatch(/scrim/i);
      expect(tonemapDebug.last!.look).toBe(look);
      expect(s.errors).toEqual([]);
    }
  });

  it('hands both pipelines to the warm-up, and runs as it is meant to run when no test has set the switch', () => {
    const s = stand();
    expect(s.tonemap.pipelines()).toHaveLength(2);
    for (const t of s.tonemap.pipelines()) (t as { get(): unknown }).get();
    expect(s.pipelines.map((p) => p.label)).toEqual(['core.tonemap', 'core.tonemap.scrim']);
    expect(saved).toBe('auto');
  });

  it('refuses another number of scrim levels than it binds', () => {
    const s = stand();
    expect(() => s.draw(s.known([]), { levels: { views: s.levels.views.slice(1), width: W, height: H } })).toThrow(/5 scrim levels/);
  });
});
