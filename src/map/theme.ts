/**
 * Type and panel tokens of the map view. They are the flight HUD's (src/ui/hud/hudStyles.ts: the font stack,
 * tabular figures, small tracked capitals for captions, the panel palette), so map labels and the node editor
 * read as part of the same interface. src/map may not import src/ui; request docs/requests/map-view-4.md
 * asks for these tokens to move to src/core so both import one copy.
 */

/** HUD font stack (Bahnschrift on Windows, DIN Alternate on macOS). */
export const MAP_FONT_FAMILY = "Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
/** Weight of map labels (the HUD's value weight). */
export const MAP_FONT_WEIGHT = 600;

/** HUD palette (CSS colours). */
export const HUD = {
  text: '#eef4fb',
  label: '#93a2b8',
  dim: '#6c7a8f',
  accent: '#55d4ff',
  line: 'rgba(160, 190, 230, 0.17)',
  /** Panels the player types into are opaque: nothing sharp shows behind a text field. */
  panel: '#0a0f16',
  field: '#05080d',
  fieldEdge: 'rgba(160, 190, 230, 0.22)',
  warning: '#ff6262',
} as const;
