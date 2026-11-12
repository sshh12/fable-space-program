/**
 * The shader library's tracked builds and `warm` (request app-integration-11) against a device that only
 * counts: which creations are asked for, in which order, and what `get()` returns.
 */
import { describe, expect, it } from 'vitest';
import { createShaderLibrary } from '@/render/core/shaders/library';

interface FakePipeline {
  how: 'sync' | 'async';
  label: string;
  getBindGroupLayout(i: number): string;
}

function fakeDevice(opts: { async?: boolean; failAsync?: (label: string) => boolean } = {}) {
  const log: string[] = [];
  const modules: string[] = [];
  /** Resolvers of the asynchronous creations that have not been let through yet. */
  const waiting: (() => void)[] = [];
  const pipeline = (how: 'sync' | 'async', label: string): FakePipeline => ({ how, label, getBindGroupLayout: (i) => `${label}.layout${i}` });
  const device: Record<string, unknown> = {
    createShaderModule(d: { label: string; code: string }) {
      modules.push(d.label);
      return { label: d.label, code: d.code, getCompilationInfo: () => Promise.resolve({ messages: [] }) };
    },
    createRenderPipeline(d: { label: string }) {
      log.push(`sync ${d.label}`);
      return pipeline('sync', d.label);
    },
    createComputePipeline(d: { label: string }) {
      log.push(`sync ${d.label}`);
      return pipeline('sync', d.label);
    },
  };
  if (opts.async !== false) {
    const later = (d: { label: string }): Promise<FakePipeline> => {
      log.push(`async ${d.label}`);
      return new Promise((resolve, reject) => {
        waiting.push(() => {
          if (opts.failAsync?.(d.label)) reject(new Error(`async creation of ${d.label} failed`));
          else resolve(pipeline('async', d.label));
        });
      });
    };
    device.createRenderPipelineAsync = later;
    device.createComputePipelineAsync = later;
  }
  /** Let every asynchronous creation started so far finish, and the promise chains run. */
  const settle = async (): Promise<void> => {
    for (const w of waiting.splice(0)) w();
    for (let i = 0; i < 8; i++) await Promise.resolve();
  };
  return { device: device as unknown as GPUDevice, raw: device, log, modules, settle, waiting };
}

const render = (device: GPUDevice, label: string, module: GPUShaderModule): GPURenderPipeline =>
  device.createRenderPipeline({ label, layout: 'auto', vertex: { module, entryPoint: 'vs' } });

describe('tracked builds', () => {
  it('are built on first use and again when a chunk they included is replaced', () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    lib.register('a', 'fn a() {}');
    const t = lib.tracked(() => render(d.device, 'p', lib.createModule('p', '#include "a"\nfn vs() {}')));
    expect(d.log).toEqual([]);
    const first = t.get();
    expect(t.get()).toBe(first);
    expect(t.generation).toBe(1);
    lib.register('a', 'fn a() { }');
    expect(t.get()).not.toBe(first);
    expect(t.generation).toBe(2);
    expect(d.log).toEqual(['sync p', 'sync p']);
  });
});

