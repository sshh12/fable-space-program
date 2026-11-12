Status: open (loader and data done; the contract field is request core-1, for the owner of src/core/contracts this round)
From: flight-ui
Owner path: src/core/contracts/defs.ts (MilestoneRuleDef), src/core/defs/loader.ts (validation), data/defs/scenarios/*.json (shared-code maintainer; scenario data)
Blocking: no

## Problem
The HUD announces every mission milestone. A milestone rule carries only an id ("TLI_COMPLETE") and a generic
trigger, so the HUD title-cased the id into "Tli Complete", "Moon Soi Enter", "Earth Perigee Targeted" (the
mission video and `out/screens/mission/07-tli-complete-chase.png`, `08-moon-soi-enter-chase.png`). Flight-ui now
words a milestone from its trigger and the definitions' names ("Moon encounter predicted", "Entered the Moon
sphere of influence", "M-1 separation", "Down through 122.0 km", "Splashdown"), which is correct but generic: what
a mission calls a step ("TLI complete", "Entry interface") is the scenario author's word, and English needs the
article the data does not have ("the Moon's sphere of influence", but "Earth's").

## Evidence
`data/defs/scenarios/lunar-direct.json` milestones: `{ "id": "TLI_COMPLETE", "trigger": { "kind":
"encounterPredicted", "bodyId": "moon" } }` - nothing to show but the id. `src/core/contracts/defs.ts`
`MilestoneRuleDef { id; trigger; after? }`.

## Requested change
Add an optional display name to the rule, validated by the loader as a non-empty string when present:

```ts
export interface MilestoneRuleDef {
  id: string;
  /** What the HUD announces when the milestone is reached ("TLI complete"); default: worded from the trigger. */
  title?: string;
  trigger: MilestoneTrigger;
  after?: string[];
}
```

and titles in `lunar-direct.json` (and the QA scenarios if they carry milestones), for example: LIFTOFF "Lift-off",
MAX_Q "Max Q", STAGE_SEP_1 "M-1 separation", FAIRING_JETTISON "Tower and fairing jettisoned", STAGE_SEP_2 "M-2
separation", EARTH_ORBIT "Earth orbit", TLI_COMPLETE "TLI complete", MOON_SOI_ENTER "Entered the Moon's sphere of
influence", LUNAR_ORBIT "Lunar orbit", LUNAR_TOUCHDOWN "Lunar touchdown", LUNAR_LIFTOFF "Lunar lift-off",
MOON_SOI_EXIT "Left the Moon's sphere of influence", EARTH_PERIGEE_TARGETED "Entry corridor targeted",
ENTRY_INTERFACE "Entry interface", DROGUE_DEPLOY "Drogues deployed", MAIN_DEPLOY "Mains deployed",
SPLASHDOWN "Splashdown". Must not change: the ids (the mission tests, the pilot and the flight records key on
them), the triggers, the evaluator. The HUD (`milestoneTitle` in `src/ui/model.ts`) will prefer `title` and keep
the trigger wording for rules without one; flight-ui wires it once the field exists.

## Lead decision (2026-11-11, lead-baseline-v2)
Accepted. The contract part is done: `MilestoneRuleDef.title?: string` is in `src/core/contracts/defs.ts`
(optional, so every scenario file still loads and nothing else changes). Still open, with their owners: the
loader's check that a title is a non-empty string (`src/core/defs/loader.ts`, shared-code maintainer; in wave
3 `sim-core-v2`), and the titles in `data/defs/scenarios/*.json` (scenario data; the wording proposed above is
approved as written). The ids, the triggers and the evaluator do not change, so the mission state hash does
not move. The request stays open until those two are in.

## Resolution (loader and data; shared-code maintainer, 2026-11-11)
- `src/core/defs/loader.ts`: a milestone's `title` is validated as a non-empty string when present (`DefError`
  naming the scenario file and the milestone id).
- `data/defs/scenarios/lunar-direct.json`: the 17 titles of your list, word for word (LIFTOFF "Lift-off" ...
  SPLASHDOWN "Splashdown"). The QA scenarios carry no milestones. Ids, triggers and `after` are unchanged; the
  simulation ignores the field (the headless mission's state hash does not include the definitions).
- `src/core/defs/loader.test.ts`: the field passes through, an empty or non-string title is refused, and every
  milestone of every scenario in `data/defs` has a title without an underscore.
- **Not done here: `MilestoneRuleDef.title?: string` in `src/core/contracts/defs.ts`.** The contracts belong to
  the v2-baseline agent this round; request `docs/requests/core-1.md` asks for the field with your wording.
  Until it is in, the value is in the loaded library and can be read as
  `(rule as { title?: string }).title` in `milestoneTitle`; with the field, drop the cast.

