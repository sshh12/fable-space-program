/**
 * WebGPU adapter/device acquisition shared by the app and every lab page.
 *
 * Facts this encodes (docs/research/webgpu-harness.md, docs/research/v2/frontend-ux.md section 2):
 *  - The HARD failures stay errors: no WebGPU, no adapter, a fallback (software) adapter, a missing required
 *    feature or limit. Whether an integrated GPU, an older card or a laptop is enough is NOT decided here
 *    (ARCHITECTURE 24): `adapterClass` is a hint from the vendor and architecture tables, and the calibration
 *    on the real renderer decides (src/bench). Production Chrome leaves `adapter.info.description` empty, so
 *    a name test classed every Intel adapter, Arc included, as integrated; the description is used only when
 *    the browser gives one, and never alone against the architecture.
 *  - `powerPreference` is ignored by Chrome on Windows (crbug 369219127): a hybrid laptop may run on the
 *    iGPU; the class says so and the calibration measures it.
 *  - Limits default to the WebGPU minimums unless requested: everything the engine relies on is raised
 *    here and checked, with a clear message when the adapter falls short.
 *  - Uncaptured GPU errors and device loss are surfaced through `onError` (tests fail on any of them).
 * The inline capability gate (src/gate/classify.ts) holds the same table: it imports nothing, and
 * tests/unit/bench/gate.test.ts checks that both give the same class for every fixture.
 */
import type { CapabilityReport } from '../contracts/net';
import type { AdapterReport } from '../contracts/testApi';

/** The adapter class of ARCHITECTURE 24: a hint that seeds the preset before the calibration has run. */
export type AdapterClass = CapabilityReport['adapterClass'];

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
  /** The class hint of the adapter (`classifyAdapter`); never a reason to refuse it. */
  adapterClass: AdapterClass;
  /** navigator.gpu.getPreferredCanvasFormat() */
  canvasFormat: GPUTextureFormat;
  hasFeature(name: GPUFeatureName): boolean;
}

export interface AcquireOptions {
  /** Called for uncaptured GPU errors and device loss. */
  onError?: (message: string) => void;
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

/**
 * Vendor and architecture tables of the adapter class (frontend-ux 9.2). `adapter.info.architecture` is what
 * Chrome reports from its GPU list (lower case, e.g. 'blackwell', 'xe-hpg', 'gen-12lp', 'rdna-3'):
 *  - NVIDIA: every WebGPU-capable NVIDIA adapter is a discrete GPU (desktop or laptop).
 *  - Intel: the HPG architectures (Arc: Alchemist, Battlemage) are discrete; the LP / Gen ones integrated;
 *    an architecture the table does not know is 'unknown', never integrated by default.
 *  - AMD: the same architecture names cover desktop cards and APUs (RDNA 3 is the 7900 XTX and the 780M),
 *    so AMD is 'unknown' unless the browser gives a description that names an integrated part.
 *  - Apple, Qualcomm, ARM, Imagination: integrated.
 */
const INTEL_DISCRETE = /^(xe-?hpg|xe2-?hpg|alchemist|battlemage|dg2)/;
const INTEL_INTEGRATED = /^(gen-?\d|xe-?lp|xe2-?lp|xe-?lpg|xe2-?lpg)/;
const INTEGRATED_VENDORS = /^(apple|qualcomm|arm|imagination|img-tec|mali|adreno|powervr)/;
/** Only consulted when the browser fills `description` (developer flags, some drivers). */
const INTEGRATED_NAME = /\b(uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|radeon \d{3}m|vega \d+ graphics|swiftshader|llvmpipe|basic render)\b/i;
const DISCRETE_NAME = /\b(arc|geforce|rtx|gtx|quadro|radeon rx|radeon pro)\b/i;

/** The adapter class hint (ARCHITECTURE 24): from the vendor and the architecture, a filled description only refining it. */
export function classifyAdapter(report: Pick<AdapterReport, 'vendor' | 'architecture' | 'description'>): AdapterClass {
  const vendor = report.vendor.toLowerCase();
  const arch = report.architecture.toLowerCase();
  const name = report.description;
  if (vendor === 'nvidia') return 'discrete';
  if (vendor === 'intel') {
    if (INTEL_DISCRETE.test(arch)) return 'discrete';
    if (INTEL_INTEGRATED.test(arch)) return 'integrated';
    if (name && DISCRETE_NAME.test(name)) return 'discrete';
    if (name && INTEGRATED_NAME.test(name)) return 'integrated';
    return 'unknown';
  }
  if (INTEGRATED_VENDORS.test(vendor)) return 'integrated';
  if (name && INTEGRATED_NAME.test(name)) return 'integrated';
  if (name && DISCRETE_NAME.test(name)) return 'discrete';
  return 'unknown';
}

export async function acquireGpu(opts: AcquireOptions = {}): Promise<GpuHandle> {
  if (!('gpu' in navigator) || !navigator.gpu) {
    throw new GpuUnavailableError('WebGPU is not available. This simulator needs desktop Chrome or Edge with WebGPU on a dedicated GPU.');
  }
  const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
  if (!adapter) throw new GpuUnavailableError('No WebGPU adapter was returned by the browser.');

  const pre = describeAdapter(adapter, null);
  if (pre.isFallbackAdapter) {
    throw new GpuUnavailableError(
      'The browser offers only a software (fallback) WebGPU adapter. Update the graphics driver; on a laptop set the browser to ' +
        '"High performance" in Windows Settings > System > Display > Graphics, then restart the browser.',
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
    adapterClass: classifyAdapter(report),
    canvasFormat: navigator.gpu.getPreferredCanvasFormat(),
    hasFeature: (name) => device.features.has(name),
  };
}
