/**
 * The binding tables of the three input contexts (ARCHITECTURE 19; brief acceptance "Binding tables"): no
 * Control, Alt or Meta anywhere (as a key or as a modifier, outside the one keyboard-lock alternate of the
 * flight table), no chord bound to two actions inside a context, and every action of every context has a key.
 */
import { describe, expect, it } from 'vitest';
import { ALL_BUTTON_ACTIONS, BROWSER_RESERVED_CODES, DEFAULT_BINDINGS, validateBindings } from '@/input/bindings';
import { contextActionOf, keysOfAction, MENU_ACTIONS, MENU_BINDINGS, TRANSIT_ACTIONS, TRANSIT_BINDINGS, validateContextTable } from '@/input/contexts';

const RESERVED_MODIFIERS = ['Control', 'Alt', 'Meta'];

describe('input context tables', () => {
  it('the menu table is valid: no reserved key or modifier, no conflict, every action has a key', () => {
    expect(validateContextTable(MENU_BINDINGS, MENU_ACTIONS)).toEqual([]);
  });

  it('the transit table is valid', () => {
    expect(validateContextTable(TRANSIT_BINDINGS, TRANSIT_ACTIONS)).toEqual([]);
  });

  it('the flight table is valid and every bindable button action has a key', () => {
    expect(validateBindings(DEFAULT_BINDINGS)).toEqual([]);
    for (const action of ALL_BUTTON_ACTIONS) expect(DEFAULT_BINDINGS.some((b) => b.action === action), action).toBe(true);
  });

  it('no table of any context uses Control, Alt or Meta, except the flight table entry that needs the keyboard lock', () => {
    for (const b of [...MENU_BINDINGS, ...TRANSIT_BINDINGS]) {
      expect(BROWSER_RESERVED_CODES).not.toContain(b.code);
      for (const m of b.modifiers ?? []) expect(RESERVED_MODIFIERS).not.toContain(m);
    }
    for (const b of DEFAULT_BINDINGS) {
      if (b.requiresKeyboardLock) continue;
      expect(BROWSER_RESERVED_CODES).not.toContain(b.code);
      for (const m of b.modifiers ?? []) expect(RESERVED_MODIFIERS).not.toContain(m);
    }
  });

  it('a validation catches each kind of problem', () => {
    expect(validateContextTable([{ code: 'ControlLeft', action: 'transit:skip' }, { code: 'Escape', action: 'transit:back' }], TRANSIT_ACTIONS)).toHaveLength(1);
    expect(validateContextTable([{ code: 'KeyQ', action: 'transit:skip', modifiers: ['Alt'] }, { code: 'Escape', action: 'transit:back' }], TRANSIT_ACTIONS)).toHaveLength(1);
    expect(validateContextTable([{ code: 'Space', action: 'transit:skip' }, { code: 'Space', action: 'transit:back' }], TRANSIT_ACTIONS)).toHaveLength(1);
    expect(validateContextTable([{ code: 'Space', action: 'transit:skip' }], TRANSIT_ACTIONS)).toEqual(['transit:back has no key']);
  });

  it('a press with Control, Alt or Meta held is never a context action (the browser keeps its chords)', () => {
    const none = { ctrl: false, alt: false, meta: false };
    expect(contextActionOf(MENU_BINDINGS, 'KeyW', none)).toBe('menu:up');
    expect(contextActionOf(MENU_BINDINGS, 'KeyW', { ...none, ctrl: true })).toBeNull();
    expect(contextActionOf(MENU_BINDINGS, 'KeyR', { ...none, meta: true })).toBeNull();
    expect(contextActionOf(MENU_BINDINGS, 'Escape', { ...none, alt: true })).toBeNull();
    expect(contextActionOf(TRANSIT_BINDINGS, 'Space', none)).toBe('transit:skip');
    expect(contextActionOf(TRANSIT_BINDINGS, 'KeyW', none)).toBeNull();
  });

  it('menu-back and activate are reachable from more than one key (Esc is taken by the browser outside the keyboard lock)', () => {
    expect(keysOfAction(MENU_BINDINGS, 'menu:back')).toEqual(['Escape', 'Backspace']);
    expect(keysOfAction(MENU_BINDINGS, 'menu:activate').length).toBeGreaterThan(1);
    expect(keysOfAction(TRANSIT_BINDINGS, 'transit:back')).toContain('Backspace');
  });
});
