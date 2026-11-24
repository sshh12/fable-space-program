/**
 * Shared fixtures of the solar-system suites: the shipped library (data/defs, three bodies) and the staged
 * Sun-rooted library (data/staged laid over data/defs by the loader's overlay source: 32 bodies), each with its
 * body system, built once per worker.
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DefLibrary } from '../../../src/core/contracts/defs';
import { fsDefSource } from '../../../src/core/defs/fsSource';
import { loadDefs, overlayDefSource } from '../../../src/core/defs/loader';
import { createBodySystem, type BodySystem } from '../../../src/sim/bodies/bodySystem';

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** The 32 bodies of ARCHITECTURE 8.1, by name. */
export const BODY_LIST = [
  'sun',
  'mercury',
  'venus',
  'earth',
  'mars',
  'jupiter',
  'saturn',
  'uranus',
  'neptune',
  'moon',
  'phobos',
  'deimos',
  'io',
  'europa',
  'ganymede',
  'callisto',
  'mimas',
  'enceladus',
  'tethys',
  'dione',
  'rhea',
  'titan',
  'iapetus',
  'miranda',
  'ariel',
  'umbriel',
  'titania',
  'oberon',
  'triton',
  'ceres',
  'pluto',
  'charon',
] as const;

export interface World {
  defs: DefLibrary;
  system: BodySystem;
}

let shipped: Promise<World> | null = null;
let staged: Promise<World> | null = null;

/** The library of data/defs as it ships (Earth at the root, the Sun a light). */
export function loadShipped(): Promise<World> {
  shipped ??= loadDefs(fsDefSource(path.join(repoRoot, 'data', 'defs'))).then((defs) => ({ defs, system: createBodySystem(defs) }));
  return shipped;
}

/** The staged Sun-rooted library: data/staged/bodies laid over data/defs (loader overlay source). */
export function loadStaged(): Promise<World> {
  staged ??= loadDefs(overlayDefSource(fsDefSource(path.join(repoRoot, 'data', 'defs')), fsDefSource(path.join(repoRoot, 'data', 'staged')))).then((defs) => ({
    defs,
    system: createBodySystem(defs),
  }));
  return staged;
}

/** UT (s since J2000.0 treated as UTC) of a UTC calendar instant. */
export function utOf(year: number, month: number, day: number, hour = 0, minute = 0, second = 0): number {
  return (Date.UTC(year, month - 1, day, hour, minute, second) - Date.UTC(2000, 0, 1, 12, 0, 0)) / 1000;
}
