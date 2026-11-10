/**
 * Application entry point (lead-owned). Boot order:
 *   1. install window.__test (error capture starts before anything can fail)
 *   2. acquire the high-performance WebGPU adapter and device, configure the canvas
 *   3. load the data-driven definitions
 *   4. run the frame loop
 * Subsystems (simulation, renderer features, HUD, audio) are attached here by the integration pass through
 * the contracts in src/core/contracts; this file must never reach into a subsystem's internals.
 */
import { fetchDefSource } from '@/core/defs/fetchSource';
import { loadDefs } from '@/core/defs/loader';
import { acquireGpu, GpuUnavailableError } from '@/core/gpu/device';
import { installTestApi } from '@/core/testing/testApi';

const testApi = installTestApi({ kind: 'app', name: 'main', scenarioId: null });

function showFatal(message: string): void {
  const box = document.getElementById('fatal');
  const text = document.getElementById('fatal-message');
  if (text) text.textContent = message;
  box?.classList.add('visible');
}

async function boot(): Promise<void> {
  const canvas = document.getElementById('viewport') as HTMLCanvasElement;
  const gpu = await acquireGpu({ onError: testApi.reportError });
  testApi.setAdapter(gpu.report);

  const context = canvas.getContext('webgpu');
  if (!context) throw new GpuUnavailableError('Could not create a WebGPU canvas context.');
  context.configure({ device: gpu.device, format: gpu.canvasFormat, alphaMode: 'opaque' });

  const resize = (): void => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.min(gpu.device.limits.maxTextureDimension2D, Math.round(canvas.clientWidth * dpr)));
    const h = Math.max(1, Math.min(gpu.device.limits.maxTextureDimension2D, Math.round(canvas.clientHeight * dpr)));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
  };
  new ResizeObserver(resize).observe(canvas);
  resize();

  const defs = await loadDefs(fetchDefSource('/defs'));
  document.documentElement.dataset['bodies'] = Object.keys(defs.bodies).sort().join(',');

  const frame = (): void => {
    const encoder = gpu.device.createCommandEncoder({ label: 'frame' });
    const pass = encoder.beginRenderPass({
      label: 'clear',
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.012, g: 0.016, b: 0.027, a: 1 },
          loadOp: 'clear',
          storeOp: 'store',
        },
      ],
    });
    pass.end();
    gpu.device.queue.submit([encoder.finish()]);
    testApi.frameDone();
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  await testApi.api.waitFrames(2);
}

boot().then(
  () => testApi.markReady(true),
  (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    testApi.reportError(message);
    showFatal(message);
    testApi.markReady(false);
  },
);
