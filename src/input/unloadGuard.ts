/**
 * beforeunload confirmation while a flight is in progress, so that a stray Ctrl+W, Ctrl+R or a click on the
 * tab's close button asks before throwing a mission away (Chrome cannot let a page cancel those shortcuts
 * outside keyboard-locked fullscreen). The browser shows its own generic dialog; the page cannot style it.
 *
 * Returns a function that removes the guard.
 */
export function installUnloadGuard(isFlightInProgress: () => boolean): () => void {
  const onBeforeUnload = (e: BeforeUnloadEvent): void => {
    if (!isFlightInProgress()) return;
    e.preventDefault();
    // Legacy path still honoured by Chromium for pages that do not use preventDefault semantics.
    e.returnValue = '';
  };
  window.addEventListener('beforeunload', onBeforeUnload);
  return () => window.removeEventListener('beforeunload', onBeforeUnload);
}
