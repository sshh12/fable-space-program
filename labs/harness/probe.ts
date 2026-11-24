/**
 * The module that tests/browser/shell/harness-freeze.spec.ts saves during a run, to prove that the run's page
 * server goes on serving it as it was when the run started. The spec writes this file back; if it is ever
 * found saying anything but 'as-committed', restore that word.
 */
export const HARNESS_PROBE: string = 'as-committed';
