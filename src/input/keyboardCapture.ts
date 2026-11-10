/**
 * Fullscreen + Keyboard Lock (https://wicg.github.io/keyboard-lock/). While the page is fullscreen with the
 * lock held, Chrome and Edge deliver Ctrl+W / Ctrl+T / Ctrl+N and similar chords to the page instead of
 * acting on them, which is the only state in which ControlLeft may act as the alternate throttle-down key.
 *
 * Both requests may be refused (no user activation, permissions, headless browsers, iframes); that is
 * never an error: `locked` simply stays false and the HUD offers a click-to-capture control.
 */

interface KeyboardLockApi {
  lock(keyCodes?: string[]): Promise<void>;
  unlock(): void;
}

export interface KeyboardCapture {
  /** True while fullscreen is active AND the keyboard lock was granted. */
  readonly locked: boolean;
  /** Request fullscreen + keyboard lock. Must be called from inside a user-gesture event handler. Never rejects. */
  request(): Promise<boolean>;
  /** Re-evaluate after a fullscreenchange; returns the new state. */
  evaluate(): boolean;
  dispose(): void;
}

export function createKeyboardCapture(element: () => Element, onChange: (locked: boolean) => void): KeyboardCapture {
  let lockGranted = false;
  let locked = false;
  let disposed = false;
  const keyboard = (navigator as Navigator & { keyboard?: KeyboardLockApi }).keyboard;

  const evaluate = (): boolean => {
    const next = !disposed && document.fullscreenElement !== null && lockGranted;
    if (next !== locked) {
      locked = next;
      onChange(locked);
    }
    return locked;
  };

  // A granted lock request stays registered across fullscreen changes; it is in force only while fullscreen.
  const onFullscreenChange = (): void => {
    evaluate();
  };
  document.addEventListener('fullscreenchange', onFullscreenChange);

  return {
    get locked() {
      return locked;
    },
    async request() {
      if (disposed) return false;
      // Both calls are made synchronously inside the gesture so that the transient activation applies.
      let fullscreen: Promise<void> | null = null;
      if (document.fullscreenElement === null && document.fullscreenEnabled) {
        try {
          fullscreen = element().requestFullscreen({ navigationUI: 'hide' });
        } catch {
          fullscreen = null;
        }
      }
      let lock: Promise<void> | null = null;
      if (keyboard && typeof keyboard.lock === 'function') {
        try {
          lock = keyboard.lock();
        } catch {
          lock = null;
        }
      }
      if (fullscreen) await fullscreen.then(() => undefined, () => undefined);
      if (lock) {
        lockGranted = await lock.then(
          () => true,
          () => false,
        );
      }
      return evaluate();
    },
    evaluate,
    dispose() {
      disposed = true;
      document.removeEventListener('fullscreenchange', onFullscreenChange);
      if (lockGranted && keyboard) {
        try {
          keyboard.unlock();
        } catch {
          // unlock never matters on teardown
        }
      }
      lockGranted = false;
      evaluate();
    },
  };
}
