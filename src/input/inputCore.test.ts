import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS, type Binding } from './bindings';
import { createInputCore } from './inputCore';

const NO_MODS = { shift: false, ctrl: false, alt: false, meta: false };

describe('input core', () => {
  it('maps held keys to axes and sums opposite keys to zero', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('KeyW', false, NO_MODS);
    expect(c.sample().axes.pitch).toBe(-1);
    c.keyDown('KeyS', false, NO_MODS);
    expect(c.sample().axes.pitch).toBe(0);
    c.keyUp('KeyW');
    expect(c.sample().axes.pitch).toBe(1);
    c.keyUp('KeyS');
    expect(c.sample().axes.pitch).toBe(0);
  });

  it('keeps a tap that starts and ends between two samples for one frame', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('KeyD', false, NO_MODS);
    c.keyUp('KeyD');
    expect(c.sample().axes.yaw).toBe(1);
    expect(c.sample().axes.yaw).toBe(0);
  });

  it('fires a button once per press and suppresses auto-repeat and duplicate keydowns', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('Space', false, NO_MODS);
    c.keyDown('Space', true, NO_MODS);
    c.keyDown('Space', false, NO_MODS);
    expect([...c.sample().pressed]).toEqual(['stage']);
    c.keyDown('Space', true, NO_MODS);
    expect(c.sample().pressed.size).toBe(0);
    c.keyUp('Space');
    c.keyDown('Space', false, NO_MODS);
    expect([...c.sample().pressed]).toEqual(['stage']);
  });

  it('modifier-less bindings work with Shift held (throttle up + pitch)', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('ShiftLeft', false, { ...NO_MODS, shift: true });
    c.keyDown('KeyW', false, { ...NO_MODS, shift: true });
    c.keyDown('Digit2', false, { ...NO_MODS, shift: true });
    const f = c.sample();
    expect(f.axes.throttleRate).toBe(1);
    expect(f.axes.pitch).toBe(-1);
    expect([...f.pressed]).toEqual(['sas:prograde']);
  });

  it('ControlLeft throttles down only while the keyboard is locked', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('ControlLeft', false, { ...NO_MODS, ctrl: true });
    expect(c.sample().axes.throttleRate).toBe(0);
    c.setKeyboardLocked(true);
    expect(c.sample().axes.throttleRate).toBe(-1);
    expect(c.sample().keyboardLocked).toBe(true);
    c.setKeyboardLocked(false);
    expect(c.sample().axes.throttleRate).toBe(0);
  });

  it('releaseAll clears held keys and ends a primary drag with one released edge', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.keyDown('KeyW', false, NO_MODS);
    c.pointerButtons(1, 10, 10, false);
    c.sample();
    c.releaseAll();
    const f = c.sample();
    expect(f.axes.pitch).toBe(0);
    expect(f.pointer.released).toBe(true);
    expect(f.pointer.buttons).toBe(0);
    expect(c.sample().pointer.released).toBe(false);
  });

  it('reports pointer edges, deltas, wheel and double clicks exactly once', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.pointerMove(5, 6, 3, -2, false);
    c.pointerMove(7, 8, 2, 1, false);
    c.pointerButtons(1, 7, 8, false);
    c.pointerButtons(0, 7, 8, false);
    c.pointerButtons(1, 7, 8, false);
    c.pointerButtons(0, 7, 8, false);
    c.doubleClick();
    c.wheel(-3);
    c.wheel(1);
    c.wheel(5);
    // A double click inside one frame: each click is reported in its own frame, the double click with the second.
    let f = c.sample();
    expect(f.pointer).toMatchObject({ x: 7, y: 8, dx: 5, dy: -1, pressed: true, released: true, doubleClick: false, wheel: 1, buttons: 0 });
    f = c.sample();
    expect(f.pointer).toMatchObject({ dx: 0, dy: 0, pressed: true, released: true, doubleClick: true, wheel: 0 });
    f = c.sample();
    expect(f.pointer).toMatchObject({ dx: 0, dy: 0, pressed: false, released: false, doubleClick: false, wheel: 0 });
    // A chorded secondary button does not produce primary edges.
    c.pointerButtons(2, 7, 8, false);
    f = c.sample();
    expect(f.pointer.pressed).toBe(false);
    expect(f.pointer.buttons).toBe(2);
  });

  it('routes injected on-screen actions and HUD-only actions separately', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.trigger('sas:retrograde');
    c.keyDown('Backquote', false, NO_MODS);
    const f = c.sample();
    expect([...f.pressed]).toEqual(['sas:retrograde']);
    expect([...f.ui]).toEqual(['ui:keyHelp']);
  });

  it('ignores unbound codes', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    expect(c.keyDown('F9', false, NO_MODS)).toBe(false);
    expect(c.isBound('Tab')).toBe(true);
    expect(c.sample().pressed.size).toBe(0);
  });
});

