/**
 * The data-driven key binding table (docs/ARCHITECTURE.md section 11).
 *
 * Keys are identified by `KeyboardEvent.code` (the physical key: `KeyW`, `ShiftLeft`, `Digit1`), never by
 * `key` or `keyCode`, so the table works on every keyboard layout and with Shift held.
 *
 * Browser safety: Chrome and Edge do not let a page cancel Ctrl+W / Ctrl+T / Ctrl+N (close tab, new tab, new
 * window) outside keyboard-locked fullscreen, and Alt chords reach the browser menu. Therefore no default
 * binding uses Control, Alt or Meta as a key or as a modifier. A binding may be flagged
 * `requiresKeyboardLock`; it is active only while `InputFrame.keyboardLocked` is true. The only such default
 * is ControlLeft as an alternate throttle-down (a lunar landing holds throttle-down and pitch together).
 *
 * Matching rule: a binding without modifiers matches its code whatever modifiers are held (Shift is itself
 * the throttle-up key, so Shift+W must still pitch). A binding with modifiers matches only while all of them
 * are held, and the most specific matching binding of a code wins.
 */
import { SAS_MODES, type AxisAction, type ButtonAction, type SasMode } from '@/core/contracts/controls';

export type ModifierKey = 'Shift' | 'Control' | 'Alt' | 'Meta';

/** Presentation-only actions that have no simulation meaning (handled by the HUD). */
export type UiAction = 'ui:keyHelp';

interface BindingBase {
  /** KeyboardEvent.code of the key. */
  code: string;
  /** Modifiers that must be held (default none). */
  modifiers?: readonly ModifierKey[];
  /** Active only while fullscreen keyboard lock is held (InputFrame.keyboardLocked). */
  requiresKeyboardLock?: boolean;
}

/** Held key contributing `value` (-1..1) to a continuous axis while down. */
export interface AxisBinding extends BindingBase {
  kind: 'axis';
  action: AxisAction;
  value: number;
}

/** Key press producing a discrete action once per press (key repeat is suppressed). */
export interface ButtonBinding extends BindingBase {
  kind: 'button';
  action: ButtonAction | UiAction;
}

export type Binding = AxisBinding | ButtonBinding;

/** Every AxisAction of src/core/contracts/controls.ts (compile-time checked below). */
export const ALL_AXIS_ACTIONS = [
  'pitch',
  'yaw',
  'roll',
  'translateX',
  'translateY',
  'translateZ',
  'throttleRate',
  'cameraYaw',
  'cameraPitch',
  'cameraZoom',
] as const satisfies readonly AxisAction[];

/** Every ButtonAction of src/core/contracts/controls.ts (compile-time checked below). */
export const ALL_BUTTON_ACTIONS = [
  'stage',
  'abort',
  'throttleFull',
  'throttleCut',
  'toggleSas',
  'toggleRcs',
  'toggleLegs',
  'toggleLights',
  'toggleFineControl',
  'toggleNavballMode',
  'warpUp',
  'warpDown',
  'warpStop',
  'toggleMap',
  'cycleCamera',
  'nextVessel',
  'prevVessel',
  'toggleHud',
  'pause',
  'mfdCycle:0',
  'mfdCycle:1',
  'mfdCycle:2',
  'sas:stability',
  'sas:prograde',
  'sas:retrograde',
  'sas:normal',
  'sas:antinormal',
  'sas:radialOut',
  'sas:radialIn',
  'sas:maneuver',
] as const satisfies readonly ButtonAction[];

// Exhaustiveness: a member added to the contract unions without being listed above fails to compile here.
type MissingAxis = Exclude<AxisAction, (typeof ALL_AXIS_ACTIONS)[number]>;
type MissingButton = Exclude<ButtonAction, (typeof ALL_BUTTON_ACTIONS)[number]>;
const axisListIsComplete: MissingAxis extends never ? true : MissingAxis = true;
const buttonListIsComplete: MissingButton extends never ? true : MissingButton = true;
void axisListIsComplete;
void buttonListIsComplete;

const axis = (code: string, action: AxisAction, value: number, extra: Partial<AxisBinding> = {}): AxisBinding => ({ kind: 'axis', code, action, value, ...extra });
const button = (code: string, action: ButtonAction | UiAction, extra: Partial<ButtonBinding> = {}): ButtonBinding => ({ kind: 'button', code, action, ...extra });

