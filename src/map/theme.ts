/**
 * Type and panel tokens of the map view: the interface's shared ones (src/core/ui/theme.ts, the flight HUD's
 * font stack and palette, request map-view-4) plus what is the map's own: the label weight and the opaque fills
 * of the node editor (a panel the player types into shows nothing behind its fields).
 */
import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';

/** HUD font stack (Bahnschrift on Windows, DIN Alternate on macOS). */
export const MAP_FONT_FAMILY = UI_FONT_FAMILY;
/** Weight of map labels (the HUD's value weight). */
export const MAP_FONT_WEIGHT = 600;

/** HUD palette plus the map's opaque panel and field fills (CSS colours). */
export const HUD = {
  text: UI_COLORS.text,
  label: UI_COLORS.label,
  dim: UI_COLORS.dim,
  accent: UI_COLORS.accent,
  line: UI_COLORS.line,
  warning: UI_COLORS.warning,
  panel: '#0c1119',
  field: '#05080d',
  fieldEdge: 'rgba(170, 198, 235, 0.22)',
} as const;
