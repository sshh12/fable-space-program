/**
 * The capability gate's classification tables (frontend-ux 14, ARCHITECTURE 24): fake navigator.gpu objects
 * lacking each feature or limit give the right reason; mobile and iPadOS fixtures give mobile; an Intel
 * adapter with an empty description is not classed integrated; the gate's copies of the device module's
 * tables are equal to them; the report is the contract's CapabilityReport.
 */
import { describe, expect, it } from 'vitest';
import type { CapabilityReport } from '@/core/contracts/net';
import { classifyAdapter, MIN_LIMITS, REQUIRED_FEATURES } from '@/core/gpu/device';
import { runGate, type GateAdapter, type GateEnv } from '@/gate/checks';
import { browserOf, fingerprintOf, GATE_MIN_LIMITS, GATE_REQUIRED_FEATURES, gateClassify, isMobile, type GateReport, type MobileSignals } from '@/gate/report';

const DESKTOP_UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const desktop: MobileSignals = { userAgent: DESKTOP_UA, uaDataMobile: false, platform: 'Win32', maxTouchPoints: 0, coarsePointer: false, anyFinePointer: true };
const BRANDS = [
  { brand: 'Google Chrome', version: '142' },
  { brand: 'Chromium', version: '142' },
  { brand: 'Not_A Brand', version: '24' },
];

/** A fake adapter of the reference machine, with features or limits taken away. */
function fakeAdapter(o: { without?: string[]; limits?: Record<string, number>; fallback?: boolean; deviceFails?: boolean; vendor?: string; architecture?: string } = {}): GateAdapter & { devices: number; destroyed: number } {
  const features = new Set(['float32-filterable', 'depth-clip-control', 'texture-compression-bc', 'timestamp-query', 'shader-f16'].filter((f) => !(o.without ?? []).includes(f)));
  const limits: Record<string, number> = { ...MIN_LIMITS, maxTextureDimension2D: 16384, ...o.limits } as Record<string, number>;
  const a = {
    devices: 0,
    destroyed: 0,
    features: { has: (n: string) => features.has(n), forEach: (cb: (n: string) => void) => features.forEach((f) => cb(f)) },
    limits,
    info: { vendor: o.vendor ?? 'nvidia', architecture: o.architecture ?? 'blackwell', description: '', isFallbackAdapter: o.fallback ?? false },
    async requestDevice() {
      if (o.deviceFails) throw new Error('out of memory');
      a.devices++;
      return { destroy: () => void a.destroyed++ };
    },
  };
  return a;
}

function env(adapter: GateAdapter | null | 'none', patch: Partial<GateEnv> = {}): GateEnv {
  return {
    mobile: desktop,
    gpu: adapter === 'none' ? undefined : { requestAdapter: async () => adapter },
    brands: BRANDS,
    windowCss: [2560, 1440],
    dpr: 1,
    apis: { offscreenCanvas: true, worker: true, indexedDb: true, webSocket: true, audio: true },
    ...patch,
  };
}

