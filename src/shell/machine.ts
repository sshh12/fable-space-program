/**
 * The app shell's state machine (ARCHITECTURE 23; frontend-ux 3.1):
 *
 *   boot -> gate -> title -> hub(PLAY | HANGAR | MY SHIPS | UNIVERSE | SETTINGS | CREDITS)
 *        -> deploy(vehicle -> pad -> briefing) -> transit -> flight <-> flightMenu -> leaving -> hub
 *
 * with the side states calibrate, queued (the ADMISSION queue of a full lobby), reconnecting, practice and
 * blocked, which overlay the main state and never replace it. Pure: `transition(state, event)` returns the next
 * state or null when the event does not apply; `createShellMachine` holds one and tells listeners. Every state
 * has a test hook through `ShellMachine.state()` (window.__shell in the labs and the app).
 *
 * The launch queue (a full pad class) is NOT a state: it lives inside the deploy flow (spawnFlow.ts) and is never
 * a blocking page.
 */
export type MainState = 'boot' | 'gate' | 'title' | 'hub' | 'deploy' | 'transit' | 'flight' | 'flightMenu' | 'leaving';
export const MAIN_STATES: readonly MainState[] = ['boot', 'gate', 'title', 'hub', 'deploy', 'transit', 'flight', 'flightMenu', 'leaving'];

export type SideState = 'calibrate' | 'queued' | 'reconnecting' | 'practice' | 'blocked';
export const SIDE_STATES: readonly SideState[] = ['calibrate', 'queued', 'reconnecting', 'practice', 'blocked'];

export type HubTab = 'play' | 'hangar' | 'ships' | 'universe' | 'settings' | 'credits';
export const HUB_TABS: readonly HubTab[] = ['play', 'hangar', 'ships', 'universe', 'settings', 'credits'];

/** The screens of the deploy flow, in order. `hangarDetail` is the vehicle screen opened from the Hangar tab (no pad step). */
export type DeployStep = 'vehicle' | 'pad' | 'briefing';
export const DEPLOY_STEPS: readonly DeployStep[] = ['vehicle', 'pad', 'briefing'];

/** Overlays a hub tab can open without leaving it: the controls reference and the lobby details. */
export type HubOverlay = 'controls' | 'lobby' | 'identity' | null;

export interface ShellState {
  main: MainState;
  tab: HubTab;
  step: DeployStep;
  overlay: HubOverlay;
  /** Side states in force, in SIDE_STATES order. */
  side: readonly SideState[];
  /** Why the transit or the flight began: a new launch or the resume of a ship. */
  entry: 'launch' | 'resume';
}

export type ShellEvent =
  | { type: 'booted' }
  | { type: 'gatePassed' }
  | { type: 'begin' }
  | { type: 'tab'; tab: HubTab }
  | { type: 'overlay'; overlay: HubOverlay }
  | { type: 'launch' }
  | { type: 'resume' }
  | { type: 'step'; step: DeployStep }
  | { type: 'commit' }
  | { type: 'seated' }
  | { type: 'spawnFailed' }
  | { type: 'back' }
  | { type: 'openFlightMenu' }
  | { type: 'closeFlightMenu' }
  | { type: 'leave' }
  | { type: 'left' }
  | { type: 'side'; side: SideState; on: boolean };

export const INITIAL_SHELL_STATE: ShellState = { main: 'boot', tab: 'play', step: 'vehicle', overlay: null, side: [], entry: 'launch' };

const withSide = (side: readonly SideState[], s: SideState, on: boolean): SideState[] => SIDE_STATES.filter((x) => (x === s ? on : side.includes(x)));

