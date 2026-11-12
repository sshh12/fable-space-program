Status: open
From: flight-ui
Owner path: src/app/game.ts (the lead, since the app fixer finished)
Blocking: no

## Problem
The map's obstacle list for the HUD is a copy in the app (`HUD_OBSTACLE_SELECTOR`, src/app/game.ts line 54). It went
stale once already (round 6's housing: requests flight-ui-3 / -7) and the round-6 critique found a map label against
the HUD's speed window (`out/screens/app/leo-map-node.png`, finding 14). The HUD now owns and exports the list.

## Evidence
`src/ui/hud/hud.ts` `HUD_OBSTACLE_SELECTOR` (exported from `@/ui`), identical today to the app's copy.

## Requested change
`import { HUD_OBSTACLE_SELECTOR } from '@/ui'` in src/app/game.ts in place of the local constant. Nothing else
changes (the same rectangles are passed to `features.map.setObstacles`).
