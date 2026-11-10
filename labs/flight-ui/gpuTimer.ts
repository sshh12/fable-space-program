/**
 * Lab GPU pass timer (a minimal PerfRecorder.gpuPass): hands out timestamp-query slots per named pass,
 * resolves them after the frame's submissions and keeps a rolling window of per-pass GPU milliseconds.
 */
import type { GpuHandle } from '@/core/gpu/device';

export interface GpuTimer {
  gpuPass(name: string): GPURenderPassTimestampWrites | undefined;
  /** Call once per frame after every submission that used gpuPass. */
  endFrame(): void;
  /** Samples (ms) per pass name since the last reset. */
  samples(): Record<string, number[]>;
  reset(): void;
}

const PAIRS = 8;

export function createGpuTimer(gpu: GpuHandle): GpuTimer {
  if (!gpu.hasFeature('timestamp-query')) {
    return { gpuPass: () => undefined, endFrame: () => undefined, samples: () => ({}), reset: () => undefined };
  }
  const device = gpu.device;
  const querySet = device.createQuerySet({ type: 'timestamp', count: PAIRS * 2 });
  const resolve = device.createBuffer({ size: PAIRS * 16, usage: GPUBufferUsage.QUERY_RESOLVE | GPUBufferUsage.COPY_SRC });
  const readback = device.createBuffer({ size: PAIRS * 16, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
  let names: string[] = [];
  let mapping = false;
  const out: Record<string, number[]> = {};

  return {
    gpuPass(name) {
      if (mapping || names.length >= PAIRS) return undefined;
      const i = names.length;
      names.push(name);
      return { querySet, beginningOfPassWriteIndex: 2 * i, endOfPassWriteIndex: 2 * i + 1 };
    },
    endFrame() {
      if (mapping || names.length === 0) {
        if (!mapping) names = [];
        return;
      }
      const used = names;
      names = [];
      const enc = device.createCommandEncoder({ label: 'lab.gpuTimer' });
      enc.resolveQuerySet(querySet, 0, used.length * 2, resolve, 0);
      enc.copyBufferToBuffer(resolve, 0, readback, 0, used.length * 16);
      device.queue.submit([enc.finish()]);
      mapping = true;
      readback.mapAsync(GPUMapMode.READ, 0, used.length * 16).then(
        () => {
          const t = new BigUint64Array(readback.getMappedRange(0, used.length * 16).slice(0));
          readback.unmap();
          used.forEach((n, i) => {
            const ms = Number(t[2 * i + 1]! - t[2 * i]!) / 1e6;
            if (ms >= 0 && ms < 100) (out[n] ??= []).push(ms);
          });
          mapping = false;
        },
        () => {
          mapping = false;
        },
      );
    },
    samples: () => out,
    reset() {
      for (const k of Object.keys(out)) delete out[k];
    },
  };
}