const SAS_KEYS: readonly SasMode[] = SAS_MODES;

/** Default bindings (ARCHITECTURE section 11 supersedes sim-design section 20). */
export const DEFAULT_BINDINGS: readonly Binding[] = Object.freeze([
  // Attitude (VES signs: pitch + = nose up, yaw + = nose right, roll + = clockwise seen from behind).
  axis('KeyW', 'pitch', -1),
  axis('KeyS', 'pitch', +1),
  axis('KeyA', 'yaw', -1),
  axis('KeyD', 'yaw', +1),
  axis('KeyQ', 'roll', -1),
  axis('KeyE', 'roll', +1),
  // RCS translation (VES: +X starboard, +Y forward, +Z dorsal).
  axis('KeyI', 'translateY', +1),
  axis('KeyK', 'translateY', -1),
  axis('KeyJ', 'translateX', -1),
  axis('KeyL', 'translateX', +1),
  axis('KeyH', 'translateZ', +1),
  axis('KeyN', 'translateZ', -1),
  // Throttle lever rate (the controller integrates it at 0.5 per second).
  axis('ShiftLeft', 'throttleRate', +1),
  axis('ShiftRight', 'throttleRate', +1),
  axis('KeyF', 'throttleRate', -1),
  axis('ControlLeft', 'throttleRate', -1, { requiresKeyboardLock: true }),
  // Camera orbit / look and zoom (the mouse drives the same CameraInput).
  axis('ArrowLeft', 'cameraYaw', -1),
  axis('ArrowRight', 'cameraYaw', +1),
  axis('ArrowUp', 'cameraPitch', +1),
  axis('ArrowDown', 'cameraPitch', -1),
  axis('PageUp', 'cameraZoom', -1),
  axis('PageDown', 'cameraZoom', +1),
  axis('NumpadAdd', 'cameraZoom', -1),
  axis('NumpadSubtract', 'cameraZoom', +1),
  // Staging and throttle presets.
  button('Space', 'stage'),
  button('Backspace', 'abort'),
  button('KeyZ', 'throttleFull'),
  button('KeyX', 'throttleCut'),
  // Systems.
  button('KeyT', 'toggleSas'),
  button('KeyR', 'toggleRcs'),
  button('KeyG', 'toggleLegs'),
  button('KeyU', 'toggleLights'),
  button('CapsLock', 'toggleFineControl'),
  ...SAS_KEYS.map((mode, i) => button(`Digit${i + 1}`, `sas:${mode}`)),
  // Navigation, time and views.
  button('Tab', 'toggleNavballMode'),
  button('Period', 'warpUp'),
  button('Comma', 'warpDown'),
  button('Slash', 'warpStop'),
  button('KeyM', 'toggleMap'),
  button('KeyC', 'cycleCamera'),
  button('BracketRight', 'nextVessel'),
  button('BracketLeft', 'prevVessel'),
  button('F2', 'toggleHud'),
  button('KeyP', 'pause'),
  // Cockpit multi-function displays (left, centre, right).
  button('Digit9', 'mfdCycle:0'),
  button('Digit0', 'mfdCycle:1'),
  button('Minus', 'mfdCycle:2'),
  // Presentation.
  button('Backquote', 'ui:keyHelp'),
]);

