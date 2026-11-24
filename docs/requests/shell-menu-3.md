Status: open
From: shell-menu
Owner path: tools/dev/boundaries.test.ts (src/shell's allowed imports) or src/core/ui (the number formatters)
Blocking: no (worked around by injection)

## Problem
"There is one number rule in the whole game" (frontend-ux 4.3): the menu must use the HUD's formatters of
`src/ui/format.ts`. The boundary table allows src/shell to import only src/core, src/render/core and the vessel
facade, so the shell cannot import them.

## Evidence
`npx vitest run tools/dev/boundaries.test.ts` fails with "src/shell/rulesView.ts imports @/ui/format" when the
shell imports them. Workaround in place: `ShellDeps.format: NumberFormat` (src/shell/format.ts), filled by the
host with `formatNumber`, `formatApsis`, `formatDuration`, `formatDeltaV`, `formatMass`.

## Requested change
Either move `src/ui/format.ts` (pure, no DOM) to `src/core/ui/format.ts` with a re-export left in src/ui, or add
`src/ui/format` to src/shell's allowed imports. After either, the shell imports the formatters and
`ShellDeps.format` is removed (one commit of shell-menu or its successor).
