/**
 * The harness's own page (lead-owned): it publishes what `./probe` says, and nothing else. See
 * tests/browser/shell/harness-freeze.spec.ts and tests/browser/globalSetup.ts ("frozen at the start").
 */
import { HARNESS_PROBE } from './probe';

(globalThis as unknown as { __harnessProbe?: string }).__harnessProbe = HARNESS_PROBE;
document.title = `Harness probe: ${HARNESS_PROBE}`;
