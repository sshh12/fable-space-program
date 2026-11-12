/**
 * Browser-safe keyboard / mouse / wheel input (docs/ARCHITECTURE.md section 11).
 *
 *   const input = createInputSystem(canvas);
 *   every frame:  const frame = input.sample();      // InputFrame (+ HUD-only `ui` actions)
 *
 * - Keys by `event.code` through the binding table; every bound code calls preventDefault (Tab, Space,
 *   Backspace, Slash, F2, digits...), so the page never scrolls, changes focus or opens quick-find.
 * - The wheel listener is non-passive and cancelled (Ctrl+wheel would zoom the page); steps are normalised to
 *   their sign (+1 = away from the user), because wheel deltas depend on the device and OS scaling.
 * - Keyboard events whose target is an editable element (a text field of the map's node panel) are left
 *   alone (no binding, no preventDefault: digits, Backspace, Enter and Space edit the text), and focusing such
 *   an element releases every held key.
 * - PointerState.overUi is true while the pointer is over any element other than the canvas (HUD controls,
 *   the map's node panel, any overlay that takes pointer events); the scene ignores presses, drags and wheel
 *   steps reported with it. A drag that starts on the canvas captures the pointer, so it stays a scene drag
 *   (overUi false) until release wherever the pointer goes.
 * - Release-all on window blur, when the page is hidden, and when fullscreen is left.
 * - Keyboard capture (fullscreen + `navigator.keyboard.lock()`) is the player's choice: the page starts windowed
 *   and uncaptured, every binding works so (no default binding uses Control, Alt or Meta), and the HUD's capture
 *   control calls `requestKeyboardCapture()` / `releaseKeyboardCapture()`; Esc also leaves it. Only an app that
 *   opts in with `captureKeyboard: true` has the first real gesture request it. `keyboardLocked` reports the
 *   outcome and is re-evaluated on every fullscreenchange. A refusal is never an error.
 */
import type { ButtonAction } from '@/core/contracts/controls';
import { DEFAULT_BINDINGS, type Binding, type UiAction } from './bindings';
import { createInputCore, type FlightInputFrame, type ModifierState } from './inputCore';
import { createKeyboardCapture } from './keyboardCapture';

export interface InputSystemOptions {
  bindings?: readonly Binding[];
  /**
   * Opt-in: request fullscreen + keyboard lock on the first real user gesture (default false: nothing here asks
   * for it by itself; the player uses the HUD's capture control).
   */
  captureKeyboard?: boolean;
  /** Element made fullscreen (default document.documentElement, so the HUD stays visible). */
  fullscreenElement?: () => Element;
  /** PointerState.overUi for a pointer event's target. Default: an element other than the canvas (and not inside it). */
  isOverUi?: (target: EventTarget | null) => boolean;
}

export interface InputSystem {
  readonly bindings: readonly Binding[];
  /** True while fullscreen keyboard lock is active. */
  readonly keyboardLocked: boolean;
  /** True while the page is fullscreen (the capture is on, whether or not the browser granted the lock). */
  readonly fullscreen: boolean;
  /** Build the InputFrame for this frame and reset the per-frame edges and deltas. */
  sample(): FlightInputFrame;
  /** Inject a discrete action from an on-screen control (HUD button); it appears in the next sample. */
  trigger(action: ButtonAction | UiAction): void;
  /** Ask for fullscreen + keyboard lock (call from a click handler: needs user activation). Never rejects. */
  requestKeyboardCapture(): Promise<boolean>;
  /** Leave fullscreen and release the keyboard lock (the capture control's second click). Never throws. */
  releaseKeyboardCapture(): void;
  /** Listen for keyboard-lock and fullscreen changes; returns an unsubscribe function. */
  onKeyboardLockChange(listener: (locked: boolean, fullscreen: boolean) => void): () => void;
  /** Codes currently held (diagnostics / tests). */
  heldCodes(): string[];
  dispose(): void;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (tag === 'INPUT') {
    const type = (target as HTMLInputElement).type;
    return !['button', 'checkbox', 'radio', 'range', 'submit', 'reset', 'image', 'color', 'file'].includes(type);
  }
  return false;
}

const modsOf = (e: KeyboardEvent | MouseEvent): ModifierState => ({ shift: e.shiftKey, ctrl: e.ctrlKey, alt: e.altKey, meta: e.metaKey });

