/**
 * The cheap copy of a vessel's complete dynamic state for a rollback ring (docs/ARCHITECTURE.md 7.2): a
 * capture is taken at a tick, the vessel is stepped on, and the capture is put back when the ticks since
 * must be re-run. Unlike the codec there are no bytes, no definition lookups and, while the vessel still
 * has the very structure cache the capture was taken under, no rebuild of it: the state is written back
 * into the vessel's own objects. The cache is derived from state (the crew alive, the hold of the clamps,
 * the shielding of parts), so one that was built since the capture describes a later state and is dropped.
 */
import { cloneVessel } from './assemble';
import type { Vessel } from './types';

/** A vessel's dynamic state at one instant. Opaque: put it back with `restoreVessel`. */
export interface VesselCapture {
  readonly state: Vessel;
  /** The vessel's structure cache when the capture was taken (null when it had none): kept at a restore only when the vessel still has this very object. */
  readonly struct: unknown;
}

/** Copy the complete dynamic state of a vessel (definitions are shared, the structure cache is not copied). */
export function captureVessel(vessel: Vessel): VesselCapture {
  return { state: cloneVessel(vessel), struct: vessel.struct };
}

/** Keys that hold shared definitions or derived caches: set by reference, never walked. */
const SHARED = new Set(['def', 'vehicle', 'struct']);

/** Write the values of `src` into `dst`, object by object, keeping every object of `dst` whose counterpart has the same shape. */
function writeInto(dst: Record<string, unknown>, src: Record<string, unknown>): void {
  for (const k of Object.keys(src)) {
    const s = src[k];
    const d = dst[k];
    if (SHARED.has(k) || s === null || typeof s !== 'object') dst[k] = s;
    else if (d !== null && typeof d === 'object' && Array.isArray(s) === Array.isArray(d) && (!Array.isArray(s) || s.length === (d as unknown[]).length)) {
      if (Array.isArray(s)) {
        const da = d as unknown[];
        for (let i = 0; i < s.length; i++) {
          const e = s[i] as unknown;
          if (e !== null && typeof e === 'object' && da[i] !== null && typeof da[i] === 'object') writeInto(da[i] as Record<string, unknown>, e as Record<string, unknown>);
          else da[i] = e !== null && typeof e === 'object' ? copy(e) : e;
        }
      } else writeInto(d as Record<string, unknown>, s as Record<string, unknown>);
    } else dst[k] = copy(s);
  }
  // A key the capture does not have (an optional field set since) goes.
  for (const k of Object.keys(dst)) if (!(k in src)) delete dst[k];
}

function copy(x: unknown): unknown {
  if (x === null || typeof x !== 'object') return x;
  if (Array.isArray(x)) return x.map(copy);
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(x as object)) {
    const v = (x as Record<string, unknown>)[k];
    out[k] = SHARED.has(k) ? v : copy(v);
  }
  return out;
}

/** True when the vessel still has the part set, the craft and the links the capture was taken with. */
function sameStructure(vessel: Vessel, c: Vessel): boolean {
  if (vessel.parts.length !== c.parts.length || vessel.crafts.length !== c.crafts.length || vessel.links.length !== c.links.length) return false;
  for (let i = 0; i < c.parts.length; i++) {
    const a = vessel.parts[i]!;
    const b = c.parts[i]!;
    if (a.def !== b.def || a.instanceId !== b.instanceId || a.craft !== b.craft || a.parent !== b.parent) return false;
  }
  for (let i = 0; i < c.crafts.length; i++) if (vessel.crafts[i]!.craftId !== c.crafts[i]!.craftId || vessel.crafts[i]!.vehicle !== c.crafts[i]!.vehicle) return false;
  for (let i = 0; i < c.links.length; i++) if (vessel.links[i]!.a !== c.links[i]!.a || vessel.links[i]!.b !== c.links[i]!.b) return false;
  const x = vessel.carried;
  const y = c.carried;
  if ((x === null) !== (y === null)) return false;
  return x === null || y === null || (x.probes.length === y.probes.length && x.buoyWet.length === y.buoyWet.length && x.wake.length === y.wake.length);
}

/**
 * Put a capture back into the vessel it was taken from. The capture is not consumed: it can be put back
 * again. While the vessel has the part set of the capture its objects are kept, and its structure cache is
 * kept when it is the one the capture was taken under (every change of what the cache depends on replaces
 * the cache object: invalidateStructure); a cache built since is dropped and rebuilt on demand from the
 * restored state. After a structural change since the capture (a staging, a break-up, a dock) the vessel
 * takes the captured part set and its structure is rebuilt on demand.
 */
export function restoreVessel(vessel: Vessel, capture: VesselCapture): void {
  const c = capture.state;
  if (sameStructure(vessel, c)) {
    const struct = vessel.struct !== null && vessel.struct === capture.struct ? vessel.struct : null;
    writeInto(vessel as unknown as Record<string, unknown>, c as unknown as Record<string, unknown>);
    vessel.struct = struct;
    return;
  }
  const fresh = cloneVessel(c);
  for (const k of Object.keys(vessel)) delete (vessel as unknown as Record<string, unknown>)[k];
  Object.assign(vessel, fresh);
}
