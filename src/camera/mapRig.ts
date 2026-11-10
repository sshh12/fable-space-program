/**
 * Map rig (mode 'map', kind 'map'): detaches from the vessel and orbits a focus body or vessel.
 *
 * - Distance is measured from the focus SURFACE (the body radius, 0 for a vessel) and spans
 *   MAP_MIN_DISTANCE (100 km) .. MAP_MAX_DISTANCE (2e9 m) with exponential zoom (each wheel step multiplies it)
 *   smoothed in log space. Everything is float64 in the ROOT frame: at 2e9 m the eye still resolves
 *   sub-millimetre offsets from the focus.
 * - Orientation: azimuth about ROOT +Z (the root body's pole), elevation above the ROOT equator plane.
 * - Focus changes arrive through CameraInput.focusBodyId / focusVesselId (the app fills them from
 *   MapUpdateResult.focus). The pivot glides from the old focus to the new one over FOCUS_SECONDS with the
 *   C-infinity smooth step (both ends tracked live, so a moving Moon or vessel is followed throughout) and the
 *   distance eases to the new focus's default.
 * - Presentation: fill light 0.005 of the sun (night sides readable) and an exposure floor (minEv100).
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraState } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import { quat } from '@/core/math/quat';
import { DEG } from '@/core/math/scalar';
import { v3, type Vec3 } from '@/core/math/vec3';
import { activeVessel, approach, lookRotation, smoothBlend, vesselComRoot, type FlightCameraRig } from './cameraMath';

export const MAP_MIN_DISTANCE = 1e5;
export const MAP_MAX_DISTANCE = 2e9;
export const MAP_FILL_LIGHT = 0.005;
export const MAP_MIN_EV100 = 9;
export const MAP_FOCUS_SECONDS = 1.1;
const MAX_ELEVATION = 89.5 * DEG;

export interface MapRigOptions {
  defs: DefLibrary;
  fovY?: number;
  /** Exposure floor reported in CameraState.minEv100 (default MAP_MIN_EV100). */
  minEv100?: number;
}

export type MapFocus = { kind: 'body'; id: string } | { kind: 'vessel'; id: string };

const clamp = (x: number, lo: number, hi: number): number => (x < lo ? lo : x > hi ? hi : x);

