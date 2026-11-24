/**
 * What the shell receives from its host (the app, a lab, a test) and what it asks of it. src/shell imports only
 * src/core, so everything else arrives here: the session's stores and commands, the key tables of the input
 * contexts and their labels, the number rule, the boot progress, the live snapshot, the vehicle analysis, the
 * settings model, and a sink for the scrim rectangles. What the shell needs done outside the DOM (the camera's
 * framing and flights, the input context, the keyboard capture) it asks for as an intent.
 */
import type { DefLibrary } from '@/core/contracts/defs';
import type { UniverseRules } from '@/core/contracts/net';
import type { ClientStores, SpawnRequest, UniverseCommands } from '@/core/contracts/session';
import type { SimSnapshot } from '@/core/contracts/sim';
import type { SettingsModel } from '@/core/contracts/ui';
import type { VehicleCapabilities } from '@/core/contracts/vehicle';
import type { ScrimRect } from './dom/kit';
import type { NumberFormat } from './format';

/** One key of a context table (src/input/contexts.ts, structurally). */
export interface ShellKey {
  code: string;
  action: string;
}

export interface ShellKeys {
  menu: readonly ShellKey[];
  transit: readonly ShellKey[];
  /** The keys of the flight table's `flightMenu` action (the flight menu's prompt names them). */
  flightMenu: readonly string[];
  /** The label of a key code, as the HUD's key help shows it (`keyLabel`). */
  label(code: string): string;
  /** The flight table's reference card, grouped, its keys already labelled (`keyHelpEntries` of src/input): the controls reference renders it. */
  flightHelp: readonly { group: string; keys: readonly string[]; text: string }[];
}

/** The session the menu acts on: its stores and its universe commands (a NetSession's, a LocalSession's, a fixture's). */
export interface ShellSession {
  stores: ClientStores;
  universe: UniverseCommands;
}

/** One step of the cold start as the title's status line reports it (real progress, ARCHITECTURE 23, 29.2). */
export interface BootStep {
  label: string;
  done: number;
  total: number;
  finished: boolean;
}

export interface BootProgress {
  steps: readonly BootStep[];
  /** True when the hangar's data is resident: Play is enabled. */
  playReady: boolean;
}

/** The account service's answer for a callsign: free, taken (with free ones like it), or not a callsign (the service's words why). */
export type CallsignCheck = { status: 'available' } | { status: 'taken'; suggestions: string[] } | { status: 'invalid'; reason: string };

/**
 * The identity seam (ARCHITECTURE 25, decision 47; frontend-ux 5.4): the account's callsign (null until the
 * first Play creates the account), the service's check of a callsign, a callsign the service proposes, the
 * service's rule in words, and the account's creation (its recovery code, shown once).
 */
export interface IdentityHost {
  callsign(): string | null;
  check(name: string): Promise<CallsignCheck>;
  generate(): string;
  rule(): string;
  create(name: string): Promise<{ recoveryCode: string }>;
}

/** The settings the menu hosts (capability-settings owns what they are; the shell renders and edits them). */
export interface SettingsHost {
  model(): SettingsModel;
  /** Rows of the graphics section with their predicted cost, from the capability package's model; empty before it exists. */
  graphicsRows(): readonly { label: string; value: string; detail: string }[];
  change(patch: { audio?: Partial<SettingsModel['audio']>; controls?: Partial<SettingsModel['controls']>; interface?: Partial<SettingsModel['interface']> }): void;
  /** Re-run the calibration (Settings > Graphics), or null when the page cannot run it. */
  runCalibration: (() => void) | null;
}

/** What the shell asks of its host. */
export type ShellIntent =
  /** The input context to switch to (InputSystem.setContext). */
  | { kind: 'context'; context: 'menu' | 'transit' | 'flight' }
  /**
   * The camera's subject for a screen and the free area it should frame it into, CSS px of the viewport. For
   * 'turntable' `vehicleId` is the craft to show: always a PRESENTABLE vehicle (every part has a visual), never another.
   */
  | { kind: 'frame'; screen: string; subject: 'earth' | 'turntable' | 'site' | 'flight'; vehicleId: string | null; siteId: string | null; free: { x0: number; y0: number; x1: number; y1: number } }
  /** Begin the transit to a pad for this request (the spawn is in flight; `practice` = a LocalSession's). */
  | { kind: 'transit'; request: SpawnRequest; practice: boolean }
  /** The spawn was acknowledged (gate G1 of the transit). */
  | { kind: 'spawnAcknowledged'; vesselId: string }
  /** The transit is called off (refused, queued, or back while a gate held): the camera rises back to the menu. */
  | { kind: 'riseBack'; reason: string | null }
  | { kind: 'resume'; vesselId: string }
  /** Leave the flight: the reverse transit; the host calls `Shell.left()` when the camera is back at the menu. */
  | { kind: 'leave' }
  /** The player's explicit choice on the capture control (fullscreen and keyboard lock are opt-in). */
  | { kind: 'capture'; on: boolean }
  /** The turntable (Hangar, choose a craft): turn the display vessel by `turn` steps (+ = to the right) and zoom by `zoom` steps (+ = closer). */
  | { kind: 'turntable'; turn: number; zoom: number }
  | { kind: 'watchPad'; siteId: string; padId: string }
  | { kind: 'trackShip'; vesselId: string };

export interface ShellDeps {
  /** Where the shell's DOM goes: over the canvas. */
  root: HTMLElement;
  /** The canvas the scrim rectangles are measured against. */
  canvas: HTMLElement;
  defs: DefLibrary;
  format: NumberFormat;
  keys: ShellKeys;
  /** The lobby session (the menu fixture until netcode-client; then the NetSession). */
  lobby: ShellSession;
  /** Practice (offline): a LocalSession on the local rules; null when the page offers none. */
  practice: ShellSession | null;
  publishScrim(rects: readonly ScrimRect[]): void;
  boot(): BootProgress;
  /** The live snapshot (site solar views, the flight menu); null before the first frame. */
  snapshot(): SimSnapshot | null;
  /**
   * The analysis of a vehicle under the rules in force (`analyzeVehicle(defs, vehicle, { rules })` of fleet-data,
   * through the host, which may cache it): the read-outs, the reach ladder and the PAD CLASS, which is derived
   * there from the class limits of the rules and the vehicle's lift-off mass and diameter (or its pad interface).
   */
  capabilities(vehicleId: string, rules: UniverseRules): VehicleCapabilities;
  settings: SettingsHost | null;
  identity: IdentityHost | null;
  /** Mean pad cycle of the rules in force, s (launches per hour per class); null while the rules state none (request shell-menu-1). */
  padCycleSeconds(rules: UniverseRules): number | null;
  /** The capacity report of the lobby, when one is published (the Universe screen's slot); null otherwise. */
  capacityReport(): string | null;
  /** Wall clock, ms since the Unix epoch (My Ships' "last flown" and "kept for"). */
  wallNow(): number;
  /** The fullscreen and keyboard capture state the input system reports. */
  captured(): boolean;
  intent(i: ShellIntent): void;
  /** Report an error (window.__test.errors). */
  reportError(message: string): void;
  reducedMotion?: boolean;
  uiScale?: number;
}
