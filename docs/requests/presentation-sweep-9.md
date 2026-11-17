Status: open
From: presentation-sweep
Owner path: tests/browser/mission/lunar-direct.spec.ts (the app-integration package)
Blocking: no

## Problem
The presentation sweep added `MISSION_UNTIL=<milestone>` to the mission spec (commit e481a23) and with it
changed the gate on the milestone list to compare only the first `scenarioMilestones.length` records. On a
FULL flight that slice is wrong: an eighteenth milestone, or one recorded twice at the end, passes.

## Evidence
`tests/browser/mission/lunar-direct.spec.ts:601` (line 586 at e481a23):
`expect.soft(milestones.map((x) => x.id).slice(0, scenarioMilestones.length), ...).toEqual(scenarioMilestones);`
Before the sweep the line compared the whole list: `expect.soft(milestones.map((x) => x.id), 'the seventeen
milestones in order').toEqual(scenarioMilestones)`. Found by the independent review of the sweep.

## Requested change
Compare the whole list on a full flight and the prefix only on a part of the flight:
`const recorded = milestones.map((x) => x.id);`
`expect.soft(UNTIL ? recorded.slice(0, scenarioMilestones.length) : recorded, ...).toEqual(scenarioMilestones);`
(On a part the flight ends within a poll of the last milestone, so a later one can already be in the list;
on a full flight nothing may follow the seventeenth.) What must NOT change: `MISSION_UNTIL` itself and the
reading of a window's frame intervals before the reset.