describe('gate checks, in order', () => {
  it('passes on the reference adapter and destroys the device it made', async () => {
    const a = fakeAdapter();
    const r = await runGate(env(a));
    expect(r.report.pass).toBe(true);
    expect(r.report.reason).toBeNull();
    expect(r.report.adapterClass).toBe('discrete');
    expect(r.report.fingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect([a.devices, a.destroyed]).toEqual([1, 1]);
    expect(r.warnings).toEqual([]);
  });
  it('no WebGPU, no adapter, a fallback adapter, a device that fails', async () => {
    expect((await runGate(env('none'))).report.reason).toBe('noWebGpu');
    expect((await runGate(env(null))).report.reason).toBe('noAdapter');
    expect((await runGate(env(fakeAdapter({ fallback: true })))).report.reason).toBe('fallbackAdapter');
    const failing = await runGate(env(fakeAdapter({ deviceFails: true })));
    expect(failing.report.reason).toBe('deviceFailed');
    expect(failing.report.reasonText).toContain('out of memory');
  });
  it.each(GATE_REQUIRED_FEATURES.map((f) => [f]))('an adapter without %s is missingFeature', async (feature) => {
    const r = await runGate(env(fakeAdapter({ without: [feature] })));
    expect(r.report.reason).toBe('missingFeature');
    expect(r.missing).toEqual([feature]);
    expect(r.report.reasonText).toContain(feature);
  });
  it.each(Object.entries(GATE_MIN_LIMITS))('an adapter with %s below %d is lowLimits', async (name, need) => {
    const r = await runGate(env(fakeAdapter({ limits: { [name]: need / 2 } })));
    expect(r.report.reason).toBe('lowLimits');
    expect(r.missing).toEqual([name]);
    expect(r.report.reasonText).toContain(`${name}: ${need / 2}, needs ${need}`);
  });
  it('the support APIs block, audio only warns, and so do a small window and an untested browser', async () => {
    for (const k of ['offscreenCanvas', 'worker', 'indexedDb', 'webSocket'] as const) {
      const r = await runGate(env(fakeAdapter(), { apis: { offscreenCanvas: true, worker: true, indexedDb: true, webSocket: true, audio: true, [k]: false } }));
      expect(r.report.reason).toBe('missingApi');
    }
    const quiet = await runGate(env(fakeAdapter(), { apis: { offscreenCanvas: true, worker: true, indexedDb: true, webSocket: true, audio: false }, windowCss: [900, 500], brands: [{ brand: 'Brave', version: '142' }] }));
    expect(quiet.report.pass).toBe(true);
    expect(quiet.report.untestedBrowser).toBe(true);
    expect(quiet.warnings).toHaveLength(3);
  });
  it('mobile comes first, before WebGPU is asked', async () => {
    let asked = false;
    const r = await runGate(env(null, { mobile: { ...desktop, uaDataMobile: true }, gpu: { requestAdapter: async () => ((asked = true), null) } }));
    expect(r.report.reason).toBe('mobile');
    expect(asked).toBe(false);
  });
});

describe('the mobile rule', () => {
  const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
  const ANDROID_TABLET = 'Mozilla/5.0 (Linux; Android 14; SM-X910) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
  const IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
  const IPADOS = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Safari/605.1.15';
  it.each([
    ['client hint', { ...desktop, uaDataMobile: true }],
    ['Android phone', { ...desktop, userAgent: ANDROID, uaDataMobile: undefined }],
    ['Android tablet', { ...desktop, userAgent: ANDROID_TABLET, uaDataMobile: false }],
    ['iPhone', { ...desktop, userAgent: IPHONE, uaDataMobile: undefined, platform: 'iPhone', maxTouchPoints: 5 }],
    ['iPadOS with a desktop user agent', { ...desktop, userAgent: IPADOS, uaDataMobile: undefined, platform: 'MacIntel', maxTouchPoints: 5 }],
    ['coarse pointer and no fine one', { ...desktop, coarsePointer: true, anyFinePointer: false }],
  ] as [string, MobileSignals][])('%s is mobile', (_name, s) => expect(isMobile(s)).toBe(true));
  it('a desktop, a Mac without a touch screen and a touch laptop with a mouse are not', () => {
    expect(isMobile(desktop)).toBe(false);
    expect(isMobile({ ...desktop, userAgent: IPADOS, platform: 'MacIntel', maxTouchPoints: 0, uaDataMobile: undefined })).toBe(false);
    expect(isMobile({ ...desktop, maxTouchPoints: 10, coarsePointer: true, anyFinePointer: true })).toBe(false);
  });
});

describe('the adapter class', () => {
  const FIXTURES: [vendor: string, architecture: string, description: string, cls: GateReport['adapterClass']][] = [
    ['nvidia', 'blackwell', '', 'discrete'],
    ['nvidia', 'turing', '', 'discrete'],
    ['intel', 'xe-hpg', '', 'discrete'],
    ['intel', 'xe2-hpg', '', 'discrete'],
    ['intel', '', '', 'unknown'],
    ['intel', 'gen-12lp', '', 'integrated'],
    ['intel', 'xe-lpg', '', 'integrated'],
    ['intel', '', 'Intel(R) Arc(TM) A770 Graphics', 'discrete'],
    ['intel', '', 'Intel(R) UHD Graphics 770', 'integrated'],
    ['amd', 'rdna-3', '', 'unknown'],
    ['amd', 'rdna-3', 'AMD Radeon(TM) Graphics', 'integrated'],
    ['amd', 'rdna-3', 'AMD Radeon RX 7900 XTX', 'discrete'],
    ['apple', 'metal-3', '', 'integrated'],
    ['qualcomm', 'adreno-7xx', '', 'integrated'],
    ['', '', '', 'unknown'],
  ];
  it.each(FIXTURES)('%s / %s / "%s" is %s, in the gate and in acquireGpu alike', (vendor, architecture, description, cls) => {
    expect(gateClassify(vendor, architecture, description)).toBe(cls);
    expect(classifyAdapter({ vendor, architecture, description })).toBe(cls);
  });
  it('an Intel adapter with an empty description is never integrated by default', () => {
    for (const arch of ['', 'xe-hpg', 'battlemage', 'something-new']) expect(gateClassify('intel', arch, '')).not.toBe('integrated');
  });
});

describe('the gate copies of the device tables and the report', () => {
  it('requires the same features and limits as acquireGpu', () => {
    expect([...GATE_REQUIRED_FEATURES]).toEqual(REQUIRED_FEATURES);
    expect(GATE_MIN_LIMITS).toEqual(MIN_LIMITS);
  });
  it('is the contract CapabilityReport', async () => {
    const r = await runGate(env(fakeAdapter()));
    const asContract: CapabilityReport = r.report;
    expect(asContract.pass).toBe(true);
  });
  it('the browser family and the fingerprint', () => {
    expect(browserOf([{ brand: 'Microsoft Edge', version: '142' }, { brand: 'Chromium', version: '142' }], '')).toEqual({ browser: 'Edge 142', untested: false });
    expect(browserOf(undefined, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:140.0) Gecko/20100101 Firefox/140.0')).toEqual({ browser: 'Firefox 140', untested: true });
    const base = { vendor: 'nvidia', architecture: 'blackwell', features: ['a', 'b'], limits: { ...GATE_MIN_LIMITS }, browser: 'Chrome 142', displayPx: [2560, 1440] as [number, number], dpr: 1 };
    const f = fingerprintOf(base);
    expect(fingerprintOf({ ...base, features: ['b', 'a'], browser: 'Chrome 142.1' })).toBe(f);
    expect(fingerprintOf({ ...base, displayPx: [2600, 1460] })).toBe(f);
    expect(fingerprintOf({ ...base, browser: 'Chrome 143' })).not.toBe(f);
    expect(fingerprintOf({ ...base, displayPx: [3840, 2160] })).not.toBe(f);
    expect(fingerprintOf({ ...base, architecture: 'ada' })).not.toBe(f);
  });
});
