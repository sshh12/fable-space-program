/**
 * The ordered checks of ARCHITECTURE 24 / frontend-ux 9.1, over an environment that the page reads from the
 * browser and the unit tests build from fakes (tests/unit/bench/gate.test.ts). In order: mobile or tablet,
 * WebGPU present, an adapter, not a fallback adapter, required features, required limits, device creation,
 * support APIs. The first failure is the reason; everything read up to it is in the report. The device the
 * gate creates is destroyed at once (the app acquires its own: src/core/gpu/device.ts).
 */
import { browserOf, fingerprintOf, FEATURE_WORDS, GATE_MIN_LIMITS, GATE_REQUIRED_FEATURES, gateClassify, isMobile, LIMIT_WORDS, type GateReason, type GateReport, type MobileSignals } from './report';

/** The slice of a GPUAdapter the gate reads. */
export interface GateAdapter {
  readonly features: { has(name: string): boolean; forEach(cb: (name: string) => void): void };
  readonly limits: object;
  readonly info?: { vendor?: string; architecture?: string; description?: string; isFallbackAdapter?: boolean };
  /** Older Chrome put it on the adapter. */
  readonly isFallbackAdapter?: boolean;
  requestDevice(desc?: object): Promise<{ destroy(): void }>;
}

export interface GateEnv {
  mobile: MobileSignals;
  /** navigator.gpu, or undefined where the browser has none. */
  gpu: { requestAdapter(opts?: object): Promise<GateAdapter | null> } | undefined;
  brands: readonly { brand: string; version: string }[] | undefined;
  /** Window size in CSS px and the device pixel ratio. */
  windowCss: [number, number];
  dpr: number;
  /** Support APIs (check 8): the first three block, audio only warns. */
  apis: { offscreenCanvas: boolean; worker: boolean; indexedDb: boolean; webSocket: boolean; audio: boolean };
}

/** What the gate decided, with what the page shows beside the game when it passes. */
export interface GateResult {
  report: GateReport;
  /** Missing features or limits (machine names), for the block page's list. */
  missing: string[];
  /** Non-blocking findings: a small window, no audio, a browser that is not tested. */
  warnings: string[];
}

/** Smallest window the menu is laid out for (frontend-ux 9.1 check 9): below it an overlay, not a block. */
export const MIN_WINDOW_CSS: readonly [number, number] = [1024, 600];

const limitValue = (limits: object, name: string): number | undefined => {
  const v = (limits as Record<string, unknown>)[name];
  return typeof v === 'number' ? v : undefined;
};

