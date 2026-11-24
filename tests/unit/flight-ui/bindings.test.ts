import { describe, expect, it } from 'vitest';
import { SAS_MODES, type SasMode } from '@/core/contracts/controls';
import {
  ALL_AXIS_ACTIONS,
  ALL_BUTTON_ACTIONS,
  BROWSER_RESERVED_CODES,
  BROWSER_RESERVED_MODIFIERS,
  DEFAULT_BINDINGS,
  DEFERRED_ACTIONS,
  chordOf,
  isServed,
  keyHelpEntries,
  validateBindings,
  type Binding,
  type ServedActions,
} from '@/input';
import { keyHelpLineShown } from '@/ui/model';
import { flatTerrain, loadLibrary, makeSim } from '../sim-world/helpers';

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
    // v2 (ARCHITECTURE 19): the flight menu on Esc and P, the next target, the roster, prompts, quick comms.
    expect(code('flightMenu')).toEqual(['Escape', 'KeyP']);
    expect(code('cycleTarget')).toEqual(['KeyB']);
    expect(code('toggleRoster')).toEqual(['KeyO']);
    expect(code('acceptPrompt')).toEqual(['KeyY']);
    expect(code('openQuickComms')).toEqual(['Enter']);
    // The docking view is not on V (the next couch has it, request core-6) but right of the display keys.
    expect(code('dockingView')).toEqual(['Equal']);
    // The holds against a vessel or port target: the three keys right of L.
    expect(['target', 'antiTarget', 'portAlign'].map((m) => code(`sas:${m}`))).toEqual([['Semicolon'], ['Quote'], ['Backslash']]);
  });

  it("the keys of v1's pause are the flight menu's (the retired action is gone from the contract: no list can name it)", () => {
    // On a page with the shell's flight menu the line names it, on both of its keys.
    const entries = keyHelpEntries(DEFAULT_BINDINGS, { flightMenu: true });
    expect(entries.find((e) => e.text === 'Flight menu')).toMatchObject({ group: 'Time & navigation', keys: ['Esc', 'P'] });
    expect(entries.find((e) => e.text === 'Hold Port alignment')).toMatchObject({ group: 'SAS', keys: ['\\'], sasMode: 'portAlign' });
  });

  describe('the reference card lists what something serves', () => {
    /** The keys nothing answers before the shared universe: the five deferred actions and the three holds against a target. */
    const UNSERVED_KEYS = ['B', 'O', 'Y', 'Enter', '=', ';', "'", '\\'];
    /** The card as the HUD shows it for a session that lists `modes`. */
    const card = (served: ServedActions | undefined, modes: readonly SasMode[]): { text: string; keys: string[] }[] =>
      keyHelpEntries(DEFAULT_BINDINGS, served)
        .filter((e) => keyHelpLineShown(e, modes))
        .map((e) => ({ text: e.text, keys: [...e.keys, ...e.lockedKeys] }));

    it('a page that states nothing, on the real session: none of the eight keys nothing serves, no Esc, and P is the pause it is', async () => {
      const defs = await loadLibrary();
      const session = await makeSim(defs, 'lunar-direct', flatTerrain(defs, { earth: -100, moon: 0 }));
      const modes = session.snapshot().readouts.sasModesAvailable;
      expect(modes).toContain('stability');
      const lines = card(undefined, modes);
      const keys = lines.flatMap((l) => l.keys);
      for (const key of [...UNSERVED_KEYS, 'Esc']) expect(keys, `key ${key}`).not.toContain(key);
      expect(lines.find((l) => l.keys.includes('P'))).toEqual({ text: 'Pause', keys: ['P'] });
      expect(lines.some((l) => l.text === 'Flight menu')).toBe(false);
      // Every other line of the table is on the card: nothing else went with them.
      const all = keyHelpEntries(DEFAULT_BINDINGS, { flightMenu: true, actions: DEFERRED_ACTIONS });
      const gone = all.filter((e) => !lines.some((l) => l.text === e.text)).map((e) => e.text);
      expect(gone.sort()).toEqual(['Accept prompt', 'Docking view', 'Flight menu', 'Hold Anti-target', 'Hold Port alignment', 'Hold Target', 'Next target', 'Quick comms', 'Roster'].sort());
      expect(lines.length).toBe(all.length - 8);
      // The table itself is whole: every one of those keys is still bound to its action (the test above).
      for (const action of [...DEFERRED_ACTIONS, 'sas:target', 'sas:antiTarget', 'sas:portAlign', 'flightMenu']) {
        expect(DEFAULT_BINDINGS.some((b) => b.action === action), action).toBe(true);
      }
    });

    it('a deferred action joins the card when the page says that it serves it, and only that one', () => {
      const modes = [...SAS_MODES];
      const withRoster = card({ actions: ['toggleRoster'] }, modes);
      expect(withRoster.find((l) => l.text === 'Roster')).toEqual({ text: 'Roster', keys: ['O'] });
      expect(withRoster.some((l) => l.text === 'Next target' || l.text === 'Docking view' || l.text === 'Quick comms' || l.text === 'Accept prompt')).toBe(false);
      const everything = card({ flightMenu: true, actions: DEFERRED_ACTIONS }, modes);
      for (const [text, key] of [['Next target', 'B'], ['Roster', 'O'], ['Accept prompt', 'Y'], ['Quick comms', 'Enter'], ['Docking view', '=']] as const) {
        expect(everything.find((l) => l.text === text), text).toEqual({ text, keys: [key] });
      }
      expect(everything.find((l) => l.text === 'Flight menu')).toEqual({ text: 'Flight menu', keys: ['Esc', 'P'] });
      expect(everything.some((l) => l.text === 'Pause')).toBe(false);
      expect(isServed('toggleRoster')).toBe(false);
      expect(isServed('toggleRoster', { actions: ['toggleRoster'] })).toBe(true);
      expect(isServed('flightMenu')).toBe(false);
      expect(isServed('stage')).toBe(true);
    });

    it('a hold against a target is on the card while the session lists its mode, as its button is in the SAS row', () => {
      const none = card(undefined, [...SAS_MODES]);
      expect(none.some((l) => l.text.startsWith('Hold ') && [';', "'", '\\'].some((k) => l.keys.includes(k)))).toBe(false);
      expect(none.filter((l) => l.text.startsWith('Hold ')).length).toBe(SAS_MODES.length);
      const target = card(undefined, [...SAS_MODES, 'target', 'antiTarget']);
      expect(target.find((l) => l.text === 'Hold Target')).toEqual({ text: 'Hold Target', keys: [';'] });
      expect(target.find((l) => l.text === 'Hold Anti-target')).toEqual({ text: 'Hold Anti-target', keys: ["'"] });
      expect(target.some((l) => l.text === 'Hold Port alignment')).toBe(false);
      // Only those three lines depend on the session.
      expect(keyHelpEntries(DEFAULT_BINDINGS).filter((e) => e.sasMode !== undefined).map((e) => e.sasMode)).toEqual(['target', 'antiTarget', 'portAlign']);
    });
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

  it('binds the presentation actions: reset camera (Home) and next couch (V), with key help, clear of other keys', () => {
    const ui = DEFAULT_BINDINGS.filter((b) => b.kind === 'button' && b.action.startsWith('ui:'));
    expect(ui.map((b) => [b.code, b.kind === 'button' ? b.action : ''])).toEqual([
      ['Backquote', 'ui:keyHelp'],
      ['Home', 'ui:resetCamera'],
      ['KeyV', 'ui:nextSeat'],
    ]);
    for (const b of ui) {
      // No modifier, no reserved key, and no other binding on the same code.
      expect(b.modifiers ?? []).toEqual([]);
      expect(BROWSER_RESERVED_CODES).not.toContain(b.code);
      expect(DEFAULT_BINDINGS.filter((x) => x.code === b.code)).toHaveLength(1);
    }
    const entries = keyHelpEntries(DEFAULT_BINDINGS);
    expect(entries.find((e) => e.text === 'Reset camera')).toMatchObject({ group: 'Views', keys: ['Home'] });
    expect(entries.find((e) => e.text === 'Next couch (cockpit view)')).toMatchObject({ group: 'Views', keys: ['V'] });
    expect(validateBindings(DEFAULT_BINDINGS)).toEqual([]);
  });
});
