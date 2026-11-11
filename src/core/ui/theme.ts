/**
 * Type and colours of the game's interface, shared by the flight HUD (`src/ui`) and the map view
 * (`src/map`), which may not import each other. Constants only: no DOM, no styles applied here. The HUD
 * builds its CSS variables from these (`src/ui/hud/hudStyles.ts`); a package that draws text or panels of
 * its own (a canvas label, a DOM editor) reads the same values, so a restyling of the HUD reaches it.
 * Request docs/requests/map-view-4.md.
 */

/** Font stack of every interface text (Bahnschrift on Windows, DIN Alternate on macOS). Numerals are tabular. */
export const UI_FONT_FAMILY = "Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";

/**
 * CSS colours. `panel` and `panelStrong` are the plates' fills with their alpha: 0.97 and 0.985, so that a
 * hard edge of the scene behind a plate (sunlit ground against black sky) survives as a step of 8 levels
 * at most, not as a line across a row of text (request flight-ui-2; they were 0.86 and 0.94).
 */
export const UI_COLORS = {
  /** Values and primary text. */
  text: '#eef4fb',
  /** Captions and secondary text (4.5 : 1 against a plate over white cloud and over black space). */
  label: '#aebccf',
  /** Units, disabled and tertiary text. */
  dim: '#8492a7',
  accent: '#55d4ff',
  good: '#5fe39a',
  caution: '#ffbb4d',
  warning: '#ff6a6a',
  /** Hairlines and plate borders. */
  line: 'rgba(170, 198, 235, 0.26)',
  panel: 'rgba(17, 24, 34, 0.97)',
  panelStrong: 'rgba(12, 17, 25, 0.985)',
} as const;
