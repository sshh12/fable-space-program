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
import type { AssemblyView, CensusEntry, FeedEvent, LinkState, PadState, Prompt, RosterEntry, ShipRecord, TimeView, UniverseRules } from './net';
import type { CameraState, PerfSnapshot, ViewMode } from './render';
import type { MilestoneRecord, SimSnapshot } from './sim';
import type { MapElementInfo } from './ui';

/** What a test may read of a network session (v2). Counters are since the session started. */
export interface NetProbe {
  link: LinkState;
  time: TimeView | null;
  /** Re-timings of a predicted state or command (ARCHITECTURE 6.4): allowed, counted. */
  corrections: number;
  /** Commands that were shown and then did not happen: must stay 0. */
  reversals: number;
  /** Largest position correction applied to the pilot's own vessel, m. */
  maxCorrection: number;
  bytesIn: number;
  bytesOut: number;
}

/** A serialisable copy of the client stores (v2), for assertions in browser tests. */
export interface StoresDump {
  census: CensusEntry[];
  pads: PadState[];
  ships: ShipRecord[];
  assembly: AssemblyView | null;
  roster: RosterEntry[];
  rules: UniverseRules;
  feed: FeedEvent[];
  prompts: Prompt[];
  link: LinkState;
}

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
  /**
   * Pause/resume the main loop without changing sim time semantics (the session simply does not advance).
   * v2: LOCAL ONLY. Nothing pauses in a shared universe: on a network session this stops presentation only,
   * and a test that needs a quiet moment holds the clock instead.
   */
  setPaused(paused: boolean): void;
  hdrStats(): Promise<{ maxLuminance: number; meanLuminance: number; nanPixels: number }>;
  audio(): AudioProbe | null;
  map(): MapElementInfo[];
  /** Scenario/lab identification so tests can assert they are looking at the right page. */
  page: { kind: 'app' | 'lab'; name: string; scenarioId: string | null };
  /**
   * v2, optional until the app integrations fill them (wave 4.5 and 5.3): which session the page runs
   * ('local' = an in-process universe, 'net' = the network replica; null = no session), the network probe
   * (null on a local session) and a copy of the client stores (null without stores).
   */
  sessionKind?: 'local' | 'net' | null;
  net?(): NetProbe | null;
  stores?(): StoresDump | null;
}

declare global {
  interface Window {
    __test?: TestApi;
    __perf?: PerfSnapshot;
  }
}