/** Codes that are browser-reserved as keys or modifiers (never bound unless `requiresKeyboardLock`). */
export const BROWSER_RESERVED_CODES: readonly string[] = ['ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
export const BROWSER_RESERVED_MODIFIERS: readonly ModifierKey[] = ['Control', 'Alt', 'Meta'];

/** Canonical chord string of a binding (code + sorted modifiers), used to detect conflicts. */
export function chordOf(b: Pick<Binding, 'code' | 'modifiers'>): string {
  const mods = [...(b.modifiers ?? [])].sort();
  return mods.length > 0 ? `${mods.join('+')}+${b.code}` : b.code;
}

/** Identity of the action a binding produces (axis bindings are distinguished by direction). */
export function actionIdOf(b: Binding): string {
  return b.kind === 'axis' ? `${b.action}${b.value >= 0 ? '+' : '-'}` : b.action;
}

/**
 * Structural problems of a binding table: browser-reserved keys/modifiers without `requiresKeyboardLock`,
 * chords bound to two different actions, out-of-range axis values, bad codes. Empty when the table is valid.
 */
export function validateBindings(table: readonly Binding[]): string[] {
  const problems: string[] = [];
  const byChord = new Map<string, string>();
  for (const b of table) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(b.code)) problems.push(`"${b.code}" is not a KeyboardEvent.code`);
    if (!b.requiresKeyboardLock) {
      if (BROWSER_RESERVED_CODES.includes(b.code)) problems.push(`${b.code} (${actionIdOf(b)}) is browser-reserved and must be flagged requiresKeyboardLock`);
      for (const m of b.modifiers ?? []) {
        if (BROWSER_RESERVED_MODIFIERS.includes(m)) problems.push(`${chordOf(b)} (${actionIdOf(b)}) uses the browser-reserved modifier ${m}`);
      }
    }
    if (b.kind === 'axis' && !(Math.abs(b.value) > 0 && Math.abs(b.value) <= 1)) problems.push(`${b.code}: axis value ${b.value} outside (0, 1]`);
    const chord = chordOf(b);
    const action = actionIdOf(b);
    const prev = byChord.get(chord);
    if (prev !== undefined && prev !== action) problems.push(`chord ${chord} is bound to both ${prev} and ${action}`);
    byChord.set(chord, action);
  }
  return problems;
}

// ------------------------------------------------------------------------------------- descriptions

/** Human-readable label of a KeyboardEvent.code for the key-help overlay and the HUD hints. */
export function keyLabel(code: string): string {
  const named: Record<string, string> = {
    Space: 'Space',
    Backspace: 'Backspace',
    Tab: 'Tab',
    CapsLock: 'Caps Lock',
    ShiftLeft: 'Left Shift',
    ShiftRight: 'Right Shift',
    ControlLeft: 'Left Ctrl',
    ControlRight: 'Right Ctrl',
    AltLeft: 'Left Alt',
    AltRight: 'Right Alt',
    Period: '.',
    Comma: ',',
    Slash: '/',
    Minus: '-',
    Equal: '=',
    BracketLeft: '[',
    BracketRight: ']',
    Backquote: '`',
    Quote: "'",
    Semicolon: ';',
    Backslash: '\\',
    ArrowLeft: '←',
    ArrowRight: '→',
    ArrowUp: '↑',
    ArrowDown: '↓',
    PageUp: 'Page Up',
    PageDown: 'Page Down',
    NumpadAdd: 'Num +',
    NumpadSubtract: 'Num −',
    Enter: 'Enter',
    Escape: 'Esc',
  };
  if (named[code]) return named[code];
  let m = /^Key([A-Z])$/.exec(code);
  if (m) return m[1]!;
  m = /^Digit(\d)$/.exec(code);
  if (m) return m[1]!;
  m = /^Numpad(\d)$/.exec(code);
  if (m) return `Num ${m[1]}`;
  return code;
}

const SAS_LABEL: Record<SasMode, string> = {
  stability: 'Stability',
  prograde: 'Prograde',
  retrograde: 'Retrograde',
  normal: 'Normal',
  antinormal: 'Anti-normal',
  radialOut: 'Radial out',
  radialIn: 'Radial in',
  maneuver: 'Maneuver',
};

export type BindingGroup = 'Attitude' | 'Translation' | 'Throttle & staging' | 'SAS' | 'Systems' | 'Time & navigation' | 'Views' | 'Cockpit displays';

const AXIS_TEXT: Record<AxisAction, { group: BindingGroup; pos: string; neg: string }> = {
  pitch: { group: 'Attitude', pos: 'Pitch up', neg: 'Pitch down' },
  yaw: { group: 'Attitude', pos: 'Yaw right', neg: 'Yaw left' },
  roll: { group: 'Attitude', pos: 'Roll right', neg: 'Roll left' },
  translateX: { group: 'Translation', pos: 'Translate right', neg: 'Translate left' },
  translateY: { group: 'Translation', pos: 'Translate forward', neg: 'Translate back' },
  translateZ: { group: 'Translation', pos: 'Translate up', neg: 'Translate down' },
  throttleRate: { group: 'Throttle & staging', pos: 'Throttle up', neg: 'Throttle down' },
  cameraYaw: { group: 'Views', pos: 'Camera right', neg: 'Camera left' },
  cameraPitch: { group: 'Views', pos: 'Camera up', neg: 'Camera down' },
  cameraZoom: { group: 'Views', pos: 'Zoom out', neg: 'Zoom in' },
};

