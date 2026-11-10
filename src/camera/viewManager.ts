/**
 * View manager: owns the camera rigs, switches them on M (map toggle) and C (cycle the flight views), and
 * blends every switch over BLEND_SECONDS (0.6 s) in position, orientation and field of view, so the view
 * changes without a cut. Produces the frame's CameraState, LOD observers and AudioListener.
 *
 * Rigs are keyed by their open `mode` string. A rig of an unknown mode is treated by the `kind` of the
 * CameraState it produces (FlightCameraRig.kind when it states one; otherwise the manager asks it once with
 * a zero-time update): kind 'map' rigs are reached with M, every other rig is part of the C cycle.
 *
 * Blend: at the switch the presented camera is frozen relative to the active vessel (fixed in the vessel
 * frame for an interior view, translated with the vessel's centre of mass otherwise) and the new rig is
 * activated with it. The output is then a log-polar interpolation about the vessel's centre of mass: the
 * direction is slerped and the log of the distance interpolated, which keeps a 2 m cockpit -> 40 m chase move
 * and a 40 m chase -> 20,000 km map move equally smooth. The weight follows smoothBlend (all derivatives zero
 * at both ends): no step at the start or the end of a blend. mode / kind / insideVesselId switch at the
 * midpoint, so audio, HUD and exposure metering change when the eye passes the hull.
 */
import type { AudioListener } from '@/core/contracts/audio';
import type { ButtonAction } from '@/core/contracts/controls';
import type { DefLibrary } from '@/core/contracts/defs';
import type { CameraInput, CameraRig, CameraState, LodObserver, ViewKind, ViewMode } from '@/core/contracts/render';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { activeVessel, slerpDir, smoothBlend, vesselComRoot, ZERO_CAMERA_INPUT } from './cameraMath';
import { buildAudioListener, buildLodObservers } from './listener';

export const VIEW_BLEND_SECONDS = 0.6;

export interface ViewManagerOptions {
  defs: DefLibrary;
  /** Mode presented first (default: the first rig). */
  initialMode?: ViewMode;
  blendSeconds?: number;
  /** Used for the LOD observer altitude of vessels other than the active one. */
  terrain?: TerrainProvider;
}

export interface ViewFrame {
  /** Presented camera (blended during a switch). */
  camera: CameraState;
  /** This frame's output of the rig being switched to (equals `camera` outside a blend). */
  target: CameraState;
  observers: LodObserver[];
  listener: AudioListener;
}

export interface ViewManager {
  /** Mode switched to most recently (the presented camera may still be blending into it). */
  readonly mode: ViewMode;
  /** Registered modes in registration order. */
  readonly modes: readonly ViewMode[];
  readonly blending: boolean;
  /** Last presented camera (null before the first update). */
  readonly camera: CameraState | null;
  rig(mode: ViewMode): CameraRig | undefined;
  /** Switch to a rig (blended). Unknown or unavailable modes are ignored; returns whether it switched. */
  setMode(mode: ViewMode, snapshot: SimSnapshot): boolean;
  /**
   * One frame: handles 'toggleMap' / 'cycleCamera' in `pressed`, falls back to another flight view when the
   * current rig becomes unavailable, updates the rig(s) and builds the outputs.
   */
  update(snapshot: SimSnapshot, input: CameraInput, realDt: number, pressed?: ReadonlySet<ButtonAction>): ViewFrame;
}

interface Frozen {
  kind: ViewKind;
  /** Interior: eye and orientation in the vessel frame. Otherwise: offset from the CoM and ROOT orientation. */
  pos: Vec3;
  q: Quat;
  state: CameraState;
}

