# Hand-off: shell-menu (wave 4.1)

Running state (kept current while the package is built; the final hand-off replaces this header).

## Done (commit ids)

(nothing committed yet)

## In progress

- Input contexts (`src/input/contexts.ts`), the shell's pure models (`src/shell/*`), the menu store fixture
  (`src/core/fakes/menuStores.ts`).

## Left, in order

1. DOM framework (safe frame, tokens, cards, rows, tab bar, prompt bar, panels publishing scrim rects, spatial
   focus, history trap, reduced motion, UI scale).
2. Screens: title, identity, hub, hangar, pads, briefing, my ships, universe, settings host, controls, credits,
   flight menu, connection states.
3. `data/defs/visuals/credits.json`; the OFL font under `public/assets/ui/fonts`.
4. `labs/shell` over the live scene; menu and transit rigs in `src/camera`.
5. `tests/browser/menu`: keyboard and mouse flow, four resolutions, contrast, credits; screenshots looked at.
6. Requests: the leave-guard rule (`src/app/game.ts` `inFlight`), the pad cycle rule field.

## Decisions and why

(filled as they are made)
