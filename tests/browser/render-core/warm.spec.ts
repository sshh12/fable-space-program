/**
 * Pipelines created ahead (`shaders.warm`, request app-integration-11) on the real device: the items are built
 * when `warm` resolves, their pipelines draw, and the synchronous creation that `get()` then makes is answered
 * from the device's cache (the GPU process has nothing left to compile). Times of a control set created
 * synchronously are recorded beside it (out/core-support/warm.json).
 *
 *   node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/render-core/warm.spec.ts --project=functional
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertDiscreteGpu, expect, expectNoErrors, openPage, test } from '../harness';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

test('shaders.warm: items built, pipelines usable, the synchronous creation after it is a cache hit', async ({ page, pageLog }) => {
  test.setTimeout(300_000);
  await openPage(page, '/labs/render-core/?scene=pad&hud=0&paused=1');
  await assertDiscreteGpu(page);
  const r = await page.evaluate(async () => {
    const lab = window.__lab!;
    const core = lab.renderer.core;
    const device = lab.gpu.device;
    // A fragment shader that takes the backend a while, different for every item and every run (no cache
    // of an earlier run answers it).
    const nonce = Math.floor(performance.now() * 1000) % 100000;
    const heavy = (seed: number): string => {
      const lines: string[] = [];
      for (let k = 0; k < 260; k++) lines.push(`  c += sin(in.uv.xyx * ${(1 + k * 0.013 + seed * 1e-4).toFixed(5)} + c.zxy * ${(0.1 + (k % 7) * 0.07).toFixed(3)}) * ${(0.004 + ((k + seed) % 11) * 0.0007).toFixed(5)};`);
      return `@fragment fn fs(in: FullscreenOut) -> @location(0) vec4f {\n  var c = vec3f(${(seed % 97) / 97}, 0.5, 0.25);\n${lines.join('\n')}\n  return vec4f(c, 1.0);\n}`;
    };
    const item = (i: number) => core.fullscreenPipeline({ label: `warm.spec.${i}`, fragment: heavy(nonce + i), targets: [{ format: 'rgba16float' }] });
    const done = async (): Promise<number> => {
      const t = performance.now();
      await device.queue.onSubmittedWorkDone();
      return performance.now() - t;
    };
    const N = 6;
    await done();

    // Control: created synchronously, one after the other on the GPU process's main thread.
    const control = Array.from({ length: N }, (_, i) => item(i));
    let t0 = performance.now();
    for (const t of control) t.get();
    const syncCallMs = performance.now() - t0;
    const syncMs = syncCallMs + (await done());

    // Created ahead.
    const ahead = Array.from({ length: N }, (_, i) => item(100 + i));
    const before = core.shaders.warming().total;
    t0 = performance.now();
    const warm = core.shaders.warm(ahead);
    const pendingWhile = core.shaders.pendingCompilations();
    const generationsWhile = ahead.map((t) => t.generation);
    await warm;
    const warmMs = performance.now() - t0;
    // What is left for the GPU process after the items were built by their ordinary get().
    const afterMs = await done();
    const generations = ahead.map((t) => t.generation);
    const again = ahead.map((t) => t.get());
    const started = core.shaders.warming().total - before;

    // The same with `layout: 'auto'` (recorded: the device does not share such pipelines).
    const auto = Array.from({ length: N }, (_, i) =>
      core.shaders.tracked(() => {
        const module = core.shaders.createModule(`warm.spec.auto.${i}`, `#include "fullscreen"\n${heavy(nonce + 200 + i).replace('FullscreenOut', 'FullscreenOut')}`);
        return device.createRenderPipeline({ label: `warm.spec.auto.${i}`, layout: 'auto', vertex: { module, entryPoint: 'fullscreenVs' }, fragment: { module, entryPoint: 'fs', targets: [{ format: 'rgba16float' }] } });
      }),
    );
    t0 = performance.now();
    await core.shaders.warm(auto);
    const autoWarmMs = performance.now() - t0;
    const autoAfterMs = await done();

    // The pipelines draw: one triangle each into a small target, no validation error.
    device.pushErrorScope('validation');
    const target = device.createTexture({ size: [64, 64], format: 'rgba16float', usage: GPUTextureUsage.RENDER_ATTACHMENT });
    const encoder = device.createCommandEncoder();
    for (const p of again) {
      const pass = encoder.beginRenderPass({ colorAttachments: [{ view: target.createView(), loadOp: 'clear', storeOp: 'store' }] });
      pass.setPipeline(p);
      pass.setBindGroup(0, lab.renderer.frameContext!.frameBindGroup);
      pass.draw(3);
      pass.end();
    }
    device.queue.submit([encoder.finish()]);
    const error = await device.popErrorScope();
    target.destroy();
    return { syncCallMs, syncMs, warmMs, afterMs, autoWarmMs, autoAfterMs, pendingWhile, generationsWhile, generations, started, isPipeline: again.every((p) => p instanceof GPURenderPipeline), error: error ? error.message : null, idle: lab.renderer.isIdle() };
  });
  const dir = path.join(repoRoot, 'out', 'core-support');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'warm.json'), JSON.stringify(r, null, 1));
  console.log(`  six pipelines: synchronous ${r.syncMs.toFixed(0)} ms (the calls ${r.syncCallMs.toFixed(1)} ms); ahead ${r.warmMs.toFixed(0)} ms, left after it ${r.afterMs.toFixed(1)} ms; layout 'auto': ahead ${r.autoWarmMs.toFixed(0)} ms, left ${r.autoAfterMs.toFixed(1)} ms`);

  expect(r.started, 'asynchronous creations started').toBe(6);
  expect(r.pendingWhile, 'pipelines on their way count as compilations').toBeGreaterThanOrEqual(6);
  expect(r.generationsWhile).toEqual([0, 0, 0, 0, 0, 0]);
  expect(r.generations, 'built once, by warm').toEqual([1, 1, 1, 1, 1, 1]);
  expect(r.isPipeline).toBe(true);
  expect(r.error).toBeNull();
  // The synchronous creations of the same descriptors compile nothing: a small share of what the control
  // set cost (the bound is wide: the machine is shared).
  expect(r.afterMs, 'GPU work left after warm').toBeLessThan(0.3 * r.syncMs);
  await expectNoErrors(page, pageLog);
});
