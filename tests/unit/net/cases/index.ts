/**
 * Every shared net case, in run order. The same list runs under vitest (tests/unit/net/shared.test.ts) and
 * in Chrome (tests/browser/net/net.spec.ts loads tests/browser/net/runner.html, which imports this module).
 */
import type { NetCase } from './assert';
import { codecCases } from './codecCases';
import { sessionCases } from './sessionCases';

export const ALL_CASES: NetCase[] = [...codecCases, ...sessionCases];
