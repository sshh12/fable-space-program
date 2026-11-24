/**
 * The capability gate's entry (ARCHITECTURE 24; frontend-ux 9.1, 9.7). index.html runs it BEFORE the main
 * bundle and before any tile request:
 *
 *   <script type="module">import { startGate } from '/src/gate/index.ts'; startGate(() => import('/src/app/main.ts'));</script>
 *
 * On a pass it publishes the report at `window.__fspGate` (the app takes the adapter class, the fingerprint
 * and `safe` from it), shows the non-blocking warnings as a dismissible banner and only then loads the main
 * bundle. On a block it shows the block page and the main bundle is never requested: in a build it is a
 * chunk that only the gate's dynamic import names, and tools/server/gatePlugin.ts inlines this module into
 * the page. It imports nothing outside src/gate.
 *
 * Page switch: `?safe=1` (start at the Low preset without a calibration: the recovery after a crash; the
 * gate only passes it on in `window.__fspGate.safe`). The documents it reads are named in the page by
 * `<meta name="fsp-status" content="...">` and `<meta name="fsp-credits" content="...">`.
 */
import { browserEnv, runGate, type GateResult } from './checks';
import { showBanner, showBlockPage } from './page';
import type { GateReport } from './report';

/** What the gate leaves for the app at `window.__fspGate`. */
export interface GateHandoff {
  report: GateReport;
  warnings: string[];
  /** `?safe=1`: start at the Low preset with no calibration. */
  safe: boolean;
  /** Wall time the checks took, ms. */
  ms: number;
}

declare global {
  interface Window {
    __fspGate?: GateHandoff;
  }
}

const meta = (name: string, fallback: string): string => {
  const m = document.querySelector(`meta[name="${name}"]`);
  const v = m ? m.getAttribute('content') : null;
  return v || fallback;
};

/** Run the checks; on a pass load the main bundle, on a block show the block page. Resolves with the result. */
export async function startGate(loadMain: () => Promise<unknown>): Promise<GateResult> {
  const query = new URLSearchParams(location.search);
  const t0 = performance.now();
  const safe = query.get('safe') === '1';
  let result: GateResult;
  try {
    result = await runGate(browserEnv());
  } catch (e) {
    const report = emptyReport();
    report.pass = false;
    report.reason = 'deviceFailed';
    report.reasonText = `The capability check failed: ${e instanceof Error ? e.message : String(e)}`;
    result = { report, missing: [], warnings: [] };
  }
  window.__fspGate = { report: result.report, warnings: result.warnings, safe, ms: performance.now() - t0 };
  document.documentElement.dataset['gate'] = result.report.pass ? 'pass' : `blocked:${result.report.reason}`;
  if (!result.report.pass) {
    showBlockPage(result.report, { status: meta('fsp-status', '/status.json'), credits: meta('fsp-credits', '/defs/visuals/credits.json') });
    return result;
  }
  showBanner(result.warnings);
  await loadMain();
  return result;
}

function emptyReport(): GateReport {
  return {
    pass: false,
    reason: null,
    reasonText: null,
    vendor: '',
    architecture: '',
    adapterClass: 'unknown',
    features: [],
    limits: {},
    browser: 'unknown',
    untestedBrowser: false,
    mobile: false,
    displayPx: [Math.round(window.innerWidth * (window.devicePixelRatio || 1)), Math.round(window.innerHeight * (window.devicePixelRatio || 1))],
    dpr: window.devicePixelRatio || 1,
    refreshHz: null,
    fingerprint: '',
  };
}
