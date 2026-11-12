/**
 * Audio contracts. The audio engine (src/audio) is a pure consumer of SimSnapshot + listener state.
 */
import type { Vec3 } from '../math/vec3';
import type { DefLibrary } from './defs';
import type { ViewKind, ViewMode } from './render';
import type { SimSnapshot } from './sim';

export type AudioBusName = 'engines' | 'aero' | 'reentry' | 'events' | 'cabin' | 'ui' | 'master';

/**
 * v2 buses: menu and flight music, and quick-comms (ARCHITECTURE 22).
 *
 * Not yet members of `AudioBusName`: `AudioProbe.buses` has one entry per bus and the engine builds it
 * (src/audio), so the lead joins this type to `AudioBusName` in the lead step before wave 4.1, when
 * `shell-menu` adds the buses.
 */
export type AudioBusNameV2 = 'music' | 'comms';

export interface AudioListener {
  mode: ViewMode;
  /** Branch on this, not on `mode`: 'interior' = cabin mix, 'external' and 'map' = outside listener. */
  kind: ViewKind;
  /** Vessel the listener is inside (cockpit) or null for an external camera. */
  insideVesselId: string | null;
  /**
   * Vessel an EXTERNAL rig rigidly follows (the chase rig, a later EVA third-person rig tethered to the ship):
   * the listener hears a faint structure-borne share of that vessel's sources, faded with its distance from
   * the vessel. `null` for a free or ground-fixed camera, for an interior listener (`insideVesselId` says
   * which hull it is coupled to) and for the map. Producers derive it from `CameraState.focusVesselId` of an
   * 'external' camera (src/camera/listener.ts); the audio engine never guesses attachment from distance.
   */
  attachedVesselId: string | null;
  /**
   * Listener position in the active vessel's VES frame, m (external cameras: where the chase camera is).
   * For `kind: 'map'` the audio engine ignores position, orientation and `ambientPressure`: a map camera is
   * 100 km or more away in vacuum, so the engine places a map listener where the last outside flight camera
   * of the active vessel was (with that camera's attachment), in that vessel's air; before any outside
   * camera was seen it uses the stand-in position of the audio mix data. Producers need no special case.
   */
  positionVes: Vec3;
  /** Listener forward and up in VES axes (for panning). */
  forwardVes: Vec3;
  upVes: Vec3;
  /**
   * Ambient static pressure at the listener, Pa (0 in vacuum: airborne sound cannot reach it). For
   * `kind: 'interior'` this is the static pressure OUTSIDE the hull at the listener, not the cabin pressure:
   * it scales the airborne path that reaches the cabin through the hull; cabin sounds always have cabin air.
   */
  ambientPressure: number;
}

export interface AudioFrame {
  snapshot: SimSnapshot;
  listener: AudioListener;
  realDt: number;
  /** Current time-warp factor; continuous sounds fade out above physics warp. */
  warpFactor: number;
  paused: boolean;
}

/** Levels measured by analysers on each bus, for automated tests (window.__test.audio()). */
export interface AudioProbe {
  state: AudioContextState | 'uninitialised';
  sampleRate: number;
  buses: Record<AudioBusName, { rms: number; peak: number; low: number; mid: number; high: number }>;
  /** Number of sound assets decoded / expected. */
  assetsLoaded: number;
  assetsTotal: number;
  activeVoices: number;
}

export interface AudioEngine {
  /**
   * Load and decode assets, build the graph. Sound definitions come from defs.sections ('audio/...').
   * Safe to call before a user gesture (context starts suspended).
   */
  init(defs: DefLibrary, assetsUrl: string): Promise<void>;
  /** Resume the AudioContext; call from the first real user gesture. */
  resume(): Promise<void>;
  update(frame: AudioFrame): void;
  setMasterVolume(volume: number): void;
  probe(): AudioProbe;
  dispose(): void;
}
