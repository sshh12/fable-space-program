/**
 * The shared net cases under vitest. The same cases run in Chrome (tests/browser/net/net.spec.ts): one
 * module of cases, two runners.
 */
import { describe, it } from 'vitest';
import { ALL_CASES } from './cases';

describe('wire layer, shared cases (Node)', () => {
  for (const c of ALL_CASES) it(c.name, () => c.run(), c.timeoutMs ?? 30_000);
});
