/**
 * window.__test: the automation surface exposed by the app (and, in reduced form, by every lab page).
 *
 * Rules:
 *  - Read-only with respect to physics. There are NO setters for vehicle state, propellant or time.
 *    `controls` and `commands` are the same objects the keyboard layer drives.
 *  - Anything that would void a mission proof goes through Sim.debug and increments cheatCounter,
 *    which mission tests assert to be zero.
 *  - Camera/view helpers and deterministic-render helpers are allowed: they do not touch the sim.
 */
import type { AudioProbe } from './audio';
import type { ControlInputs, PlayerCommands } from './controls';
import type { CameraState, PerfSnapshot, ViewMode } from './render';
import type { MilestoneRecord, SimSnapshot } from './sim';
import type { MapElementInfo } from './ui';

export interface AdapterReport {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
  isFallbackAdapter: boolean;
  features: string[];
  limits: Record<string, number>;
}

export interface TestApi {
  /** Resolves true when the app is fully initialised (device, assets, first frame presented). */
  ready: Promise<boolean>;
  /** Window errors, unhandled rejections, GPU uncaptured errors, shader compile errors, device loss. */
  errors: string[];
  adapter: AdapterReport | null;
  /** Latest simulation snapshot (deep-frozen copy safe to serialise). Null on pages without a sim. */
  state(): SimSnapshot | null;
  milestones(): MilestoneRecord[];
  /** True when no tile fetch/upload, shader compile or asset decode is pending. */
  isIdle(): boolean;
  /** Resolves after `n` frames have been presented. */
  waitFrames(n: number): Promise<void>;
  perf(): PerfSnapshot | null;
  resetPerf(): void;
  /** Same sink the keyboard layer writes; values persist until changed (like held keys). */
  setControls(inputs: Partial<ControlInputs>): void;
  commands: PlayerCommands | null;
  /** Scripted pilot control (the same pilot used headless; only available when a sim is running). */
  pilot: { start(): void; stop(): void; phase(): string | null; done(): boolean; failure(): string | null } | null;
  /** View helpers (do not affect physics). */
  setView(mode: ViewMode): void;
  camera(): CameraState | null;
  /** Orbit the chase/map camera: yaw/pitch in radians, distance in metres (clamped by the rig). */
  setCameraOrbit(yaw: number, pitch: number, distance: number): void;
  /** Freeze presentation-only animation (noise, TAA jitter sequence restart) for golden screenshots. */
  setDeterministic(on: boolean): void;
  /** Pause/resume the main loop without changing sim time semantics (sim simply does not advance). */
  setPaused(paused: boolean): void;
  hdrStats(): Promise<{ maxLuminance: number; meanLuminance: number; nanPixels: number }>;
  audio(): AudioProbe | null;
  map(): MapElementInfo[];
  /** Scenario/lab identification so tests can assert they are looking at the right page. */
  page: { kind: 'app' | 'lab'; name: string; scenarioId: string | null };
}

declare global {
  interface Window {
    __test?: TestApi;
    __perf?: PerfSnapshot;
  }
}