const BUTTON_TEXT: Record<Exclude<ButtonAction, `sas:${string}`> | UiAction, { group: BindingGroup; text: string }> = {
  stage: { group: 'Throttle & staging', text: 'Fire next stage' },
  abort: { group: 'Throttle & staging', text: 'Abort' },
  throttleFull: { group: 'Throttle & staging', text: 'Full throttle' },
  throttleCut: { group: 'Throttle & staging', text: 'Cut throttle' },
  toggleSas: { group: 'SAS', text: 'SAS on / off' },
  toggleRcs: { group: 'Systems', text: 'RCS on / off' },
  toggleLegs: { group: 'Systems', text: 'Landing gear' },
  toggleLights: { group: 'Systems', text: 'Lights' },
  toggleFineControl: { group: 'Attitude', text: 'Fine control' },
  toggleNavballMode: { group: 'Time & navigation', text: 'Navball surface / orbit' },
  warpUp: { group: 'Time & navigation', text: 'Faster time warp' },
  warpDown: { group: 'Time & navigation', text: 'Slower time warp' },
  warpStop: { group: 'Time & navigation', text: 'Stop time warp' },
  toggleMap: { group: 'Views', text: 'Map view' },
  cycleCamera: { group: 'Views', text: 'Cockpit / chase camera' },
  nextVessel: { group: 'Views', text: 'Next vessel' },
  prevVessel: { group: 'Views', text: 'Previous vessel' },
  toggleHud: { group: 'Views', text: 'Hide / show HUD' },
  pause: { group: 'Time & navigation', text: 'Pause' },
  'mfdCycle:0': { group: 'Cockpit displays', text: 'Left display page' },
  'mfdCycle:1': { group: 'Cockpit displays', text: 'Centre display page' },
  'mfdCycle:2': { group: 'Cockpit displays', text: 'Right display page' },
  'ui:keyHelp': { group: 'Views', text: 'Key help' },
};

/** Group and text of a binding for the key-help overlay. */
export function describeBinding(b: Binding): { group: BindingGroup; text: string } {
  if (b.kind === 'axis') {
    const t = AXIS_TEXT[b.action];
    return { group: t.group, text: b.value >= 0 ? t.pos : t.neg };
  }
  if (b.action.startsWith('sas:')) {
    const mode = b.action.slice(4) as SasMode;
    return { group: 'SAS', text: `Hold ${SAS_LABEL[mode] ?? mode}` };
  }
  return BUTTON_TEXT[b.action as keyof typeof BUTTON_TEXT];
}

/** One line of the key-help overlay: every key producing the same action merged. */
export interface KeyHelpEntry {
  group: BindingGroup;
  text: string;
  keys: string[];
  /** Keys that only work while the keyboard is captured (fullscreen keyboard lock). */
  lockedKeys: string[];
}

export const BINDING_GROUP_ORDER: readonly BindingGroup[] = ['Attitude', 'Throttle & staging', 'SAS', 'Translation', 'Systems', 'Time & navigation', 'Views', 'Cockpit displays'];

/** Key-help content generated from a binding table, grouped and ordered for display. */
export function keyHelpEntries(table: readonly Binding[]): KeyHelpEntry[] {
  const byId = new Map<string, KeyHelpEntry>();
  for (const b of table) {
    const id = actionIdOf(b);
    const d = describeBinding(b);
    let e = byId.get(id);
    if (!e) {
      e = { group: d.group, text: d.text, keys: [], lockedKeys: [] };
      byId.set(id, e);
    }
    const label = [...(b.modifiers ?? []), keyLabel(b.code)].join(' + ');
    (b.requiresKeyboardLock ? e.lockedKeys : e.keys).push(label);
  }
  const out = [...byId.values()];
  out.sort((a, b) => BINDING_GROUP_ORDER.indexOf(a.group) - BINDING_GROUP_ORDER.indexOf(b.group));
  return out;
}
