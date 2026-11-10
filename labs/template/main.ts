/**
 * Lab page template (lead-owned). Copy this directory to labs/<your-package>/ and replace the drawing code.
 *
 * A lab is a small page that exercises ONE package in isolation in the real browser, driven by the FakeSim
 * (or, once it exists, the real sim) so it can be screenshotted and measured by a Playwright spec in
 * tests/browser/<your-package>/. Labs are served by the dev server at /labs/<name>/ and are not part of the
 * production build.
 *
 * Query parameters used by convention:  ?scene=<FakeScene>   &view=<mode>   plus anything package-specific.
 */
import { NEUTRAL_CONTROLS } from '@/core/contracts/controls';
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { createFakeSim, type FakeScene } from '@/core/fakes/fakeSim';
import { acquireGpu } from '@/core/gpu/device';
import { v3 } from '@/core/math';
import { installTestApi } from '@/core/testing/testApi';

const params = new URLSearchParams(location.search);
const scene = (params.get('scene') ?? 'lowOrbit') as FakeScene;
const testApi = installTestApi({ kind: 'lab', name: 'template', scenarioId: `fake-${scene}` });

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const info = document.getElementById('info') as HTMLDivElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);
  const context = canvas.getContext('webgpu')!;
  context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });
  canvas.width = Math.max(1, Math.round(canvas.clientWidth * devicePixelRatio));
  canvas.height = Math.max(1, Math.round(canvas.clientHeight * devicePixelRatio));

  const defs = await loadDefs(fetchDefSource());
  const sim = createFakeSim(defs, { scene });
  const controls = { ...NEUTRAL_CONTROLS, translate: v3.zero() };
  let snapshot = sim.snapshot();
  let paused = false;
  testApi.extend({
    state: () => structuredClone(snapshot),
    commands: sim.commands,
    setControls: (partial) => {
      Object.assign(controls, partial);
      sim.setControls(controls);
    },
    setPaused: (p) => {
      paused = p;
    },
  });

  let last = performance.now();
  const frame = (now: number): void => {
    const dt = Math.min(0.1, (now - last) / 1000);
    last = now;
    if (!paused) sim.advance(dt);
    snapshot = sim.snapshot();

    // Day/night tint from the sun direction at the vessel, so the page visibly reacts to the scene.
    const vessel = snapshot.vessels[0]!;
    const body = snapshot.bodies.find((b) => b.id === vessel.bodyId)!;
    const lit = Math.max(0, v3.dot(v3.normalize(vessel.r), body.sunDir));
    const encoder = gpu.device.createCommandEncoder();
    const pass = encoder.beginRenderPass({
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.02 + 0.1 * lit, g: 0.03 + 0.16 * lit, b: 0.06 + 0.3 * lit, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);

    const r = snapshot.readouts;
    info.textContent =
      `scene ${scene}   ut ${snapshot.ut.toFixed(1)}   warp x${snapshot.warp.factor}\n` +
      `alt ${(r.altitudeAsl / 1000).toFixed(1)} km   orbital ${r.speedOrbital.toFixed(0)} m/s   surface ${r.speedSurface.toFixed(0)} m/s\n` +
      `pitch ${snapshot.navball.pitchDeg.toFixed(1)}  hdg ${snapshot.navball.headingDeg.toFixed(1)}  throttle ${(r.throttle * 100).toFixed(0)}%`;
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(2);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    testApi.reportError(err instanceof Error ? err.message : String(err));
    testApi.markReady(false);
  },
);
