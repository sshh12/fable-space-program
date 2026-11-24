/**
 * The capability gate's pure part (ARCHITECTURE 24, frontend-ux 9.1-9.2): the report, the adapter class, the
 * mobile rule, the browser family and the fingerprint. The gate runs inline before the main bundle, so it
 * imports NOTHING (tools/dev/boundaries.test.ts): the required features and limits and the class table are
 * copies of src/core/gpu/device.ts, and tests/unit/bench/gate.test.ts holds the two equal, and this report
 * assignable to the contract's `CapabilityReport` (src/core/contracts/net.ts).
 */

/** Why the gate blocks (the contract's `CapabilityReport.reason`). */
export type GateReason = 'mobile' | 'noWebGpu' | 'noAdapter' | 'fallbackAdapter' | 'missingFeature' | 'lowLimits' | 'deviceFailed' | 'missingApi';

/** Structurally the contract's `CapabilityReport` (net.ts). Only vendor, architecture, browser and the reason may leave the client. */
export interface GateReport {
  pass: boolean;
  reason: GateReason | null;
  reasonText: string | null;
  vendor: string;
  architecture: string;
  adapterClass: 'discrete' | 'integrated' | 'unknown';
  features: string[];
  limits: Record<string, number>;
  browser: string;
  untestedBrowser: boolean;
  mobile: boolean;
  displayPx: [number, number];
  dpr: number;
  refreshHz: number | null;
  fingerprint: string;
}

/** Copy of REQUIRED_FEATURES (src/core/gpu/device.ts). */
export const GATE_REQUIRED_FEATURES = ['float32-filterable', 'depth-clip-control', 'texture-compression-bc'] as const;

