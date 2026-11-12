// Types of kepler.mjs for the TypeScript tests (tests/unit/bodies).
import type { OrbitDef, KeplerOrbitDef } from '../../../src/core/contracts/defs';

export type V3 = [number, number, number];
export type M3 = [V3, V3, V3];
export interface ToolState {
  r: V3;
  v: V3;
}
export interface OrbitContext {
  muSum?: number;
  parentPole?: { raDeg: number; decDeg: number } | null;
}

export const DEG: number;
export const OBLIQUITY_J2000_DEG: number;
export const AU_M: number;
export const DAY_S: number;
export const CENTURY_S: number;
export const JD_J2000: number;
/** TT - UTC (s): the game's clock is UTC-like, the ephemerides are TDB. */
export const TT_MINUS_UTC_S: number;
export function utToJd(ut: number): number;
export function jdToUt(jd: number): number;
export function len(a: V3): number;
export function norm(a: V3): V3;
export function sub(a: V3, b: V3): V3;
export function angleBetween(a: V3, b: V3): number;
export function matVec(A: M3, v: V3): V3;
export function poleFrame(raDeg: number, decDeg: number): M3;
export const ECLIPTIC_TO_ICRF: M3;
export function keplerState(def: KeplerOrbitDef, ut: number, ctx?: OrbitContext): ToolState;
export function sunLowPrecisionState(ut: number): ToolState;
export function orbitState(orbit: OrbitDef, ut: number, ctx?: OrbitContext): ToolState;
