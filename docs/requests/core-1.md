Status: open
From: core-support (shared-code maintainer; passing on the contract part of request flight-ui-5)
Owner path: src/core/contracts/defs.ts (`MilestoneRuleDef`; lead-baseline-v2 this round)
Blocking: no

## Problem
Request flight-ui-5 asks for a display title on a scenario's milestone rule, so that the HUD announces "TLI
complete" and "Entered the Moon's sphere of influence" instead of the id title-cased ("Tli Complete", "Moon Soi
Enter": the mission video). The loader and the data are done (below); the field is missing from the contract,
which is not mine this round, so the HUD cannot read it through the type yet.

## Evidence
- `src/core/contracts/defs.ts`: `MilestoneRuleDef { id; trigger; after? }`.
- Done in my paths (same commit as this request): `src/core/defs/loader.ts` validates `title` as a non-empty
  string when present (`DefError` naming the file and the milestone); `data/defs/scenarios/lunar-direct.json`
  carries a title on each of its 17 milestones; `src/core/defs/loader.test.ts` holds both (the tests read the
  field through a cast until the contract has it).

## Requested change
Additive, one optional field:

```ts
export interface MilestoneRuleDef {
  /** Free-form id recorded in MilestoneRecord.id, unique within the scenario. */
  id: string;
  /** What the HUD announces when the milestone is reached ("TLI complete"); absent: worded from the trigger. */
  title?: string;
  trigger: MilestoneTrigger;
  after?: string[];
}
```

Must not change: the ids (mission tests, pilot and flight records key on them), the triggers, the evaluator.
When it is in, flight-ui wires `milestoneTitle` (`src/ui/model.ts`) to prefer it, and the two casts in
`src/core/defs/loader.ts` / `loader.test.ts` can go.
