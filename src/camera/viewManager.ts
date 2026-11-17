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
import type { SimSnapshot, VesselSnapshot } from '@/core/contracts/sim';
import type { TerrainProvider } from '@/core/contracts/terrain';
import { observeFrame, rebaseHeldAt, rebaseSnapshot } from '@/core/access/frameAccess';
import { activeVesselOf } from '@/core/access/snapshotAccess';
import { FrameEpochTracker, rebasePoint } from '@/core/math/frame';
import { quat, type Quat } from '@/core/math/quat';
import { v3, type Vec3 } from '@/core/math/vec3';
import { slerpDir, smoothBlend, vesselComRoot, ZERO_CAMERA_INPUT } from './cameraMath';
import { buildAudioListener, buildLodObservers } from './listener';

export const VIEW_BLEND_SECONDS = 0.6;

/** A lens shift between two views (absent = none), a share `k` of the way from the first to the second. */
function blendShift(from: readonly [number, number] | undefined, to: readonly [number, number] | undefined, k: number): [number, number] {
  const a = from ?? [0, 0];
  const b = to ?? [0, 0];
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k];
}

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
  /**
   * The flight view the manager had to leave for the map because no flight view was available (the viewer
   * has no seat: every flight rig follows the active vessel). The map was not the player's choice then, so
   * the manager goes back as soon as a flight view is available again; null while the view is where the
   * player or the app put it.
   */
  let displaced: ViewMode | null = null;
  let activated = false;
  let last: CameraState | null = null;
  let lastSnapshot: SimSnapshot | null = null;
  let blend: { from: Frozen; t: number } | null = null;
  /** The epoch of the ROOT frame the presented camera (`last`) and its snapshot are held in. */
  const frameEpochs = new FrameEpochTracker();

  /**
   * The presented camera is a ROOT position of the snapshot it was computed from. When the origin has been
   * replaced since (a sphere-of-influence change), both are read in the new frame before a rig is activated
   * from the camera or a blend starts from it; a frame that cannot be reached from theirs (another session)
   * leaves nothing to start from, and the view cuts.
   */
  const followFrame = (s: SimSnapshot): void => {
    const change = observeFrame(frameEpochs, s.frame);
    if (change.kind === 'same' || !last) return;
    if (change.kind === 'drop' || !lastSnapshot) {
      last = null;
      lastSnapshot = null;
      blend = null;
      return;
    }
    const held = rebaseHeldAt(change.rebase, s.ut - lastSnapshot.ut);
    last = { ...last, positionRoot: rebasePoint(last.positionRoot, held) };
    lastSnapshot = rebaseSnapshot(lastSnapshot, held);
  };

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

  /** The camera relative to the active vessel of the snapshot it was computed from; null without one (nothing to blend about). */
  const freeze = (c: CameraState, s: SimSnapshot): Frozen | null => {
    const v = activeVesselOf(s);
    if (!v) return null;
    if (c.kind === 'interior') {
      return { kind: c.kind, pos: quat.rotateInv(v.q, v3.sub(c.positionRoot, v.rRoot)), q: quat.mul(quat.conj(v.q), c.qViewToRoot), state: c };
    }
    return { kind: c.kind, pos: v3.sub(c.positionRoot, vesselComRoot(v)), q: quat.clone(c.qViewToRoot), state: c };
  };
  const thaw = (f: Frozen, v: VesselSnapshot): { pos: Vec3; q: Quat } => {
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
    const from = last && lastSnapshot ? freeze(last, lastSnapshot) : null;
    blend = from ? { from, t: 0 } : null;
    mode = next;
    return true;
  };

  const flightModes = (s: SimSnapshot): ViewMode[] => rigs.filter((r) => kindOf(r, s) !== 'map').map((r) => r.mode);

  /** A switch the player or the app asked for: the view is then where they put it. */
  const choose = (next: ViewMode, s: SimSnapshot): boolean => {
    if (!switchTo(next, s)) return false;
    displaced = null;
    return true;
  };

  const handle = (pressed: ReadonlySet<ButtonAction>, s: SimSnapshot): void => {
    const current = byMode.get(mode)!;
    if (pressed.has('toggleMap')) {
      if (kindOf(current, s) === 'map') {
        const back = [lastFlightMode, ...flightModes(s)].find((m) => m !== null && byMode.has(m) && available(byMode.get(m)!, s));
        if (back) choose(back, s);
      } else {
        const map = rigs.find((r) => kindOf(r, s) === 'map' && available(r, s));
        if (map) choose(map.mode, s);
      }
    }
    if (pressed.has('cycleCamera') && kindOf(byMode.get(mode)!, s) !== 'map') {
      const list = flightModes(s);
      const i = list.indexOf(mode);
      for (let k = 1; k <= list.length; k++) {
        const cand = list[(i + k) % list.length]!;
        if (cand !== mode && available(byMode.get(cand)!, s)) {
          choose(cand, s);
          break;
        }
      }
    }
  };

  /**
   * The current rig is not available. Another flight view takes over (a vessel without a cabin is seen from
   * outside); when there is none (no seat) the map does, as a stand-in that `regain` leaves again.
   */
  const fallBack = (s: SimSnapshot): void => {
    const flight = flightModes(s).find((m) => available(byMode.get(m)!, s));
    const alt = flight ?? rigs.find((r) => available(r, s))?.mode;
    if (alt === undefined) return;
    const was = mode;
    const wasFlight = kindOf(byMode.get(was)!, s) !== 'map';
    if (switchTo(alt, s) && flight === undefined && wasFlight) displaced = was;
  };

  /** Back from the stand-in map to the flight view that was left (or another one) once a seat is there again. */
  const regain = (s: SimSnapshot): void => {
    if (displaced === null) return;
    if (kindOf(byMode.get(mode)!, s) !== 'map') {
      displaced = null;
      return;
    }
    const back = [displaced, ...flightModes(s)].find((m) => byMode.has(m) && available(byMode.get(m)!, s));
    if (back !== undefined && switchTo(back, s)) displaced = null;
  };

  const mix = (from: Frozen, to: CameraState, k: number, v: VesselSnapshot): CameraState => {
    const a = thaw(from, v);
    const pivot = vesselComRoot(v);
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
      // The lens shift moves with the blend; the exposure hint is the one of the view blended to (its rig
      // drives the exposure along the way). Neither is stated when neither view states it.
      ...(fs.lensShift || to.lensShift ? { lensShift: blendShift(fs.lensShift, to.lensShift, k) } : {}),
      ...(to.exposureHint !== undefined ? { exposureHint: to.exposureHint } : {}),
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
    setMode: (m, s) => {
      followFrame(s);
      return choose(m, s);
    },
    update(s, input, realDt, pressed) {
      followFrame(s);
      if (!activated) {
        let rig = byMode.get(mode)!;
        if (!available(rig, s)) {
          const alt = rigs.find((r) => available(r, s));
          if (!alt) throw new Error('createViewManager: no rig is available for this snapshot');
          // A session that starts without a seat (the menu, a spectator) opens on the map in place of the
          // flight view it was to start in, and takes that view when a seat is there.
          if (kinds.get(rig.mode) !== 'map' && kindOf(alt, s) === 'map') displaced = mode;
          rig = alt;
          mode = alt.mode;
        }
        rig.activate(null, s);
        activated = true;
      }
      if (pressed && pressed.size > 0) handle(pressed, s);
      // The current rig can become unavailable (vessel switched to debris without a cockpit; the seat was left).
      if (!available(byMode.get(mode)!, s)) fallBack(s);
      else regain(s);
      const rig = byMode.get(mode)!;
      const target = rig.update(s, input, realDt);
      kinds.set(rig.mode, target.kind);
      let camera = target;
      // A blend swings about the active vessel: without one (the seat was left mid-blend) the view cuts to the rig's.
      const pivotVessel = blend ? activeVesselOf(s) : null;
      if (blend && !pivotVessel) blend = null;
      if (blend && pivotVessel) {
        blend.t = Math.min(1, blend.t + Math.max(0, realDt) / blendSeconds);
        camera = mix(blend.from, target, smoothBlend(blend.t), pivotVessel);
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