describe('chords of the browser (Control and Meta)', () => {
  const CTRL = { ...NO_MODS, ctrl: true };
  const META = { ...NO_MODS, meta: true };
  const MODIFIER_KEYS = ['ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight'];
  const quiet = (f: ReturnType<ReturnType<typeof createInputCore>['sample']>): boolean => f.pressed.size === 0 && f.ui.size === 0 && Object.values(f.axes).every((x) => x === 0);

  it('every bound key pressed with Control or Meta passes through: not the game\'s on keydown or keyup, no action, no axis, not held', () => {
    const codes = [...new Set(DEFAULT_BINDINGS.map((b) => b.code))].filter((code) => !MODIFIER_KEYS.includes(code));
    // The zoom, open, bookmark, redo and send chords that the v2 keys had taken, and the old ones (reload, find, print, tabs).
    for (const code of ['Equal', 'KeyO', 'KeyB', 'KeyY', 'Enter', 'KeyR', 'KeyF', 'KeyP', 'Tab', 'Digit1', 'Minus', 'Digit0']) expect(codes, code).toContain(code);
    for (const mods of [CTRL, META, { ...CTRL, shift: true }, { ...CTRL, alt: true }]) {
      const c = createInputCore(DEFAULT_BINDINGS);
      for (const code of codes) {
        expect(c.keyDown(code, false, mods), `${code} down`).toBe(false);
        expect(c.keyDown(code, true, mods), `${code} repeat`).toBe(false);
        expect(c.heldCodes(), code).toEqual([]);
        expect(quiet(c.sample()), code).toBe(true);
        expect(c.keyUp(code), `${code} up`).toBe(false);
      }
      // The modifier state still reaches the pointer (the node editor's coarse drag).
      c.keyDown('KeyW', false, mods);
      expect(c.sample().pointer.ctrl).toBe(mods.ctrl);
    }
    // Without the modifier the same keys are the game's.
    const c = createInputCore(DEFAULT_BINDINGS);
    expect(c.keyDown('Equal', false, NO_MODS)).toBe(true);
    expect(c.keyDown('KeyR', false, { ...NO_MODS, shift: true, alt: true })).toBe(true);
    expect([...c.sample().pressed].sort()).toEqual(['dockingView', 'toggleRcs']);
    expect(c.keyUp('Equal')).toBe(true);
  });

  it('a press stays what it was until the key is released: the game\'s when Control comes later, the browser\'s when Control goes first', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    // W goes down, then Control: the auto-repeat of W is still the game's and W still pitches.
    expect(c.keyDown('KeyW', false, NO_MODS)).toBe(true);
    expect(c.keyDown('ControlLeft', false, CTRL)).toBe(true);
    expect(c.keyDown('KeyW', true, CTRL)).toBe(true);
    expect(c.sample().axes.pitch).toBe(-1);
    expect(c.keyUp('KeyW')).toBe(true);
    // Control is still down: a new press of W is the browser's (close the tab), and stays so after Control is up.
    expect(c.keyDown('KeyW', false, CTRL)).toBe(false);
    expect(c.keyUp('ControlLeft')).toBe(true);
    expect(c.keyDown('KeyW', true, NO_MODS)).toBe(false);
    expect(c.sample().axes.pitch).toBe(0);
    expect(c.keyUp('KeyW')).toBe(false);
    // Released and pressed again without the modifier: the game's.
    expect(c.keyDown('KeyW', false, NO_MODS)).toBe(true);
    expect(c.sample().axes.pitch).toBe(-1);
    // Leaving the window forgets a chord in flight (its keyup went to another tab).
    c.keyUp('KeyW');
    expect(c.keyDown('KeyT', false, CTRL)).toBe(false);
    c.releaseAll();
    expect(c.keyDown('KeyT', false, NO_MODS)).toBe(true);
    expect([...c.sample().pressed]).toEqual(['toggleSas']);
  });

  it('under keyboard lock Control held as the throttle-down key is the game\'s: the keys pressed with it fly the vessel', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    c.setKeyboardLocked(true);
    expect(c.keyDown('ControlLeft', false, CTRL)).toBe(true);
    expect(c.keyDown('KeyW', false, CTRL)).toBe(true);
    expect(c.keyDown('KeyG', false, CTRL)).toBe(true);
    const f = c.sample();
    expect(f.axes.throttleRate).toBe(-1);
    expect(f.axes.pitch).toBe(-1);
    expect([...f.pressed]).toEqual(['toggleLegs']);
    // The right Control key is no key of the game: with it alone the chord is the browser's, lock or not.
    c.releaseAll();
    expect(c.keyDown('ControlRight', false, CTRL)).toBe(false);
    expect(c.keyDown('KeyW', false, CTRL)).toBe(false);
    // And without the lock the left one is not either (its binding is inert).
    const unlocked = createInputCore(DEFAULT_BINDINGS);
    unlocked.keyDown('ControlLeft', false, CTRL);
    expect(unlocked.keyDown('KeyW', false, CTRL)).toBe(false);
    expect(quiet(unlocked.sample())).toBe(true);
  });

  it('a binding that names the modifier is the game\'s with it, and the plain binding of the same key without it', () => {
    const table: Binding[] = [
      { kind: 'button', code: 'KeyM', action: 'toggleMap' },
      { kind: 'button', code: 'KeyM', action: 'toggleHud', modifiers: ['Control'] },
      { kind: 'button', code: 'KeyC', action: 'cycleCamera' },
    ];
    const c = createInputCore(table);
    expect(c.keyDown('KeyM', false, CTRL)).toBe(true);
    expect([...c.sample().pressed]).toEqual(['toggleHud']);
    c.keyUp('KeyM');
    expect(c.keyDown('KeyM', false, NO_MODS)).toBe(true);
    expect([...c.sample().pressed]).toEqual(['toggleMap']);
    c.keyUp('KeyM');
    // Meta is not named by that binding, and C names no modifier at all.
    expect(c.keyDown('KeyM', false, META)).toBe(false);
    expect(c.keyDown('KeyC', false, CTRL)).toBe(false);
    expect(c.sample().pressed.size).toBe(0);
  });
});

