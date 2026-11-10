/**
 * WebGPU adapter/device acquisition shared by the app and every lab page.
 *
 * Facts this encodes (docs/research/webgpu-harness.md):
 *  - `powerPreference` is ignored by Chrome on Windows, so the adapter is verified after the fact and a
 *    non-discrete or fallback adapter is reported as an error instead of silently running on the iGPU.
 *  - Limits default to the WebGPU minimums unless requested: everything the engine relies on is raised
 *    here and checked, with a clear message when the adapter falls short.
 *  - Uncaptured GPU errors and device loss are surfaced through `onError` (tests fail on any of them).
 */
import type { AdapterReport } from '../contracts/testApi';

export class GpuUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GpuUnavailableError';
  }
}

/** Features the engine cannot run without. */
export const REQUIRED_FEATURES: GPUFeatureName[] = ['float32-filterable', 'depth-clip-control', 'texture-compression-bc'];

/** Features used when present (all are present on the target GPU). */
export const OPTIONAL_FEATURES: GPUFeatureName[] = [
  'timestamp-query',
  'rg11b10ufloat-renderable',
  'indirect-first-instance',
  'dual-source-blending',
  'float32-blendable',
  'clip-distances',
  'depth32float-stencil8',
  'shader-f16',
  'bgra8unorm-storage',
];

/** Minimum limits the engine is designed around; the device is created with max(adapter, these). */
export const MIN_LIMITS: Partial<Record<keyof GPUSupportedLimits, number>> = {
  maxTextureDimension2D: 8192,
  maxTextureArrayLayers: 2048,
  maxBufferSize: 1 << 30,
  maxStorageBufferBindingSize: 1 << 30,
  maxSampledTexturesPerShaderStage: 32,
  maxStorageBuffersPerShaderStage: 10,
  maxStorageTexturesPerShaderStage: 8,
  maxColorAttachmentBytesPerSample: 64,
  maxBindGroups: 4,
};

export interface GpuHandle {
  adapter: GPUAdapter;
  device: GPUDevice;
  report: AdapterReport;
  /** navigator.gpu.getPreferredCanvasFormat() */
  canvasFormat: GPUTextureFormat;
  hasFeature(name: GPUFeatureName): boolean;
}

export interface AcquireOptions {
  /** Called for uncaptured GPU errors and device loss. */
  onError?: (message: string) => void;
  /** Allow integrated / software adapters (never set in the shipped app; useful for nothing but diagnostics). */
  allowNonDiscrete?: boolean;
}

function describeAdapter(adapter: GPUAdapter, device: GPUDevice | null): AdapterReport {
  const info = adapter.info;
  const limits: Record<string, number> = {};
  const src = (device ?? adapter).limits as unknown as Record<string, unknown>;
  for (const k in src) {
    const v = src[k];
    if (typeof v === 'number') limits[k] = v;
  }
  return {
    vendor: info.vendor,
    architecture: info.architecture,
    device: info.device,
    description: info.description,
    isFallbackAdapter: Boolean((info as GPUAdapterInfo & { isFallbackAdapter?: boolean }).isFallbackAdapter),
    features: [...(device ?? adapter).features].sort(),
    limits,
  };
}

const INTEGRATED_HINT = /\b(uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|vega \d|swiftshader|llvmpipe|basic render)\b/i;

/** Heuristic: true when the adapter looks like an integrated or software GPU. */
export function looksIntegrated(report: AdapterReport): boolean {
  if (report.isFallbackAdapter) return true;
  if (report.vendor === 'intel') return !/\barc\b/i.test(report.description);
  return INTEGRATED_HINT.test(report.description);
}

export async function acquireGpu(opts: AcquireOptions = {}): Promise<GpuHandle> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError('WebGPU is not available. This simulator needs desktop Chrome or Edge with WebGPU on a dedicated GPU.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuUnavailableError('No WebGPU adapter was returned by the browser.');

  const pre = describeAdapter(adapter, null);
  if (!opts.allowNonDiscrete && looksIntegrated(pre)) {
    throw new GpuUnavailableError(
      `The browser selected "${pre.description || pre.vendor}" which looks like an integrated or software GPU. ` +
        'Set your browser to "High performance" in Windows Settings > System > Display > Graphics, then reload.',
    );
  }

  const missing = REQUIRED_FEATURES.filter((f) => !adapter.features.has(f));
  if (missing.length > 0) throw new GpuUnavailableError(`The GPU adapter lacks required WebGPU features: ${missing.join(', ')}`);

  const requiredLimits: Record<string, number> = {};
  const adapterLimits = adapter.limits as unknown as Record<string, number>;
  for (const [name, min] of Object.entries(MIN_LIMITS)) {
    const have = adapterLimits[name];
    if (have === undefined) continue;
    if (have < min) throw new GpuUnavailableError(`The GPU adapter limit ${name} = ${have} is below the required ${min}.`);
    requiredLimits[name] = have;
  }
  // Take the adapter maximum for a few more limits the tile pools and compute passes benefit from.
  for (const name of ['maxTextureDimension3D', 'maxComputeWorkgroupStorageSize', 'maxComputeInvocationsPerWorkgroup', 'maxUniformBufferBindingSize']) {
    const have = adapterLimits[name];
    if (have !== undefined) requiredLimits[name] = have;
  }

  const requiredFeatures = [...REQUIRED_FEATURES, ...OPTIONAL_FEATURES.filter((f) => adapter.features.has(f))];
  const device = await adapter.requestDevice({ label: 'fable-main', requiredFeatures, requiredLimits });

  device.addEventListener('uncapturederror', (ev) => {
    opts.onError?.(`GPU uncaptured error: ${(ev as GPUUncapturedErrorEvent).error.message}`);
  });
  void device.lost.then((info) => {
    if (info.reason !== 'destroyed') opts.onError?.(`GPU device lost (${info.reason}): ${info.message}`);
  });

  const report = describeAdapter(adapter, device);
  return {
    adapter,
    device,
    report,
    canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    hasFeature: (name) => device.features.has(name),
  };
}