export function createViewManager(rigs: readonly CameraRig[], opts: ViewManagerOptions): ViewManager {
  if (rigs.length === 0) throw new Error('createViewManager: no rigs');
  const byMode = new Map<string, CameraRig>();
  for (const r of rigs) {
    if (byMode.has(r.mode)) throw new Error(`createViewManager: duplicate rig mode ${r.mode}`);
    byMode.set(r.mode, r);
  }
  const blendSeconds = opts.blendSeconds ?? VIEW_BLEND_SECONDS;
  const kinds = new Map<string, ViewKind>();
  for (const r of rigs) {
    const k = (r as { kind?: ViewKind }).kind;
    if (k === 'interior' || k === 'external' || k === 'map') kinds.set(r.mode, k);
  }

  let mode: ViewMode = opts.initialMode && byMode.has(opts.initialMode) ? opts.initialMode : rigs[0]!.mode;
  let lastFlightMode: ViewMode | null = null;
  let activated = false;
  let last: CameraState | null = null;
  let lastSnapshot: SimSnapshot | null = null;
  let blend: { from: Frozen; t: number } | null = null;

  const available = (r: CameraRig, s: SimSnapshot): boolean => {
    const f = (r as { isAvailable?: (s: SimSnapshot) => boolean }).isAvailable;
    return f ? f.call(r, s) : true;
  };
  const kindOf = (r: CameraRig, s: SimSnapshot): ViewKind => {
    let k = kinds.get(r.mode);
    if (!k) {
      k = r.update(s, ZERO_CAMERA_INPUT, 0).kind;
      kinds.set(r.mode, k);
    }
    return k;
  };

  const freeze = (c: CameraState, s: SimSnapshot): Frozen => {
    const v = activeVessel(s);
    if (c.kind === 'interior') {
      return { kind: c.kind, pos: quat.rotateInv(v.q, v3.sub(c.positionRoot, v.rRoot)), q: quat.mul(quat.conj(v.q), c.qViewToRoot), state: c };
    }
    return { kind: c.kind, pos: v3.sub(c.positionRoot, vesselComRoot(v)), q: quat.clone(c.qViewToRoot), state: c };
  };
  const thaw = (f: Frozen, s: SimSnapshot): { pos: Vec3; q: Quat } => {
    const v = activeVessel(s);
    if (f.kind === 'interior') return { pos: v3.add(v.rRoot, quat.rotate(v.q, f.pos)), q: quat.mul(v.q, f.q) };
    return { pos: v3.add(vesselComRoot(v), f.pos), q: f.q };
  };

  const switchTo = (next: ViewMode, s: SimSnapshot): boolean => {
    const rig = byMode.get(next);
    if (!rig || next === mode || !available(rig, s)) return false;
    const prevRig = byMode.get(mode);
    if (prevRig && kindOf(prevRig, s) !== 'map') lastFlightMode = mode;
    rig.activate(last, s);
    // Freeze against the snapshot the presented camera was computed from (the vessel has moved since).
    blend = last && lastSnapshot ? { from: freeze(last, lastSnapshot), t: 0 } : null;
    mode = next;
    return true;
  };

  const flightModes = (s: SimSnapshot): ViewMode[] => rigs.filter((r) => kindOf(r, s) !== 'map').map((r) => r.mode);

  const handle = (pressed: ReadonlySet<ButtonAction>, s: SimSnapshot): void => {
    const current = byMode.get(mode)!;
    if (pressed.has('toggleMap')) {
      if (kindOf(current, s) === 'map') {
        const back = [lastFlightMode, ...flightModes(s)].find((m) => m !== null && byMode.has(m) && available(byMode.get(m)!, s));
        if (back) switchTo(back, s);
      } else {
        const map = rigs.find((r) => kindOf(r, s) === 'map' && available(r, s));
        if (map) switchTo(map.mode, s);
      }
    }
    if (pressed.has('cycleCamera') && kindOf(byMode.get(mode)!, s) !== 'map') {
      const list = flightModes(s);
      const i = list.indexOf(mode);
      for (let k = 1; k <= list.length; k++) {
        const cand = list[(i + k) % list.length]!;
        if (cand !== mode && available(byMode.get(cand)!, s)) {
          switchTo(cand, s);
          break;
        }
      }
    }
  };

  const mix = (from: Frozen, to: CameraState, k: number, s: SimSnapshot): CameraState => {
    const a = thaw(from, s);
    const pivot = vesselComRoot(activeVessel(s));
    const ra = v3.sub(a.pos, pivot);
    const rb = v3.sub(to.positionRoot, pivot);
    const la = Math.max(v3.len(ra), 1e-3);
    const lb = Math.max(v3.len(rb), 1e-3);
    const dir = slerpDir(v3.scale(ra, 1 / la), v3.scale(rb, 1 / lb), k);
    const dist = Math.exp(Math.log(la) + (Math.log(lb) - Math.log(la)) * k);
    const second = k >= 0.5 ? to : from.state;
    const fs = from.state;
    return {
      mode: second.mode,
      kind: second.kind,
      positionRoot: v3.addScaled(pivot, dir, dist),
      qViewToRoot: quat.normalize(quat.slerp(a.q, to.qViewToRoot, k)),
      fovY: fs.fovY + (to.fovY - fs.fovY) * k,
      insideVesselId: second.insideVesselId,
      focusVesselId: second.focusVesselId,
      focusBodyId: second.focusBodyId,
      exposureCompensation: fs.exposureCompensation + (to.exposureCompensation - fs.exposureCompensation) * k,
      minEv100: fs.minEv100 !== null && to.minEv100 !== null ? fs.minEv100 + (to.minEv100 - fs.minEv100) * k : second.minEv100,
      fillLight: fs.fillLight + (to.fillLight - fs.fillLight) * k,
    };
  };

  return {
    get mode() {
      return mode;
    },
    modes: rigs.map((r) => r.mode),
    get blending() {
      return blend !== null;
    },
    get camera() {
      return last;
    },
    rig: (m) => byMode.get(m),
    setMode: (m, s) => switchTo(m, s),
    update(s, input, realDt, pressed) {
      if (!activated) {
        let rig = byMode.get(mode)!;
        if (!available(rig, s)) {
          const alt = rigs.find((r) => available(r, s));
          if (!alt) throw new Error('createViewManager: no rig is available for this snapshot');
          rig = alt;
          mode = alt.mode;
        }
        rig.activate(null, s);
        activated = true;
      }
      if (pressed && pressed.size > 0) handle(pressed, s);
      // The current rig can become unavailable (vessel switched to debris without a cockpit).
      if (!available(byMode.get(mode)!, s)) {
        const alt = flightModes(s).find((m) => available(byMode.get(m)!, s)) ?? rigs.find((r) => available(r, s))?.mode;
        if (alt) switchTo(alt, s);
      }
      const rig = byMode.get(mode)!;
      const target = rig.update(s, input, realDt);
      kinds.set(rig.mode, target.kind);
      let camera = target;
      if (blend) {
        blend.t = Math.min(1, blend.t + Math.max(0, realDt) / blendSeconds);
        camera = mix(blend.from, target, smoothBlend(blend.t), s);
        if (blend.t >= 1) {
          blend = null;
          camera = target;
        }
      }
      last = camera;
      lastSnapshot = s;
      return {
        camera,
        target,
        observers: buildLodObservers(opts.defs, s, camera, opts.terrain),
        listener: buildAudioListener(opts.defs, s, camera),
      };
    },
  };
}