export function createMapRig(opts: MapRigOptions): FlightCameraRig & {
  readonly focus: MapFocus | null;
  /** Distance from the focus surface, m. */
  readonly distance: number;
  setOrbit(azimuth: number, elevation: number, distance: number): void;
} {
  const defs = opts.defs;
  const fovY = opts.fovY ?? 50 * DEG;
  const minEv100 = opts.minEv100 ?? MAP_MIN_EV100;

  let focus: MapFocus | null = null;
  let logDist = Math.log(1e7);
  let logDistTarget = logDist;
  let azimuth = -90 * DEG;
  let elevation = 25 * DEG;
  let glide: { from: MapFocus; fromEyeDistance: number; t: number } | null = null;
  let pendingOrbit: { azimuth: number; elevation: number; distance: number } | null = null;

  const surfaceRadius = (f: MapFocus): number => (f.kind === 'body' ? (defs.bodies[f.id]?.radius ?? 0) : 0);

  /** Focus position in ROOT; a vessel or body that disappeared yields null. */
  const focusPos = (s: SimSnapshot, f: MapFocus): Vec3 | null => {
    if (f.kind === 'body') return s.bodies.find((b) => b.id === f.id)?.rRoot ?? null;
    const v = s.vessels.find((x) => x.id === f.id);
    return v ? vesselComRoot(v) : null;
  };

  /** A distance that frames the focus: a body with the active vessel's orbit, a vessel with its surroundings. */
  const defaultDistance = (s: SimSnapshot, f: MapFocus): number => {
    if (f.kind === 'vessel') return 2e6;
    const body = defs.bodies[f.id];
    const R = body?.radius ?? 1e6;
    const v = s.vessels.find((x) => x.id === s.activeVesselId);
    let reach = 1.6 * R;
    if (v && v.bodyId === f.id) {
      const ap = s.readouts.apoapsisAltitude;
      const alt = v3.len(v.r) - R;
      const far = Number.isFinite(ap) && ap > 0 ? Math.max(ap, alt) : alt;
      reach = Math.max(reach, R + far);
    }
    return clamp(2.4 * reach - R, MAP_MIN_DISTANCE, MAP_MAX_DISTANCE);
  };

  const setFocus = (s: SimSnapshot, next: MapFocus): void => {
    if (focus && focus.kind === next.kind && focus.id === next.id) return;
    if (focusPos(s, next) === null) return;
    if (focus && focusPos(s, focus) !== null) {
      // Keep the eye continuous: the glide starts at the current centre distance and the log distance is
      // re-based on the new focus surface.
      const eyeDist = Math.exp(logDist) + surfaceRadius(focus);
      logDist = Math.log(clamp(eyeDist - surfaceRadius(next), MAP_MIN_DISTANCE, MAP_MAX_DISTANCE));
      glide = { from: focus, fromEyeDistance: eyeDist, t: 0 };
    }
    focus = next;
    logDistTarget = Math.log(defaultDistance(s, next));
  };

  return {
    mode: 'map',
    kind: 'map',
    get focus() {
      return focus;
    },
    get distance() {
      return Math.exp(logDist);
    },
    isAvailable: () => true,
    setOrbit(az, el, dist) {
      pendingOrbit = { azimuth: az, elevation: el, distance: dist };
    },
    activate(from, s) {
      const v = activeVessel(s);
      if (!focus || focusPos(s, focus) === null) focus = { kind: 'body', id: v.bodyId };
      glide = null;
      const d = defaultDistance(s, focus);
      logDistTarget = Math.log(d);
      const pivot = focusPos(s, focus)!;
      if (from) {
        // Start on the ray through the previous eye so the zoom-out reads as one move.
        const rel = v3.sub(from.positionRoot, pivot);
        const len = v3.len(rel);
        if (len > 1) {
          azimuth = Math.atan2(rel.y, rel.x);
          elevation = clamp(Math.asin(clamp(rel.z / len, -1, 1)), -MAX_ELEVATION, MAX_ELEVATION);
          logDist = Math.log(clamp(len - surfaceRadius(focus), MAP_MIN_DISTANCE, MAP_MAX_DISTANCE));
          return;
        }
      }
      logDist = logDistTarget;
    },
    update(s: SimSnapshot, input: CameraInput, realDt: number): CameraState {
      if (!focus || focusPos(s, focus) === null) {
        focus = { kind: 'body', id: activeVessel(s).bodyId };
        logDistTarget = logDist = Math.log(defaultDistance(s, focus));
        glide = null;
      }
      if (input.focusVesselId) setFocus(s, { kind: 'vessel', id: input.focusVesselId });
      else if (input.focusBodyId) setFocus(s, { kind: 'body', id: input.focusBodyId });

      azimuth -= input.yaw;
      elevation = clamp(elevation - input.pitch, -MAX_ELEVATION, MAX_ELEVATION);
      if (input.zoom > 0 && Number.isFinite(input.zoom) && input.zoom !== 1) logDistTarget += Math.log(input.zoom);
      if (pendingOrbit) {
        azimuth = pendingOrbit.azimuth;
        elevation = clamp(pendingOrbit.elevation, -MAX_ELEVATION, MAX_ELEVATION);
        logDistTarget = logDist = Math.log(clamp(pendingOrbit.distance, MAP_MIN_DISTANCE, MAP_MAX_DISTANCE));
        pendingOrbit = null;
      }
      logDistTarget = clamp(logDistTarget, Math.log(MAP_MIN_DISTANCE), Math.log(MAP_MAX_DISTANCE));
      logDist += (logDistTarget - logDist) * approach(realDt, glide ? 0.35 : 0.14);

      let pivot = focusPos(s, focus)!;
      let eyeDistance = surfaceRadius(focus) + Math.exp(logDist);
      if (glide) {
        glide.t = Math.min(1, glide.t + Math.max(0, realDt) / MAP_FOCUS_SECONDS);
        const k = smoothBlend(glide.t);
        const fromPos = focusPos(s, glide.from);
        if (fromPos) pivot = v3.lerp(fromPos, pivot, k);
        eyeDistance = glide.fromEyeDistance + (eyeDistance - glide.fromEyeDistance) * k;
        if (glide.t >= 1) glide = null;
      }

      const c = Math.cos(elevation);
      const dir = { x: c * Math.cos(azimuth), y: c * Math.sin(azimuth), z: Math.sin(elevation) };
      const eye = v3.addScaled(pivot, dir, eyeDistance);
      const qViewToRoot = lookRotation(v3.neg(dir), v3.unitZ());
      return {
        mode: 'map',
        kind: 'map',
        positionRoot: eye,
        qViewToRoot: quat.normalize(qViewToRoot),
        fovY,
        insideVesselId: null,
        focusVesselId: focus.kind === 'vessel' ? focus.id : null,
        focusBodyId: focus.kind === 'body' ? focus.id : null,
        exposureCompensation: 0,
        minEv100,
        fillLight: MAP_FILL_LIGHT,
      };
    },
  };
}