/** Copy of MIN_LIMITS (src/core/gpu/device.ts). */
export const GATE_MIN_LIMITS: Readonly<Record<string, number>> = {
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

/** Plain words for the block page (frontend-ux 9.7: "the list, in plain words"). */
export const FEATURE_WORDS: Readonly<Record<string, string>> = {
  'float32-filterable': 'filtered 32-bit float textures (float32-filterable)',
  'depth-clip-control': 'depth clip control (depth-clip-control)',
  'texture-compression-bc': 'the compressed texture format BC (texture-compression-bc)',
};
export const LIMIT_WORDS: Readonly<Record<string, string>> = {
  maxTextureDimension2D: 'large textures',
  maxTextureArrayLayers: 'texture arrays with many layers',
  maxBufferSize: 'large GPU buffers',
  maxStorageBufferBindingSize: 'large storage buffers',
  maxSampledTexturesPerShaderStage: 'many textures per shader',
  maxStorageBuffersPerShaderStage: 'many storage buffers per shader',
  maxStorageTexturesPerShaderStage: 'many storage textures per shader',
  maxColorAttachmentBytesPerSample: 'wide render targets',
  maxBindGroups: 'enough bind groups',
};

// Copy of the class table of src/core/gpu/device.ts (classifyAdapter).
const INTEL_DISCRETE = /^(xe-?hpg|xe2-?hpg|alchemist|battlemage|dg2)/;
const INTEL_INTEGRATED = /^(gen-?\d|xe-?lp|xe2-?lp|xe-?lpg|xe2-?lpg)/;
const INTEGRATED_VENDORS = /^(apple|qualcomm|arm|imagination|img-tec|mali|adreno|powervr)/;
const INTEGRATED_NAME = /\b(uhd|iris|hd graphics|radeon\(tm\) graphics|radeon graphics|radeon \d{3}m|vega \d+ graphics|swiftshader|llvmpipe|basic render)\b/i;
const DISCRETE_NAME = /\b(arc|geforce|rtx|gtx|quadro|radeon rx|radeon pro)\b/i;

/** The adapter class hint: the same rules as `classifyAdapter` of src/core/gpu/device.ts. */
export function gateClassify(vendor: string, architecture: string, description: string): GateReport['adapterClass'] {
  const v = vendor.toLowerCase();
  const a = architecture.toLowerCase();
  if (v === 'nvidia') return 'discrete';
  if (v === 'intel') {
    if (INTEL_DISCRETE.test(a)) return 'discrete';
    if (INTEL_INTEGRATED.test(a)) return 'integrated';
    if (description && DISCRETE_NAME.test(description)) return 'discrete';
    if (description && INTEGRATED_NAME.test(description)) return 'integrated';
    return 'unknown';
  }
  if (INTEGRATED_VENDORS.test(v)) return 'integrated';
  if (description && INTEGRATED_NAME.test(description)) return 'integrated';
  if (description && DISCRETE_NAME.test(description)) return 'discrete';
  return 'unknown';
}

/** What the mobile rule reads (frontend-ux 9.1 check 1, fact 3). */
export interface MobileSignals {
  userAgent: string;
  /** navigator.userAgentData?.mobile (undefined where the browser has no client hints). */
  uaDataMobile: boolean | undefined;
  platform: string;
  maxTouchPoints: number;
  /** matchMedia('(pointer: coarse)') and matchMedia('(any-pointer: fine)'). */
  coarsePointer: boolean;
  anyFinePointer: boolean;
}

const MOBILE_UA = /\b(Android|iPhone|iPod|iPad|Mobile|Windows Phone|webOS|BlackBerry|Opera Mini|IEMobile)\b/;

/**
 * Phone or tablet: the client hint, then the user-agent patterns, then iPadOS (a desktop user agent on
 * 'MacIntel' with a touch screen), then a coarse primary pointer with no fine pointer at all. WebGPU being
 * present says nothing: Chrome on Android and iPadOS Safari 26 have it.
 */
export function isMobile(s: MobileSignals): boolean {
  if (s.uaDataMobile === true) return true;
  if (MOBILE_UA.test(s.userAgent)) return true;
  if (s.platform === 'MacIntel' && s.maxTouchPoints > 1) return true;
  return s.coarsePointer && !s.anyFinePointer;
}

/** Browser family and major version from the client hints (or the user agent), and whether it is a tested one (desktop Chrome or Edge). */
export function browserOf(brands: readonly { brand: string; version: string }[] | undefined, userAgent: string): { browser: string; untested: boolean } {
  const list = brands || [];
  const pick = (name: string): string | null => {
    for (const b of list) if (b.brand === name) return b.version;
    return null;
  };
  const edge = pick('Microsoft Edge');
  if (edge) return { browser: `Edge ${edge}`, untested: false };
  const chrome = pick('Google Chrome');
  if (chrome) return { browser: `Chrome ${chrome}`, untested: false };
  for (const b of list) if (!/not.?a.?brand|chromium/i.test(b.brand)) return { browser: `${b.brand} ${b.version}`, untested: true };
  const m = /\b(Edg|Chrome|Firefox|Version)\/(\d+)/.exec(userAgent);
  if (!m) return { browser: 'unknown', untested: true };
  const family = m[1] === 'Edg' ? 'Edge' : m[1] === 'Version' ? 'Safari' : String(m[1]);
  const untested = !(family === 'Edge' || (family === 'Chrome' && !/\bOPR\//.test(userAgent)));
  return { browser: `${family} ${m[2]}`, untested };
}

/**
 * A 64-bit hash of a string as 16 hex digits: two 32-bit FNV-1a lanes with different offsets. Written with
 * Math.imul and no BigInt, no `?.` and no `??` anywhere in the gate: an old browser must still parse this
 * module to show its block page.
 */
export function hash64(text: string): string {
  let a = 0x811c9dc5;
  let b = 0x050c5d1f;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193);
    b = Math.imul(b ^ c, 0x01000193) ^ (a >>> 15);
  }
  const hex = (x: number): string => ('00000000' + (x >>> 0).toString(16)).slice(-8);
  return hex(a) + hex(b);
}

/**
 * The key the graphics settings are stored under (frontend-ux 9.6): vendor, architecture, features, the
 * required limits, the browser's major version, the display's pixel count in half-stop buckets and the
 * device pixel ratio. A new driver that changes none of these keeps the calibration.
 */
export function fingerprintOf(r: Pick<GateReport, 'vendor' | 'architecture' | 'features' | 'limits' | 'browser' | 'displayPx' | 'dpr'>): string {
  const m = /(\d+)/.exec(r.browser);
  const major = m ? m[1] : '0';
  const family = r.browser.split(' ')[0];
  const px = Math.max(1, r.displayPx[0] * r.displayPx[1]);
  const bucket = Math.round(2 * Math.log2(px));
  const limits = Object.keys(GATE_MIN_LIMITS)
    .map((k) => `${k}=${r.limits[k] || 0}`)
    .join(',');
  return hash64([r.vendor, r.architecture, [...r.features].sort().join(','), limits, `${family} ${major}`, bucket, r.dpr.toFixed(2)].join('|'));
}
