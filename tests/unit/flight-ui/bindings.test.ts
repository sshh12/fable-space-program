import { describe, expect, it } from 'vitest';
import {
  ALL_AXIS_ACTIONS,
  ALL_BUTTON_ACTIONS,
  BROWSER_RESERVED_CODES,
  BROWSER_RESERVED_MODIFIERS,
  DEFAULT_BINDINGS,
  chordOf,
  keyHelpEntries,
  validateBindings,
  type Binding,
} from '@/input';

describe('default binding table (ARCHITECTURE section 11)', () => {
  it('never uses Control, Alt or Meta as a key or modifier unless flagged requiresKeyboardLock', () => {
    const offending = DEFAULT_BINDINGS.filter(
      (b) => !b.requiresKeyboardLock && (BROWSER_RESERVED_CODES.includes(b.code) || (b.modifiers ?? []).some((m) => BROWSER_RESERVED_MODIFIERS.includes(m))),
    );
    expect(offending).toEqual([]);
    // The single sanctioned exception: ControlLeft as an alternate throttle-down, only under keyboard lock.
    const locked = DEFAULT_BINDINGS.filter((b) => b.requiresKeyboardLock);
    expect(locked).toEqual([{ kind: 'axis', code: 'ControlLeft', action: 'throttleRate', value: -1, requiresKeyboardLock: true }]);
  });

  it('binds no chord to two actions', () => {
    const seen = new Map<string, string>();
    for (const b of DEFAULT_BINDINGS) {
      const id = b.kind === 'axis' ? `${b.action}${Math.sign(b.value)}` : b.action;
      const chord = chordOf(b);
      expect(seen.get(chord) ?? id, `chord ${chord}`).toBe(id);
      seen.set(chord, id);
    }
    expect(validateBindings(DEFAULT_BINDINGS)).toEqual([]);
  });

  it('reaches every ButtonAction and both directions of every AxisAction without keyboard lock', () => {
    const free = DEFAULT_BINDINGS.filter((b) => !b.requiresKeyboardLock);
    for (const action of ALL_BUTTON_ACTIONS) {
      expect(
        free.some((b) => b.kind === 'button' && b.action === action),
        `button ${action}`,
      ).toBe(true);
    }
    for (const action of ALL_AXIS_ACTIONS) {
      expect(free.some((b) => b.kind === 'axis' && b.action === action && b.value > 0), `axis ${action}+`).toBe(true);
      expect(free.some((b) => b.kind === 'axis' && b.action === action && b.value < 0), `axis ${action}-`).toBe(true);
    }
  });

  it('matches the documented defaults', () => {
    const code = (action: string, sign = 0): string[] =>
      DEFAULT_BINDINGS.filter((b) => b.action === action && (b.kind === 'button' || Math.sign(b.value) === sign) && !b.requiresKeyboardLock).map((b) => b.code);
    expect(code('pitch', -1)).toEqual(['KeyW']);
    expect(code('pitch', 1)).toEqual(['KeyS']);
    expect(code('yaw', -1)).toEqual(['KeyA']);
    expect(code('yaw', 1)).toEqual(['KeyD']);
    expect(code('roll', -1)).toEqual(['KeyQ']);
    expect(code('roll', 1)).toEqual(['KeyE']);
    expect(code('throttleRate', 1)).toContain('ShiftLeft');
    expect(code('throttleRate', -1)).toEqual(['KeyF']);
    expect(code('throttleFull')).toEqual(['KeyZ']);
    expect(code('throttleCut')).toEqual(['KeyX']);
    expect(code('stage')).toEqual(['Space']);
    expect(code('abort')).toEqual(['Backspace']);
    expect(code('toggleSas')).toEqual(['KeyT']);
    expect(code('toggleRcs')).toEqual(['KeyR']);
    expect(code('toggleLegs')).toEqual(['KeyG']);
    expect(code('toggleLights')).toEqual(['KeyU']);
    expect(code('toggleFineControl')).toEqual(['CapsLock']);
    expect(['stability', 'prograde', 'retrograde', 'normal', 'antinormal', 'radialOut', 'radialIn', 'maneuver'].map((m) => code(`sas:${m}`)[0])).toEqual([
      'Digit1',
      'Digit2',
      'Digit3',
      'Digit4',
      'Digit5',
      'Digit6',
      'Digit7',
      'Digit8',
    ]);
    expect(code('warpUp')).toEqual(['Period']);
    expect(code('warpDown')).toEqual(['Comma']);
    expect(code('warpStop')).toEqual(['Slash']);
    expect(code('toggleMap')).toEqual(['KeyM']);
    expect(code('cycleCamera')).toEqual(['KeyC']);
    expect(code('toggleNavballMode')).toEqual(['Tab']);
    expect(code('prevVessel')).toEqual(['BracketLeft']);
    expect(code('nextVessel')).toEqual(['BracketRight']);
    expect(code('toggleHud')).toEqual(['F2']);
    expect(code('mfdCycle:0')).toEqual(['Digit9']);
    expect(code('mfdCycle:1')).toEqual(['Digit0']);
    expect(code('mfdCycle:2')).toEqual(['Minus']);
  });

  it('validateBindings catches unsafe or conflicting tables', () => {
    const bad: Binding[] = [
      { kind: 'button', code: 'KeyW', action: 'stage', modifiers: ['Control'] },
      { kind: 'axis', code: 'AltLeft', action: 'pitch', value: 1 },
      { kind: 'button', code: 'KeyT', action: 'toggleSas' },
      { kind: 'button', code: 'KeyT', action: 'toggleRcs' },
    ];
    const problems = validateBindings(bad);
    expect(problems.some((p) => p.includes('Control'))).toBe(true);
    expect(problems.some((p) => p.includes('AltLeft'))).toBe(true);
    expect(problems.some((p) => p.includes('KeyT'))).toBe(true);
  });

  it('generates key help covering every bound action', () => {
    const entries = keyHelpEntries(DEFAULT_BINDINGS);
    const texts = entries.map((e) => e.text);
    expect(texts).toContain('Pitch down');
    expect(texts).toContain('Hold Prograde');
    expect(entries.find((e) => e.text === 'Throttle down')!.lockedKeys).toEqual(['Left Ctrl']);
    expect(entries.find((e) => e.text === 'Throttle down')!.keys).toEqual(['F']);
    expect(new Set(entries.map((e) => e.text)).size).toBe(entries.length);
  });
});
