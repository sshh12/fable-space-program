Status: open
From: presentation-sweep
Owner path: src/core/contracts/sim.ts (the lead), src/sim/vessel (the producer)
Blocking: no (the acceptance line "no consumer takes an id apart" is not fully met without it: two places remain)

## Problem
A petal of a jettisoned fairing is a vessel of its own whose one part has the instance id
`<fairing instance id>#panel<k>` (src/sim/vessel/public.ts, `splitForStage`). The petal index `k` is what
the vessel feature needs to draw the right petal, and the snapshot states it nowhere but in that id. So the
presentation still reads an id in two places:
- `fairingPanelOf` in `src/render/vehicle/vesselFeature.ts` (a regular expression on the instance id; the
  sweep made it the one function that does so);
- `src/render/vfx/director.ts:357`, which composes `${partId}#panel0` to find the part of a
  `fairingJettisoned` event.
`labs/vfx/props.ts:205` also tests the id (`includes('#panel')`).

## Evidence
`grep -rn "#panel" src/render src/sim/vessel labs --include=*.ts`

## Requested change
State the petal as a field. Either on the module state, `{ type: 'fairing'; jettisoned: boolean; panel:
number | null }` (null for the whole fairing), or on `PartSnapshot` (`panel?: number`). With it the three
places above compare a field, and the instance id of a petal is opaque like every other id. The producer
is `src/sim/vessel/facade.ts` (`vesselPartSnapshots`); hand-built states are in `src/core/fakes` and the
labs' lab vehicles. What must NOT change: the instance ids themselves (codec corpus, golden).
