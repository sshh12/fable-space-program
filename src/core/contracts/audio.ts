/**
 * Audio contracts. The audio engine (src/audio) is a pure consumer of SimSnapshot + listener state.
 */
import type { Vec3 } from '../math/vec3';
import type { DefLibrary } from './defs';
import type { ViewKind, ViewMode } from './render';
import type { SimSnapshot } from './sim';

export type AudioBusName = 'engines' | 'aero' | 'reentry' | 'events' | 'cabin' | 'ui' | 'master';

export interface AudioListener {
  mode: ViewMode;
  /** Branch on this, not on `mode`: 'interior' = cabin mix, 'external' and 'map' = outside listener. */
  kind: ViewKind;
  /** Vessel the listener is inside (cockpit) or null for an external camera. */
  insideVesselId: string | null;
  /** Listener position in the active vessel's VES frame, m (external cameras: where the chase camera is). */
  positionVes: Vec3;
  /** Listener forward and up in VES axes (for panning). */
  forwardVes: Vec3;
  upVes: Vec3;
  /** Ambient static pressure at the listener, Pa (0 in vacuum: airborne sound cannot reach it). */
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
