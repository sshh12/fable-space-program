Status: resolved (lead, 2026-11-24: `UniverseRules.pads.meanCycle`)
From: shell-menu
Owner path: src/core/contracts/net.ts (`UniverseRules.pads`), data/defs/rules/*.json
Blocking: no (the pad screen states the pads and the wait per class; the launches per hour wait for this field)

## Problem
The user decision of 2026-11-13 and the LEAD NOTE of 2026-11-12 want the launches per hour shown per class
("a heavy vehicle has the 6 heavy pads (144 an hour)"), computed as `pads x 3600 / cycle` with "the cycle of
the rules" (ARCHITECTURE 5.9, 9.3). `UniverseRules` has no cycle: `pads` states `maxStay`, `safingTime` and
the rest, and the mean cycle (150 s: dwell, lift-off, clearance, 20 s of safing) is only in prose. The menu may
not write 150 as a literal.

## Evidence
`grep -n "cycle" src/core/contracts/net.ts` finds only `cycleVessel`. `src/shell/pads.ts` `launchesPerHour(padCount,
cycleSeconds)` exists and is tested (`tests/unit/shell/model.test.ts`); the shell asks its host for the cycle
(`ShellDeps.padCycleSeconds(rules)`), which returns null today, so the pad screen omits the per-hour figure.

## Requested change
A field `UniverseRules.pads.meanCycle: number` (s, base 'ticks'), default 150 in `DEFAULT_UNIVERSE_RULES` and in
`UNIVERSE_RULE_TIMERS`, stated by every rules document as the lead decides. The app then passes
`padCycleSeconds: (rules) => rules.pads.meanCycle` to `createShell` (one line); nothing in src/shell changes.
Nothing else in the contract should change.

## Resolution (lead, 2026-11-24)

`UniverseRules.pads.meanCycle: number` (s; `'pads.meanCycle': 'ticks'` in `UNIVERSE_RULE_TIMERS`), default 150
in `DEFAULT_UNIVERSE_RULES`, so every rules document has it (a rules file is the default with its own values
over it; no file under `data/defs/rules` changed). It is the PLANNING number (dwell, lift-off, clearance and
safing of one launch as the complex is sized with, ARCHITECTURE 5.9 and 9.3); no timer of a pad is run by
it. The app's one line is yours: `padCycleSeconds: (rules) => rules.pads.meanCycle`. Launches per hour by
the class of the vehicle with the release complex: heavy 144, medium 336, light 600 (ARCHITECTURE 9.3).
The wire's rules document carries the field (`src/net/codec/common.ts`).
