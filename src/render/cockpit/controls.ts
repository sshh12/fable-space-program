/**
 * CockpitControls: which MFD page each display shows. Cockpit state, not simulation state: the app shell
 * calls cyclePage(i) for the button action 'mfdCycle:i'; nothing here reads the keyboard.
 */
import type { CockpitControls, MfdPage } from '@/core/contracts/ui';

export interface CockpitControlsImpl extends CockpitControls {
  /** Every page change (setPage or cyclePage), for the display scheduler. */
  onChange(listener: (display: number, page: MfdPage) => void): () => void;
}

export function createCockpitControls(pages: readonly MfdPage[], initial: readonly MfdPage[]): CockpitControlsImpl {
  if (pages.length === 0) throw new Error('cockpit controls: no MFD pages');
  const current = initial.map((p) => {
    if (!pages.includes(p)) throw new Error(`cockpit controls: unknown MFD page "${p}"`);
    return p;
  });
  const listeners = new Set<(display: number, page: MfdPage) => void>();
  const check = (display: number): void => {
    if (!Number.isInteger(display) || display < 0 || display >= current.length) throw new RangeError(`cockpit controls: no display ${display} (0..${current.length - 1})`);
  };
  const set = (display: number, page: MfdPage): void => {
    if (current[display] === page) return;
    current[display] = page;
    for (const l of listeners) l(display, page);
  };
  return {
    displayCount: current.length,
    page(display) {
      check(display);
      return current[display]!;
    },
    setPage(display, page) {
      check(display);
      if (!pages.includes(page)) throw new RangeError(`cockpit controls: unknown MFD page "${page}"`);
      set(display, page);
    },
    cyclePage(display) {
      check(display);
      const i = pages.indexOf(current[display]!);
      set(display, pages[(i + 1) % pages.length]!);
    },
    onChange(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