export function createInputSystem(canvas: HTMLElement, opts: InputSystemOptions = {}): InputSystem {
  const bindings = opts.bindings ?? DEFAULT_BINDINGS;
  const core = createInputCore(bindings);
  const isOverUi = opts.isOverUi ?? ((target: EventTarget | null): boolean => target instanceof Element && target !== canvas && !canvas.contains(target));
  const listeners = new Set<(locked: boolean, fullscreen: boolean) => void>();
  let lockedSeen = false;
  const capture = createKeyboardCapture(opts.fullscreenElement ?? (() => document.documentElement), (locked, fullscreen) => {
    core.setKeyboardLocked(locked);
    if (lockedSeen && !locked) core.releaseAll();
    lockedSeen = locked;
    for (const l of listeners) l(locked, fullscreen);
  });
  let autoCapturePending = opts.captureKeyboard ?? false;
  let disposed = false;

  let rect = canvas.getBoundingClientRect();
  const refreshRect = (): void => {
    rect = canvas.getBoundingClientRect();
  };
  const ro = new ResizeObserver(refreshRect);
  ro.observe(canvas);

  const local = (e: MouseEvent): [number, number] => [e.clientX - rect.left, e.clientY - rect.top];

  const firstGesture = (e: Event): void => {
    if (!autoCapturePending || !e.isTrusted) return;
    autoCapturePending = false;
    void capture.request();
  };

  const onKeyDown = (e: KeyboardEvent): void => {
    if (e.isComposing || isEditable(e.target)) return;
    if (core.keyDown(e.code, e.repeat, modsOf(e))) e.preventDefault();
    else core.setModifiers(modsOf(e));
    if (e.code !== 'Escape') firstGesture(e);
  };
  const onKeyUp = (e: KeyboardEvent): void => {
    if (isEditable(e.target)) return;
    if (core.keyUp(e.code)) e.preventDefault();
    core.setModifiers(modsOf(e));
  };
  const onPointerDown = (e: PointerEvent): void => {
    refreshRect();
    const [x, y] = local(e);
    const overUi = isOverUi(e.target);
    core.setModifiers(modsOf(e));
    core.pointerButtons(e.buttons, x, y, overUi);
    if (e.target === canvas) {
      canvas.focus({ preventScroll: true });
      try {
        canvas.setPointerCapture(e.pointerId);
      } catch {
        // capture is a convenience for drags that leave the window
      }
    }
    firstGesture(e);
  };
  const onPointerMove = (e: PointerEvent): void => {
    const [x, y] = local(e);
    const overUi = isOverUi(e.target);
    core.pointerMove(x, y, e.movementX, e.movementY, overUi);
    // Chorded buttons (a second button pressed while one is held) only arrive as pointermove.
    core.pointerButtons(e.buttons, x, y, overUi);
  };
  const onPointerUp = (e: PointerEvent): void => {
    const [x, y] = local(e);
    core.setModifiers(modsOf(e));
    core.pointerButtons(e.buttons, x, y, isOverUi(e.target));
  };
  const onDoubleClick = (e: MouseEvent): void => {
    if (e.button === 0) core.doubleClick();
  };
  const onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    core.setModifiers(modsOf(e));
    if (e.deltaY !== 0) core.wheel(-Math.sign(e.deltaY));
  };
  const onContextMenu = (e: MouseEvent): void => {
    if (!isEditable(e.target)) e.preventDefault();
  };
  const onBlur = (): void => core.releaseAll();
  const onVisibility = (): void => {
    if (document.visibilityState !== 'visible') core.releaseAll();
  };
  const onFocusIn = (e: FocusEvent): void => {
    if (isEditable(e.target)) core.releaseAll();
  };
  const onFullscreenChange = (): void => {
    refreshRect();
    if (document.fullscreenElement === null) core.releaseAll();
  };

  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pointerdown', onPointerDown);
  window.addEventListener('pointermove', onPointerMove);
  window.addEventListener('pointerup', onPointerUp);
  window.addEventListener('pointercancel', onPointerUp);
  window.addEventListener('dblclick', onDoubleClick);
  window.addEventListener('wheel', onWheel, { passive: false });
  window.addEventListener('contextmenu', onContextMenu);
  window.addEventListener('blur', onBlur);
  window.addEventListener('resize', refreshRect);
  window.addEventListener('focusin', onFocusIn);
  document.addEventListener('visibilitychange', onVisibility);
  document.addEventListener('fullscreenchange', onFullscreenChange);

  return {
    bindings,
    get keyboardLocked() {
      return capture.locked;
    },
    get fullscreen() {
      return capture.fullscreen;
    },
    sample: () => core.sample(),
    trigger: (action) => core.trigger(action),
    requestKeyboardCapture() {
      autoCapturePending = false;
      return capture.request();
    },
    releaseKeyboardCapture() {
      autoCapturePending = false;
      capture.release();
    },
    onKeyboardLockChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    heldCodes: () => core.heldCodes(),
    dispose() {
      if (disposed) return;
      disposed = true;
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('pointermove', onPointerMove);
      window.removeEventListener('pointerup', onPointerUp);
      window.removeEventListener('pointercancel', onPointerUp);
      window.removeEventListener('dblclick', onDoubleClick);
      window.removeEventListener('wheel', onWheel);
      window.removeEventListener('contextmenu', onContextMenu);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('resize', refreshRect);
      window.removeEventListener('focusin', onFocusIn);
      document.removeEventListener('visibilitychange', onVisibility);
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      ro.disconnect();
      capture.dispose();
      listeners.clear();
      core.releaseAll();
    },
  };
}
