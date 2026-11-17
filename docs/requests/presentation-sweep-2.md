Status: resolved in the contract and the simulation (lead, 2026-11-17: `PartSnapshot.panel`); the three read sites are the sweep's
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

## Resolution (lead, 2026-11-17): `PartSnapshot.panel`

```ts
// src/core/contracts/sim.ts, PartSnapshot
panel?: { index: number; count: number; of: string } | null;
```

- Set on the one part of a jettisoned fairing PETAL: sector `index` (0-based) of `count`, and `of`, the
  instance id of the fairing part it was a petal of. null for every other part. Optional until the tighten
  step (absent = a producer that does not state it yet).
- It is on the part, not on the module state: the module state is saved and hashed, and nothing new may
  enter it (rule 7a). The simulation already kept the sector (`PartRuntime.panel`); the snapshot now says it.
- **Producer**: `vesselPartSnapshots` in `src/sim/vessel/facade.ts`. `of` is the inverse of the
  construction of the petal's id (`panelInstanceId` / `fairingOfPanel` in `src/sim/vessel/ids.ts`): the
  simulation reads its own id once so that nothing else has to. The instance ids are unchanged (codec corpus
  and golden as they were).
- **The three places.** `fairingPanelOf(part)` is `part.panel?.index ?? null`. `director.ts:357`: the fairing
  part itself leaves the vessel when it is jettisoned (its petals replace it), so the part of a
  `fairingJettisoned` event is the petal with `panel.index === 0` among the parts of the vessels the event
  names (`ev.newVesselIds`: the petals, one vessel each); no id is composed. Where the new vessels are not
  at hand, the same petal is the part with `panel.index === 0` whose `panel.of` is the fairing's instance
  id and whose craft's `parent` (`CraftSnapshot.parent`) is the craft the fairing belonged to (the event's
  `partId` is the fairing's instance id, or its part key `craftId/instanceId` when the vessel has several
  craft: `eventPartId` in `src/sim/vessel/ids.ts`). `labs/vfx/props.ts:205`: `part.panel != null`.
- **For the fakes** (src/core/fakes, yours): a hand-built petal part states `panel: { index, count, of }`;
  every other hand-built part `panel: null`.
- Test: `tests/unit/sim-vessel/snapshotWords.test.ts` ("PartSnapshot.panel").

**What the fake's conformance test shows now** (`tests/unit/fakes/fakeSession.test.ts`, yours): the real
session's parts state `panel`, so the comparison of the first part (line 187) lists `.panel: only in the
second` until the fake's parts state it. It is reached after the two comparisons that request
presentation-sweep-3 turns red first (lines 174 and 185).
