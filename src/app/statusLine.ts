/**
 * The app shell's own line over the scene, for the two states the HUD does not know about: the game is paused
 * (P), and the scripted test pilot is flying (with its phase). Drawn in the HUD's type and colours
 * (src/core/ui/theme.ts), centred, under the HUD's altitude plate and its toasts (the top centre column of the
 * HUD ends about 17 interface units down); hidden when neither applies or the HUD is hidden.
 */
import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';

export interface StatusLine {
  update(state: { paused: boolean; pilotPhase: string | null; hudVisible: boolean }): void;
  readonly element: HTMLElement;
}

export function createStatusLine(container: HTMLElement): StatusLine {
  const el = document.createElement('div');
  el.setAttribute('data-app-status', '');
  el.setAttribute('role', 'status');
  Object.assign(el.style, {
    position: 'absolute',
    left: '50%',
    top: 'calc(min(1vh, 0.5625vw) * 24)',
    transform: 'translateX(-50%)',
    display: 'none',
    gap: 'calc(min(1vh, 0.5625vw) * 1.2)',
    alignItems: 'center',
    padding: 'calc(min(1vh, 0.5625vw) * 0.7) calc(min(1vh, 0.5625vw) * 1.6)',
    background: UI_COLORS.panelStrong,
    border: `1px solid ${UI_COLORS.line}`,
    borderRadius: 'calc(min(1vh, 0.5625vw) * 0.6)',
    fontFamily: UI_FONT_FAMILY,
    fontSize: 'calc(min(1vh, 0.5625vw) * 1.85)',
    letterSpacing: '0.08em',
    color: UI_COLORS.text,
    pointerEvents: 'none',
    whiteSpace: 'nowrap',
    zIndex: '5',
  } satisfies Partial<CSSStyleDeclaration>);
  const paused = document.createElement('span');
  paused.textContent = 'PAUSED';
  paused.style.color = UI_COLORS.caution;
  paused.style.fontWeight = '600';
  const pilot = document.createElement('span');
  pilot.style.color = UI_COLORS.label;
  el.append(paused, pilot);
  container.append(el);

  let last = '';
  return {
    element: el,
    update({ paused: isPaused, pilotPhase, hudVisible }) {
      const key = `${isPaused}|${pilotPhase}|${hudVisible}`;
      if (key === last) return;
      last = key;
      paused.style.display = isPaused ? '' : 'none';
      pilot.style.display = pilotPhase !== null ? '' : 'none';
      pilot.textContent = pilotPhase !== null ? `TEST PILOT · ${pilotPhase}` : '';
      el.style.display = hudVisible && (isPaused || pilotPhase !== null) ? 'flex' : 'none';
    },
  };
}