export async function runGate(env: GateEnv): Promise<GateResult> {
  const { browser, untested } = browserOf(env.brands, env.mobile.userAgent);
  const displayPx: [number, number] = [Math.round(env.windowCss[0] * env.dpr), Math.round(env.windowCss[1] * env.dpr)];
  const report: GateReport = {
    pass: false,
    reason: null,
    reasonText: null,
    vendor: '',
    architecture: '',
    adapterClass: 'unknown',
    features: [],
    limits: {},
    browser,
    untestedBrowser: untested,
    mobile: isMobile(env.mobile),
    displayPx,
    dpr: env.dpr,
    refreshHz: null,
    fingerprint: '',
  };
  const missing: string[] = [];
  const warnings: string[] = [];
  const done = (reason: GateReason | null, text: string | null): GateResult => {
    report.pass = reason === null;
    report.reason = reason;
    report.reasonText = text;
    report.fingerprint = fingerprintOf(report);
    return { report, missing, warnings };
  };

  if (report.mobile) return done('mobile', 'Phones and tablets are not supported: this needs a desktop computer with a graphics card.');
  if (!env.gpu) return done('noWebGpu', 'This browser has no WebGPU.');
  let adapter: GateAdapter | null = null;
  try {
    adapter = await env.gpu.requestAdapter({ powerPreference: 'high-performance' });
  } catch (e) {
    return done('noAdapter', `The browser refused a graphics adapter (${e instanceof Error ? e.message : String(e)}).`);
  }
  if (!adapter) return done('noAdapter', 'The browser returned no graphics adapter.');
  const info = adapter.info || {};
  report.vendor = info.vendor || '';
  report.architecture = info.architecture || '';
  report.adapterClass = gateClassify(report.vendor, report.architecture, info.description || '');
  adapter.features.forEach((f) => report.features.push(f));
  report.features.sort();
  for (const name of Object.keys(GATE_MIN_LIMITS)) {
    const v = limitValue(adapter.limits, name);
    if (v !== undefined) report.limits[name] = v;
  }
  if (info.isFallbackAdapter === true || adapter.isFallbackAdapter === true) return done('fallbackAdapter', 'The browser offers only a software graphics adapter.');

  for (const f of GATE_REQUIRED_FEATURES) if (!adapter.features.has(f)) missing.push(f);
  if (missing.length > 0) return done('missingFeature', `The graphics adapter lacks: ${missing.map((f) => FEATURE_WORDS[f] || f).join('; ')}.`);
  const low: string[] = [];
  for (const name of Object.keys(GATE_MIN_LIMITS)) {
    const have = limitValue(adapter.limits, name);
    const need = GATE_MIN_LIMITS[name]!;
    if (have !== undefined && have < need) {
      missing.push(name);
      low.push(`${LIMIT_WORDS[name] || name} (${name}: ${have}, needs ${need})`);
    }
  }
  if (low.length > 0) return done('lowLimits', `The graphics adapter is below the minimum for: ${low.join('; ')}.`);

  try {
    const requiredLimits: Record<string, number> = {};
    for (const name of Object.keys(GATE_MIN_LIMITS)) {
      const have = limitValue(adapter.limits, name);
      if (have !== undefined) requiredLimits[name] = have;
    }
    const device = await adapter.requestDevice({ label: 'gate', requiredFeatures: [...GATE_REQUIRED_FEATURES], requiredLimits });
    device.destroy();
  } catch (e) {
    return done('deviceFailed', `The graphics device could not be created (${e instanceof Error ? e.message : String(e)}).`);
  }

  const apis: string[] = [];
  if (!env.apis.offscreenCanvas || !env.apis.worker) apis.push('OffscreenCanvas in workers');
  if (!env.apis.indexedDb) apis.push('IndexedDB');
  if (!env.apis.webSocket) apis.push('WebSocket');
  if (apis.length > 0) {
    missing.push(...apis);
    return done('missingApi', `The browser lacks: ${apis.join(', ')}.`);
  }
  if (!env.apis.audio) warnings.push('This browser has no Web Audio: the game will be silent.');
  if (env.windowCss[0] < MIN_WINDOW_CSS[0] || env.windowCss[1] < MIN_WINDOW_CSS[1]) warnings.push(`The window is ${env.windowCss[0]} x ${env.windowCss[1]}; the game is laid out for at least ${MIN_WINDOW_CSS[0]} x ${MIN_WINDOW_CSS[1]}. Enlarge it or go full screen.`);
  if (report.untestedBrowser) warnings.push(`Not tested on this browser (${report.browser}). The game is built for desktop Chrome and Edge.`);
  return done(null, null);
}

/** The environment of the page this runs in. */
export function browserEnv(): GateEnv {
  const nav = navigator as Navigator & { userAgentData?: { mobile?: boolean; brands?: { brand: string; version: string }[] }; gpu?: GateEnv['gpu'] };
  const uaData = nav.userAgentData;
  const media = (q: string): boolean => typeof window.matchMedia === 'function' && window.matchMedia(q).matches;
  return {
    mobile: {
      userAgent: nav.userAgent,
      uaDataMobile: uaData ? uaData.mobile : undefined,
      platform: nav.platform,
      maxTouchPoints: nav.maxTouchPoints || 0,
      coarsePointer: media('(pointer: coarse)'),
      anyFinePointer: media('(any-pointer: fine)'),
    },
    gpu: 'gpu' in nav && nav.gpu ? nav.gpu : undefined,
    brands: uaData ? uaData.brands : undefined,
    windowCss: [window.innerWidth, window.innerHeight],
    dpr: window.devicePixelRatio || 1,
    apis: {
      offscreenCanvas: typeof OffscreenCanvas !== 'undefined',
      worker: typeof Worker !== 'undefined',
      indexedDb: typeof indexedDB !== 'undefined',
      webSocket: typeof WebSocket !== 'undefined',
      audio: typeof AudioContext !== 'undefined',
    },
  };
}
