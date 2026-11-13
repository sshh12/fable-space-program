/**
 * What the page was asked for: the scenario, the scripted test pilot, the first view and a few presentation
 * switches for measurements. Everything here is presentation or test plumbing; nothing reaches physics except
 * the choice of scenario, which the simulation records in `SimSnapshot.scenario` (only a pad start with no
 * stage fired and `cheatCounter` 0 counts as a mission proof).
 *
 *   ?scenario=<id>        scenario to fly (default: the mission scenario of the definitions, see defaultScenario)
 *   &pilot=1              start the scripted test pilot (src/pilot) as soon as the page is ready (ARCHITECTURE 18.2)
 *   &view=chase|cockpit|map   first view (default chase)
 *   &capture=1            ask for fullscreen + keyboard lock on the first key press or click (default: the game
 *                         starts windowed and uncaptured, every binding works, and the player captures the keyboard
 *                         with the HUD's capture control when wanted)
 *   &pilotlabel=0         do not show the "TEST PILOT" status line while the scripted pilot flies (clean footage)
 *   &capturepill=0        do not show the HUD's keyboard-capture control (clean footage)
 *   &perf=features        render-core attribution mode (exact per-feature GPU times, a little slower)
 *   &scale=<0.5..1>       pin the internal render scale (budgets are stated at 1)
 *   &governor=off         pin the quality governor at 1
 *   &hud=0                start with the HUD hidden (F2 shows it)
 *   &mute=1               master volume 0
 *   &deterministic=1      fixed 1/60 s frame steps and the renderer's deterministic mode from the first frame
 *   &paused=1             the simulation paused from the first frame, as the pause key does: it stays at the
 *                         scenario's first instant
 *                         Both together are the FROZEN START for reference captures, as the lab pages have it
 *                         (request lead-6): the camera also stands in its final pose from the first frame
 *                         (no opening swing, no blend, the head's sway settled), so that
 *                         `window.__test.renderExact` gives the same picture on every load.
 */
import type { DefLibrary, ScenarioDef } from '@/core/contracts/defs';

export interface AppSettings {
  scenarioId: string | null;
  pilot: boolean;
  view: string;
  /** Request fullscreen + keyboard lock on the first gesture (opt-in; default false). */
  captureKeyboard: boolean;
  /** Show "TEST PILOT · <phase>" while the scripted pilot flies (default true). */
  pilotLabel: boolean;
  /** Show the HUD's keyboard-capture control (default true). */
  capturePill: boolean;
  perfFeatures: boolean;
  renderScale: number | null;
  governorOff: boolean;
  hud: boolean;
  mute: boolean;
  /** Fixed frame steps and the renderer's deterministic mode from the first frame (default false). */
  deterministic: boolean;
  /** The simulation paused from the first frame (default false). */
  paused: boolean;
}

export function readSettings(query: URLSearchParams): AppSettings {
  const scale = Number(query.get('scale') ?? '');
  return {
    scenarioId: query.get('scenario'),
    pilot: query.get('pilot') === '1',
    view: query.get('view') ?? 'chase',
    captureKeyboard: query.get('capture') === '1',
    pilotLabel: query.get('pilotlabel') !== '0',
    capturePill: query.get('capturepill') !== '0',
    perfFeatures: query.get('perf') === 'features',
    renderScale: Number.isFinite(scale) && scale >= 0.25 && scale <= 1 ? scale : null,
    governorOff: query.get('governor') === 'off',
    hud: query.get('hud') !== '0',
    mute: query.get('mute') === '1',
    deterministic: query.get('deterministic') === '1',
    paused: query.get('paused') === '1',
  };
}

/** A scenario that can be flown as a mission proof: a pad start, nothing fired, milestone rules to judge it by. */
export function isMissionScenario(s: ScenarioDef): boolean {
  return s.start.kind === 'pad' && s.stagesAlreadyFired === 0 && s.milestones.length > 0;
}

/**
 * The scenario the game opens when none is asked for: the first mission scenario of the definitions in id
 * order (the data decides; no scenario id is named in code). Falls back to the first scenario of any kind.
 */
export function defaultScenario(defs: DefLibrary): string {
  const ids = Object.keys(defs.scenarios).sort();
  const mission = ids.find((id) => isMissionScenario(defs.scenarios[id]!));
  const pick = mission ?? ids[0];
  if (pick === undefined) throw new Error('No scenario is defined under data/defs/scenarios.');
  return pick;
}

export function resolveScenario(defs: DefLibrary, requested: string | null): string {
  if (requested === null) return defaultScenario(defs);
  if (!defs.scenarios[requested]) {
    const known = Object.keys(defs.scenarios).sort().join(', ');
    throw new Error(`Unknown scenario "${requested}". Defined scenarios: ${known}.`);
  }
  return requested;
}
