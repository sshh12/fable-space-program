Status: open
From: map-view
Owner path: src/core (new module, e.g. src/core/ui/theme.ts), src/ui/hud/hudStyles.ts
Blocking: no

## Problem
The map view must use the flight HUD's type and colours (visual QA wave 2, map-view item 9: map labels in
Consolas and a developer-style node panel beside a Bahnschrift HUD read as two different products). src/map may
import only src/core and src/render/core, so it cannot read the tokens in src/ui/hud/hudStyles.ts. The map now
carries the same values in its own src/map/theme.ts (font stack, weight, the HUD palette), which works but is a
second copy that will drift the next time the HUD is restyled.

## Evidence
src/ui/hud/hudStyles.ts lines 11-30 (`--text`, `--label`, `--dim`, `--accent`, `--line`, `--warning`, the font
stack `Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif`, tabular numerals); src/map/theme.ts (the
copy); screenshots out/screens/map-view/lowOrbit-node.png (map panel) beside out/screens/flight-ui/map-lowOrbit-720p.png.

## Requested change
A small module in src/core (no DOM, constants only), for example `src/core/ui/theme.ts`:

```ts
export const UI_FONT_FAMILY: string;          // "Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif"
export const UI_COLORS: { text; label; dim; accent; good; caution; warning; line; panel; panelStrong: string };
```

with hudStyles.ts building its CSS variables from it. src/map will then import it and delete src/map/theme.ts's
copies (map-view keeps its own derived values: the opaque panel background and the field colours). Nothing in
the HUD's look must change.
