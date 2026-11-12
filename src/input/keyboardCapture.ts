/**
 * Fullscreen + Keyboard Lock (https://wicg.github.io/keyboard-lock/), on the player's request only. While the page
 * is fullscreen with the lock held, Chrome and Edge deliver Ctrl+W / Ctrl+T / Ctrl+N and similar chords to the
 * page instead of acting on them, which is the only state in which ControlLeft may act as the alternate
 * throttle-down key. Every other binding works without it.
 *
 * Escape is deliberately not locked: one press of Esc leaves fullscreen (and so the capture) at once, instead
 * of the press-and-hold Chrome asks for while Escape itself is locked.
 *
 * Both requests may be refused (no user activation, permissions, headless browsers, iframes); that is
 * never an error: `locked` simply stays false.
 */

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

/** Every key of a full-size keyboard except Escape (see the module comment). */
export const LOCKED_KEY_CODES: readonly string[] = [
  ...'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map((c) => `Key${c}`),
  ...'0123456789'.split('').map((d) => `Digit${d}`),
  ...Array.from({ length: 12 }, (_, i) => `F${i + 1}`),
  ...'0123456789'.split('').map((d) => `Numpad${d}`),
  'NumpadAdd', 'NumpadSubtract', 'NumpadMultiply', 'NumpadDivide', 'NumpadDecimal', 'NumpadEnter', 'NumLock',
  'Backquote', 'Minus', 'Equal', 'BracketLeft', 'BracketRight', 'Backslash', 'IntlBackslash', 'Semicolon', 'Quote', 'Comma', 'Period', 'Slash',
  'Tab', 'CapsLock', 'ShiftLeft', 'ShiftRight', 'ControlLeft', 'ControlRight', 'AltLeft', 'AltRight', 'MetaLeft', 'MetaRight', 'ContextMenu',
  'Space', 'Enter', 'Backspace', 'Delete', 'Insert', 'Home', 'End', 'PageUp', 'PageDown',
  'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'PrintScreen', 'ScrollLock', 'Pause',
];

export interface KeyboardCapture {
  /** True while fullscreen is active AND the keyboard lock was granted. */
  readonly locked: boolean;
  /** True while the page is fullscreen (the capture is on, with or without the lock). */
  readonly fullscreen: boolean;
  /** Request fullscreen + keyboard lock. Must be called from inside a user-gesture event handler. Never rejects. */
  request(): Promise<boolean>;
  /** Leave fullscreen and release the lock (the second click of the capture control). Never throws. */
  release(): void;
  /** Re-evaluate after a fullscreenchange; returns the new lock state. */
  evaluate(): boolean;
  dispose(): void;
}

export function createKeyboardCapture(element: () => Element, onChange: (locked: boolean, fullscreen: boolean) => void): KeyboardCapture {
  let lockGranted = false;
  let locked = false;
  let fullscreen = false;
  let disposed = false;
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;

  const unlock = (): void => {
    if (lockGranted && keyboard) {
      try {
        keyboard.unlock();
      } catch {
        // an unlock that fails leaves nothing held: the lock is only in force while fullscreen
      }
    }
    lockGranted = false;
  };

  const evaluate = (): boolean => {
    const fs = !disposed && document.fullscreenElement !== null;
    const next = fs && lockGranted;
    if (next !== locked || fs !== fullscreen) {
      locked = next;
      fullscreen = fs;
      onChange(locked, fullscreen);
    }
    return locked;
  };

  // Leaving fullscreen (Esc, the browser's own control, the release call) ends the capture: the lock goes with it.
  const onFullscreenChange = (): void => {
    if (document.fullscreenElement === null) unlock();
    evaluate();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  return {
    get locked() {
      return locked;
    },
    get fullscreen() {
      return fullscreen;
    },
    async request() {
      if (disposed) return false;
      // Both calls are made synchronously inside the gesture so that the transient activation applies.
      let fs: Promise<void> | null = null;
      if (document.fullscreenElement === null && document.fullscreenEnabled) {
        try {
          fs = element().requestFullscreen({ navigationUI: 'hide' });
        } catch {
          fs = null;
        }
      }
      let lock: Promise<void> | null = null;
      if (keyboard && typeof keyboard.lock === 'function') {
        try {
          lock = keyboard.lock([...LOCKED_KEY_CODES]);
        } catch {
          lock = null;
        }
      }
      if (fs) await fs.then(() => undefined, () => undefined);
      if (lock) {
        lockGranted = await lock.then(
          () => true,
          () => false,
        );
      }
      // Fullscreen refused: a lock alone does nothing, release it.
      if (document.fullscreenElement === null) unlock();
      return evaluate();
    },
    release() {
      unlock();
      if (document.fullscreenElement !== null) {
        try {
          void document.exitFullscreen().catch(() => undefined);
        } catch {
          // already leaving
        }
      }
      evaluate();
    },
    evaluate,
    dispose() {
      disposed = true;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      unlock();
      evaluate();
    },
  };
}
