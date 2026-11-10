import { describe, expect, it } from 'vitest';
import { DEFAULT_BINDINGS } from './bindings';
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
    expect(c.keyDown('KeyV', false, NO_MODS)).toBe(false);
    expect(c.isBound('Tab')).toBe(true);
    expect(c.sample().pressed.size).toBe(0);
  });
});