describe('Esc and the flight menu', () => {
  it('on a page without a flight menu Esc is not bound (the browser\'s key, as before the action existed) and P is the key of the action', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    expect(c.isBound('Escape')).toBe(false);
    expect(c.keyDown('Escape', false, NO_MODS)).toBe(false);
    expect(c.keyUp('Escape')).toBe(false);
    expect(c.heldCodes()).toEqual([]);
    expect(c.sample().pressed.size).toBe(0);
    expect(c.keyDown('KeyP', false, NO_MODS)).toBe(true);
    expect([...c.sample().pressed]).toEqual(['flightMenu']);
    // The table still has both keys (ARCHITECTURE 19); the core leaves out the one that waits for the menu.
    expect(c.bindings.filter((b) => b.action === 'flightMenu').map((b) => b.code)).toEqual(['Escape', 'KeyP']);
  });

  it('on a page that serves the flight menu Esc opens it', () => {
    const c = createInputCore(DEFAULT_BINDINGS, { flightMenu: true });
    expect(c.isBound('Escape')).toBe(true);
    expect(c.keyDown('Escape', false, NO_MODS)).toBe(true);
    expect([...c.sample().pressed]).toEqual(['flightMenu']);
    expect(c.keyUp('Escape')).toBe(true);
  });

  it('the keys of the deferred actions stay bound whatever the page serves: their actions reach the frame', () => {
    const c = createInputCore(DEFAULT_BINDINGS);
    for (const code of ['KeyB', 'KeyO', 'KeyY', 'Enter', 'Equal', 'Semicolon', 'Quote', 'Backslash']) expect(c.keyDown(code, false, NO_MODS), code).toBe(true);
    expect([...c.sample().pressed].sort()).toEqual(['acceptPrompt', 'cycleTarget', 'dockingView', 'openQuickComms', 'sas:antiTarget', 'sas:portAlign', 'sas:target', 'toggleRoster']);
  });
});