describe('warm', () => {
  it('starts every pipeline of every item asynchronously, then builds the items by their ordinary get()', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    const own = Object.getOwnPropertyDescriptor(d.raw, 'createRenderPipeline');
    const a = lib.tracked(() => render(d.device, 'a', lib.createModule('a', 'fn vs() {}')));
    // Two pipelines from one module, and a compute pipeline.
    const b = lib.tracked(() => {
      const module = lib.createModule('b', 'fn vs() {}');
      return { back: render(d.device, 'b.back', module), none: render(d.device, 'b.none', module) };
    });
    const c = lib.tracked(() => d.device.createComputePipeline({ label: 'c', layout: 'auto', compute: { module: lib.createModule('c', 'fn main() {}'), entryPoint: 'main' } }));
    let done = false;
    const warm = lib.warm([a, b, c]).then(() => {
      done = true;
    });
    // All four are in flight before anything was created synchronously; nothing is built yet.
    expect(d.log).toEqual(['async a', 'async b.back', 'async b.none', 'async c']);
    expect(lib.warming()).toEqual({ pending: 4, total: 4 });
    // Pipelines on their way are outstanding shader work (a loading screen waits for them).
    expect(lib.pendingCompilations()).toBeGreaterThanOrEqual(4);
    expect(a.generation).toBe(0);
    expect(Object.getOwnPropertyDescriptor(d.raw, 'createRenderPipeline'), 'the device is as it was between the runs').toEqual(own);
    await d.settle();
    await warm;
    expect(done).toBe(true);
    expect(d.log.slice(4)).toEqual(['sync a', 'sync b.back', 'sync b.none', 'sync c']);
    expect(lib.warming()).toEqual({ pending: 0, total: 4 });
    // What get() returns is the synchronous creation's result, built once.
    expect((a.get() as unknown as FakePipeline).how).toBe('sync');
    expect((b.get().back as unknown as FakePipeline).label).toBe('b.back');
    expect([a.generation, b.generation, c.generation]).toEqual([1, 1, 1]);
    expect(d.log).toHaveLength(8);
    // One module per label although each build ran twice.
    expect(d.modules.sort()).toEqual(['a', 'b', 'c']);
    // Three modules and four pipelines were started, and nothing is outstanding.
    expect(lib.compilations()).toEqual({ pending: 0, total: 7 });
    expect(lib.pendingCompilations()).toBe(0);
  });

  it('costs nothing for an item that is built, and warms it again after one of its chunks was replaced', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    lib.register('x', 'fn x() {}');
    const a = lib.tracked(() => render(d.device, 'a', lib.createModule('a', '#include "x"\nfn vs() {}')));
    a.get();
    await lib.warm([a]);
    expect(d.log).toEqual(['sync a']);
    lib.register('x', 'fn x() { }');
    const warm = lib.warm([a]);
    expect(d.log).toEqual(['sync a', 'async a']);
    await d.settle();
    await warm;
    expect(d.log).toEqual(['sync a', 'async a', 'sync a']);
    expect(a.generation).toBe(2);
  });

  it('runs a build that reads from its own pipeline again once that pipeline exists', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    const t = lib.tracked(() => {
      const module = lib.createModule('m', 'fn vs() {}');
      const first = render(d.device, 'first', module);
      const layout = first.getBindGroupLayout(0) as unknown as string;
      return { first, layout, second: render(d.device, `second(${layout})`, module) };
    });
    const warm = lib.warm([t]);
    expect(d.log).toEqual(['async first']);
    await d.settle();
    expect(d.log).toEqual(['async first', 'async second(first.layout0)']);
    await d.settle();
    await warm;
    expect(d.log.slice(2)).toEqual(['sync first', 'sync second(first.layout0)']);
    expect(t.get().layout).toBe('first.layout0');
    expect(t.generation).toBe(1);
  });

  it('leaves a creation that fails asynchronously, and a build that throws, to get()', async () => {
    const d = fakeDevice({ failAsync: (label) => label === 'bad' });
    const lib = createShaderLibrary(d.device, () => {});
    const bad = lib.tracked(() => render(d.device, 'bad', lib.createModule('bad', 'fn vs() {}')));
    const warm = lib.warm([bad]);
    await d.settle();
    await warm;
    expect(d.log).toEqual(['async bad', 'sync bad']);
    expect((bad.get() as unknown as FakePipeline).how).toBe('sync');

    const broken = lib.tracked((): GPURenderPipeline => {
      throw new Error('no such layout');
    });
    await expect(lib.warm([broken])).rejects.toThrow('no such layout');
    // And the library still warms after that.
    const ok = lib.tracked(() => render(d.device, 'ok', lib.createModule('ok', 'fn vs() {}')));
    const again = lib.warm([ok]);
    await d.settle();
    await again;
    expect(ok.generation).toBe(1);
    await lib.warmed();
  });

  it('finds the pipelines again when a chunk was replaced while they were being created', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    lib.register('brdf', 'one');
    // The label carries the module's source, as the device would see it.
    const t = lib.tracked(() => {
      const code = lib.expand('lit', '#include "brdf"').code.includes('one') ? 'one' : 'two';
      return render(d.device, `lit:${code}`, lib.createModule('lit', '#include "brdf"\nfn vs() {}'));
    });
    const other = lib.tracked(() => render(d.device, 'other', lib.createModule('other', 'fn vs() {}')));
    const warm = lib.warm([t, other]);
    expect(d.log).toEqual(['async lit:one', 'async other']);
    // Another feature's init replaces the chunk before the creations have finished.
    lib.register('brdf', 'two');
    await d.settle();
    expect(d.log).toEqual(['async lit:one', 'async other', 'async lit:two']);
    await d.settle();
    await warm;
    // Nothing was compiled synchronously that had not been created ahead with the same source.
    expect(d.log.slice(3)).toEqual(['sync lit:two', 'sync other']);
    expect((t.get() as unknown as FakePipeline).label).toBe('lit:two');
    expect(t.generation).toBe(1);
  });

  it('does not keep what an inner item builds during the run that finds the pipelines', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    const inner = lib.tracked(() => render(d.device, 'inner', lib.createModule('inner', 'fn vs() {}')));
    const outer = lib.tracked(() => ({ inner: inner.get(), own: render(d.device, 'outer', lib.createModule('outer', 'fn vs() {}')) }));
    const warm = lib.warm([outer]);
    expect(d.log).toEqual(['async inner', 'async outer']);
    expect(inner.generation, 'the inner item is not built by the run for warm').toBe(0);
    await d.settle();
    await warm;
    expect(inner.generation).toBe(1);
    expect((inner.get() as unknown as FakePipeline).how).toBe('sync');
    expect((outer.get().inner as unknown as FakePipeline).how).toBe('sync');
  });

  it('is the plain get() on a device without asynchronous creation, and for an item its owner built meanwhile', async () => {
    const plain = fakeDevice({ async: false });
    const lib = createShaderLibrary(plain.device, () => {});
    const a = lib.tracked(() => render(plain.device, 'a', lib.createModule('a', 'fn vs() {}')));
    await lib.warm([a]);
    expect(plain.log).toEqual(['sync a']);

    const d = fakeDevice();
    const lib2 = createShaderLibrary(d.device, () => {});
    const b = lib2.tracked(() => render(d.device, 'b', lib2.createModule('b', 'fn vs() {}')));
    const warm = lib2.warm([b]);
    // A frame is rendered before the asynchronous creation has finished.
    const early = b.get();
    await d.settle();
    await warm;
    expect(b.get()).toBe(early);
    expect(d.log).toEqual(['async b', 'sync b']);
    expect(b.generation).toBe(1);
  });

  it('warmed() waits for every warm started so far', async () => {
    const d = fakeDevice();
    const lib = createShaderLibrary(d.device, () => {});
    const a = lib.tracked(() => render(d.device, 'a', lib.createModule('a', 'fn vs() {}')));
    const b = lib.tracked(() => render(d.device, 'b', lib.createModule('b', 'fn vs() {}')));
    void lib.warm([a]);
    void lib.warm([b]);
    let all = false;
    void lib.warmed().then(() => {
      all = true;
    });
    for (let i = 0; i < 8; i++) await Promise.resolve();
    expect(all).toBe(false);
    await d.settle();
    await lib.warmed();
    expect([a.generation, b.generation]).toEqual([1, 1]);
  });
});
