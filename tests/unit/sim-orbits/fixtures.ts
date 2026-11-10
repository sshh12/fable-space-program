/** Shared fixtures for the sim-orbits cross-module tests: the real definition library and its body system. */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs } from '../../../src/core/defs/loader';
import { createBodySystem, type BodySystem } from '../../../src/sim/bodies/bodySystem';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

let cached: Promise<{ defs: DefLibrary; system: BodySystem }> | null = null;

export function loadWorld(): Promise<{ defs: DefLibrary; system: BodySystem }> {
  cached ??= loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs'))).then((defs) => ({ defs, system: createBodySystem(defs) }));
  return cached;
}

/** UT (s since J2000.0 = 2000-01-01T12:00:00, treated as UTC) of a UTC calendar instant. */
export function utOf(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return (Date.UTC(year, month - 1, day, hour, minute, second) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
}

/** Root (Earth) and the first attractor child (Moon) ids, discovered from data. */
export function mainIds(system: BodySystem): { root: string; moon: string; star: string } {
  const moon = system.body(system.rootId).childIds[0];
  if (!moon) throw new Error('fixture: root body has no attractor child');
  return { root: system.rootId, moon, star: system.starId };
}

export { repoRoot };
