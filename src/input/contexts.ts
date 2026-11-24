/**
 * Input contexts (ARCHITECTURE 19, additions for v2; frontend-ux 3.4): one binding table per context.
 *
 *   menu      the DOM menu over the live scene (focus moves, activate, back, tabs, screen actions, turntable)
 *   transit   the camera flight from the menu to the pad or to a ship (skip, and back while a gate holds)
 *   flight    the flight table of bindings.ts (DEFAULT_BINDINGS), the only one that reaches the flight controller
 *
 * Switching the context releases every held key (`InputSystem.setContext`), the same release-all as on blur, so
 * a key held across the switch never reaches the next context as held. No table uses Control, Alt or Meta, as a
 * key or as a modifier; `validateContextTable` and the unit tests over every table hold that, that no chord is
 * bound to two actions, and that every action of a context has a key.
 *
 * Keys are `KeyboardEvent.code` values, as in the flight table, so the tables work on every layout. The browser's
 * Back and the mouse's back button are menu-back as well (the history trap of src/shell); they are not keys and
 * are not in these tables.
 */
import { BROWSER_RESERVED_CODES, chordOf, type ModifierKey } from './bindings';

export type InputContextName = 'menu' | 'transit' | 'flight';
export const INPUT_CONTEXTS: readonly InputContextName[] = ['menu', 'transit', 'flight'];

/**
 * What the menu context does. Focus moves and activation are spatial (src/shell's focus navigation); the screen
 * actions carry the meaning the active screen gives them, and the prompt bar names that meaning
 * (`menu:edit` is rename on My Ships and reset on Settings; `menu:remove` is abandon on My Ships).
 */
export const MENU_ACTIONS = [
  'menu:up',
  'menu:down',
  'menu:left',
  'menu:right',
  'menu:activate',
  'menu:back',
  'menu:prevTab',
  'menu:nextTab',
  'menu:secondary',
  'menu:edit',
  'menu:remove',
  'menu:stages',
  'menu:rotateLeft',
  'menu:rotateRight',
  'menu:zoomIn',
  'menu:zoomOut',
] as const;
export type MenuAction = (typeof MENU_ACTIONS)[number];

/** What the transit context does: skip the flight to its short form, and go back to the menu while a gate holds it. */
export const TRANSIT_ACTIONS = ['transit:skip', 'transit:back'] as const;
export type TransitAction = (typeof TRANSIT_ACTIONS)[number];

export type ContextAction = MenuAction | TransitAction;

/** One key of a menu or transit table. */
export interface ContextBinding<A extends ContextAction = ContextAction> {
  code: string;
  action: A;
  modifiers?: readonly ModifierKey[];
}

const key = <A extends ContextAction>(code: string, action: A): ContextBinding<A> => ({ code, action });

/** The menu table (frontend-ux 3.4). Arrows and W A S D move the focus; Q / E change the top tab. */
export const MENU_BINDINGS: readonly ContextBinding<MenuAction>[] = Object.freeze([
  key('ArrowUp', 'menu:up'),
  key('ArrowDown', 'menu:down'),
  key('ArrowLeft', 'menu:left'),
  key('ArrowRight', 'menu:right'),
  key('KeyW', 'menu:up'),
  key('KeyS', 'menu:down'),
  key('KeyA', 'menu:left'),
  key('KeyD', 'menu:right'),
  key('Enter', 'menu:activate'),
  key('NumpadEnter', 'menu:activate'),
  key('Space', 'menu:activate'),
  key('Escape', 'menu:back'),
  key('Backspace', 'menu:back'),
  key('KeyQ', 'menu:prevTab'),
  key('KeyE', 'menu:nextTab'),
  key('KeyF', 'menu:secondary'),
  key('KeyR', 'menu:edit'),
  key('Delete', 'menu:remove'),
  key('KeyX', 'menu:stages'),
  key('KeyJ', 'menu:rotateLeft'),
  key('KeyL', 'menu:rotateRight'),
  key('KeyI', 'menu:zoomIn'),
  key('KeyK', 'menu:zoomOut'),
  key('PageUp', 'menu:zoomIn'),
  key('PageDown', 'menu:zoomOut'),
]);

/** The transit table: Space or Enter skips to the short flight; Esc goes back to the menu while a gate holds. */
export const TRANSIT_BINDINGS: readonly ContextBinding<TransitAction>[] = Object.freeze([
  key('Space', 'transit:skip'),
  key('Enter', 'transit:skip'),
  key('Escape', 'transit:back'),
  key('Backspace', 'transit:back'),
]);

const RESERVED_MODIFIERS: readonly ModifierKey[] = ['Control', 'Alt', 'Meta'];

/**
 * Problems of a context table: a code that is not a `KeyboardEvent.code`, a browser-reserved key or modifier
 * (Control, Alt, Meta), a chord bound to two actions, and an action of `actions` without a key. Empty when valid.
 */
export function validateContextTable<A extends ContextAction>(table: readonly ContextBinding<A>[], actions: readonly A[]): string[] {
  const problems: string[] = [];
  const byChord = new Map<string, A>();
  for (const b of table) {
    if (!/^[A-Z][A-Za-z0-9]*$/.test(b.code)) problems.push(`"${b.code}" is not a KeyboardEvent.code`);
    if (BROWSER_RESERVED_CODES.includes(b.code)) problems.push(`${b.code} (${b.action}) is a browser-reserved key`);
    for (const m of b.modifiers ?? []) if (RESERVED_MODIFIERS.includes(m)) problems.push(`${chordOf(b)} (${b.action}) uses the browser-reserved modifier ${m}`);
    const chord = chordOf(b);
    const prev = byChord.get(chord);
    if (prev !== undefined && prev !== b.action) problems.push(`chord ${chord} is bound to both ${prev} and ${b.action}`);
    byChord.set(chord, b.action);
    if (!actions.includes(b.action)) problems.push(`${chord} is bound to ${b.action}, which is not an action of this context`);
  }
  for (const a of actions) if (!table.some((b) => b.action === a)) problems.push(`${a} has no key`);
  return problems;
}

/** The action a key press produces in a context table (Shift held or not: no context binding names a modifier), or null. */
export function contextActionOf<A extends ContextAction>(table: readonly ContextBinding<A>[], code: string, mods: { ctrl: boolean; alt: boolean; meta: boolean }): A | null {
  // A press with Control, Alt or Meta held is the browser's chord (reload, find, a new tab, its menu): never ours.
  if (mods.ctrl || mods.alt || mods.meta) return null;
  return table.find((b) => b.code === code && (b.modifiers ?? []).length === 0)?.action ?? null;
}

/** Keys of an action in a table, in table order (the prompt bar's key caps). */
export function keysOfAction<A extends ContextAction>(table: readonly ContextBinding<A>[], action: A): string[] {
  return table.filter((b) => b.action === action).map((b) => b.code);
}
