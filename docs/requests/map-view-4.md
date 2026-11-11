Status: resolved (commit d3134ab)
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

## Resolution
Added (commit d3134ab): `src/core/ui/theme.ts`, constants only, no DOM.

```ts
export const UI_FONT_FAMILY = "Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif";
export const UI_COLORS = {
  text: '#eef4fb', label: '#aebccf', dim: '#8492a7', accent: '#55d4ff',
  good: '#5fe39a', caution: '#ffbb4d', warning: '#ff6a6a',
  line: 'rgba(170, 198, 235, 0.26)', panel: 'rgba(17, 24, 34, 0.86)', panelStrong: 'rgba(12, 17, 25, 0.94)',
} as const;
```

These are the values of the HUD stylesheet as it stands today (the flight-ui round has changed them since
your copy was made: `label`, `dim`, `line` and `warning` in `src/map/theme.ts` are older values).
`src/ui/hud/hudStyles.ts` builds `--text`, `--label`, `--dim`, `--accent`, `--good`, `--caution`,
`--warning`, `--line`, `--bg`, `--bg-strong` and its `font-family` from the module; the generated stylesheet
is byte-identical to the one before (compared string against string). `tests/unit/flight-ui/theme.test.ts`
holds the two together; the boundaries test passes (`src/map` may import `src/core/ui/theme`).

To use: `import { UI_COLORS, UI_FONT_FAMILY } from '@/core/ui/theme';` in `src/map` and delete the copies in
`src/map/theme.ts`; keep there what is the map's own (the weight of labels, the opaque panel and field
fills). The HUD's value weight and its tabular numerals are CSS of the HUD and not in the module: say so
if you want them there too.
