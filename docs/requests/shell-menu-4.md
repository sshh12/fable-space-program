Status: open
From: shell-menu
Owner path: src/core/ui/theme.ts (`UI_FONT_FAMILY`), src/app (loading the faces before the HUD and the map labels)
Blocking: no (the menu already uses the shipped family; the HUD and the map labels still use the system stack)

## Problem
The brief: one OFL family with condensed widths and tabular figures, self-hosted, and "the HUD and the map label
atlas move to it". The family is shipped (`public/assets/ui/fonts/`, Barlow, Barlow Semi Condensed and Barlow
Condensed, Latin subset, WOFF2, OFL.txt beside them, credited in `data/defs/visuals/credits.json`; `tnum` is in
the fonts). The HUD's and the map's font stack is `UI_FONT_FAMILY` in src/core/ui/theme.ts, the lead's.

## Requested change
1. `UI_FONT_FAMILY = "'Barlow Semi Condensed', Bahnschrift, 'DIN Alternate', 'Segoe UI', system-ui, sans-serif"`
   (or export the three roles as `SHELL_FONTS` of src/shell/dom/kit.ts has them: display, label, body).
2. The app calls `loadShellFonts('/assets/ui/fonts/', reportError)` (src/shell) during boot, before the HUD is
   created and before the map view builds its label atlas (a canvas atlas rasterised before the faces load keeps
   the fallback face). The faces are 7 files, 155 kB in all.
Visual change: every HUD and map picture moves (glyph shapes); the reference images that show the HUD or map
labels need re-recording after it, which is the lead's call.
