/**
 * DOM-free core of the input system: held-key bookkeeping, binding resolution, button edges, pointer
 * accumulation and the per-frame InputFrame. The DOM layer (inputSystem.ts) only forwards events here, so
 * the whole behaviour is unit-testable in Node.
 *
 * Semantics:
 *  - Axis value = sum of the values of all active held bindings of that axis, clamped to [-1, 1]. A key that
 *    went down and up between two samples still contributes to the next sample once (a quick tap is never
 *    lost).
 *  - A button action fires once per physical press: auto-repeat (`repeat`) and a second keydown without a
 *    keyup are ignored. `pressed` lists every action whose key went down since the previous sample.
 *  - `requiresKeyboardLock` bindings are inert while the keyboard is not locked.
 *  - Pointer edges (`pressed`, `released`, `doubleClick`) and deltas/wheel accumulate between samples and are
 *    reported exactly once.
 */
import type { AxisAction, ButtonAction, InputFrame, PointerState } from '@/core/contracts/controls';
import { ALL_AXIS_ACTIONS, type Binding, type ButtonBinding, type ModifierKey, type UiAction } from './bindings';

export interface ModifierState {
  shift: boolean;
  ctrl: boolean;
  alt: boolean;
  meta: boolean;
}

/** InputFrame plus presentation-only actions (key help) that the HUD consumes. */
export interface FlightInputFrame extends InputFrame {
  ui: ReadonlySet<UiAction>;
}

export interface InputCore {
  readonly bindings: readonly Binding[];
  /** True when the code appears in the binding table (the DOM layer then calls preventDefault). */
  isBound(code: string): boolean;
  /** Returns true when the key is bound. `repeat` = browser auto-repeat. */
  keyDown(code: string, repeat: boolean, mods: ModifierState): boolean;
  keyUp(code: string): boolean;
  /** Release every held key and pointer button (blur, fullscreen exit, focus moved into a text field). */
  releaseAll(): void;
  /** Inject a discrete action from an on-screen control; it appears in the next frame's `pressed`. */
  trigger(action: ButtonAction | UiAction): void;
  /** Pointer moved by (dx, dy) CSS px (movementX/Y, also valid under pointer lock) to (x, y). */
  pointerMove(x: number, y: number, dx: number, dy: number, overUi: boolean): void;
  /**
   * New held-button mask (1 primary, 2 secondary, 4 middle) at (x, y). Primary-button transitions become the
   * `pressed` / `released` edges of the next sample.
   */
  pointerButtons(buttons: number, x: number, y: number, overUi: boolean): void;
  doubleClick(): void;
  /** One wheel event; only its sign is used (+1 = away from the user). */
  wheel(sign: number): void;
  setModifiers(mods: ModifierState): void;
  setKeyboardLocked(locked: boolean): void;
  readonly keyboardLocked: boolean;
  /** Codes currently held (diagnostics). */
  heldCodes(): string[];
  sample(): FlightInputFrame;
}

const isUiAction = (a: string): a is UiAction => a.startsWith('ui:');

function modifierHeld(m: ModifierKey, s: ModifierState): boolean {
  switch (m) {
    case 'Shift':
      return s.shift;
    case 'Control':
      return s.ctrl;
    case 'Alt':
      return s.alt;
    case 'Meta':
      return s.meta;
  }
}

export function createInputCore(bindings: readonly Binding[]): InputCore {
  const byCode = new Map<string, Binding[]>();
  for (const b of bindings) {
    const list = byCode.get(b.code) ?? [];
    list.push(b);
    byCode.set(b.code, list);
  }
  // Most specific (most modifiers) first.
  for (const list of byCode.values()) list.sort((a, b) => (b.modifiers?.length ?? 0) - (a.modifiers?.length ?? 0));

  const held = new Set<string>();
  /** Codes that went down since the last sample (taps count for one frame even if already released). */
  const tapped = new Set<string>();
  const pressed = new Set<ButtonAction>();
  const ui = new Set<UiAction>();
  let locked = false;
  let mods: ModifierState = { shift: false, ctrl: false, alt: false, meta: false };

  const pointer: PointerState = { x: 0, y: 0, dx: 0, dy: 0, buttons: 0, pressed: false, released: false, doubleClick: false, wheel: 0, shift: false, ctrl: false, alt: false, overUi: false };

  const active = (b: Binding): boolean => !b.requiresKeyboardLock || locked;

  const emit = (action: ButtonAction | UiAction): void => {
    if (isUiAction(action)) ui.add(action);
    else pressed.add(action);
  };

  const core: InputCore = {
    bindings,
    isBound: (code) => byCode.has(code),
    keyDown(code, repeat, m) {
      mods = m;
      const list = byCode.get(code);
      if (!list) return false;
      if (repeat || held.has(code)) return true;
      held.add(code);
      tapped.add(code);
      const btn = list.find((b): b is ButtonBinding => b.kind === 'button' && active(b) && (b.modifiers ?? []).every((x) => modifierHeld(x, m)));
      if (btn) emit(btn.action);
      return true;
    },
    keyUp(code) {
      held.delete(code);
      return byCode.has(code);
    },
    releaseAll() {
      held.clear();
      tapped.clear();
      if ((pointer.buttons & 1) !== 0) pointer.released = true;
      pointer.buttons = 0;
      mods = { shift: false, ctrl: false, alt: false, meta: false };
    },
    trigger(action) {
      emit(action);
    },
    pointerMove(x, y, dx, dy, overUi) {
      pointer.x = x;
      pointer.y = y;
      pointer.dx += dx;
      pointer.dy += dy;
      pointer.overUi = overUi;
    },
    pointerButtons(buttons, x, y, overUi) {
      pointer.x = x;
      pointer.y = y;
      pointer.overUi = overUi;
      const was = (pointer.buttons & 1) !== 0;
      const now = (buttons & 1) !== 0;
      if (!was && now) pointer.pressed = true;
      if (was && !now) pointer.released = true;
      pointer.buttons = buttons;
    },
    doubleClick() {
      pointer.doubleClick = true;
    },
    wheel(sign) {
      if (sign > 0) pointer.wheel += 1;
      else if (sign < 0) pointer.wheel -= 1;
    },
    setModifiers(m) {
      mods = m;
    },
    setKeyboardLocked(v) {
      locked = v;
    },
    get keyboardLocked() {
      return locked;
    },
    heldCodes: () => [...held],
    sample() {
      const axes = {} as Record<AxisAction, number>;
      for (const a of ALL_AXIS_ACTIONS) axes[a] = 0;
      const contributing = new Set<string>([...held, ...tapped]);
      for (const code of contributing) {
        const list = byCode.get(code);
        if (!list) continue;
        for (const b of list) if (b.kind === 'axis' && active(b)) axes[b.action] += b.value;
      }
      for (const a of ALL_AXIS_ACTIONS) axes[a] = Math.max(-1, Math.min(1, axes[a]));
      tapped.clear();

      const frame: FlightInputFrame = {
        axes,
        pressed: new Set(pressed),
        ui: new Set(ui),
        pointer: { ...pointer, shift: mods.shift, ctrl: mods.ctrl, alt: mods.alt },
        keyboardLocked: locked,
      };
      pressed.clear();
      ui.clear();
      pointer.dx = 0;
      pointer.dy = 0;
      pointer.wheel = 0;
      pointer.pressed = false;
      pointer.released = false;
      pointer.doubleClick = false;
      return frame;
    },
  };
  return core;
}