/** The next state, or null when `event` does not apply in `state`. */
export function transition(state: ShellState, event: ShellEvent): ShellState | null {
  const at = (patch: Partial<ShellState>): ShellState => ({ ...state, ...patch });
  // A blocked page (an unsupported device, ARCHITECTURE 24) takes no event but its own clearing.
  if (state.side.includes('blocked') && !(event.type === 'side' && event.side === 'blocked')) return null;
  switch (event.type) {
    case 'side':
      return state.side.includes(event.side) === event.on ? null : at({ side: withSide(state.side, event.side, event.on) });
    case 'booted':
      return state.main === 'boot' ? at({ main: 'gate' }) : null;
    case 'gatePassed':
      return state.main === 'gate' ? at({ main: 'title' }) : null;
    case 'begin':
      return state.main === 'title' ? at({ main: 'hub', tab: 'play', overlay: null }) : null;
    case 'tab':
      return state.main === 'hub' && (state.tab !== event.tab || state.overlay !== null) ? at({ tab: event.tab, overlay: null }) : null;
    case 'overlay':
      return state.main === 'hub' && state.overlay !== event.overlay ? at({ overlay: event.overlay }) : null;
    case 'launch':
      return state.main === 'hub' ? at({ main: 'deploy', step: 'vehicle', overlay: null, entry: 'launch' }) : null;
    case 'resume':
      return state.main === 'hub' ? at({ main: 'transit', overlay: null, entry: 'resume' }) : null;
    case 'step':
      return state.main === 'deploy' && state.step !== event.step ? at({ step: event.step }) : null;
    case 'commit':
      return state.main === 'deploy' && state.step === 'briefing' ? at({ main: 'transit', entry: 'launch' }) : null;
    case 'seated':
      return state.main === 'transit' ? at({ main: 'flight' }) : null;
    case 'spawnFailed':
      // A refused launch rises back to the pad screen with its explanation; a refused resume to My Ships.
      if (state.main !== 'transit') return null;
      return state.entry === 'launch' ? at({ main: 'deploy', step: 'pad' }) : at({ main: 'hub', tab: 'ships' });
    case 'openFlightMenu':
      return state.main === 'flight' ? at({ main: 'flightMenu' }) : null;
    case 'closeFlightMenu':
      return state.main === 'flightMenu' ? at({ main: 'flight' }) : null;
    case 'leave':
      return state.main === 'flightMenu' ? at({ main: 'leaving' }) : null;
    case 'left':
      return state.main === 'leaving' ? at({ main: 'hub', tab: 'play', overlay: null, side: withSide(state.side, 'practice', false) }) : null;
    case 'back':
      return back(state);
  }
}

/** Menu-back: one level up from wherever the player is (Esc, Backspace, the browser's Back, mouse button 4). */
function back(state: ShellState): ShellState | null {
  const at = (patch: Partial<ShellState>): ShellState => ({ ...state, ...patch });
  switch (state.main) {
    case 'hub':
      if (state.overlay !== null) return at({ overlay: null });
      if (state.tab !== 'play') return at({ tab: 'play' });
      return at({ main: 'title' });
    case 'deploy': {
      const i = DEPLOY_STEPS.indexOf(state.step);
      return i > 0 ? at({ step: DEPLOY_STEPS[i - 1]! }) : at({ main: 'hub', tab: 'play' });
    }
    case 'flightMenu':
      return at({ main: 'flight' });
    case 'flight':
      return at({ main: 'flightMenu' });
    default:
      // boot, gate, title, transit (its own table: skip, and back while a gate holds) and leaving take no back.
      return null;
  }
}

/** A stable name for a state, for test hooks and the DOM's data-state: "hub/play", "deploy/pad", "flight". */
export function stateName(s: ShellState): string {
  if (s.main === 'hub') return s.overlay !== null ? `hub/${s.tab}/${s.overlay}` : `hub/${s.tab}`;
  if (s.main === 'deploy') return `deploy/${s.step}`;
  return s.main;
}

export interface ShellMachine {
  state(): ShellState;
  /** Apply an event; true when it changed the state. */
  send(event: ShellEvent): boolean;
  subscribe(listener: (state: ShellState, previous: ShellState, event: ShellEvent) => void): () => void;
  /** Every state name entered since creation, in order (test hook). */
  visited(): readonly string[];
}

export function createShellMachine(initial: ShellState = INITIAL_SHELL_STATE): ShellMachine {
  let state = initial;
  const listeners = new Set<(state: ShellState, previous: ShellState, event: ShellEvent) => void>();
  const visited: string[] = [stateName(initial)];
  return {
    state: () => state,
    send(event) {
      const next = transition(state, event);
      if (next === null) return false;
      const previous = state;
      state = next;
      const name = stateName(next);
      if (visited[visited.length - 1] !== name) visited.push(name);
      for (const l of [...listeners]) l(next, previous, event);
      return true;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    visited: () => visited,
  };
}
