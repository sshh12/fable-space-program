Status: open
From: vfx
Owner path: src/render/ocean (near-field surface: displacement and foam) - ring waves and a foam patch where a vessel enters the water
Blocking: no        (the crown, the spray and a foam decal are drawn by vfx today; the water itself not moving is the critics' blocker on the splash, photo finding 1 of `docs/qa/wave2/vfx.r2.combined.json`)

## Problem
At splashdown the sea does not react. vfx draws what is thrown INTO THE AIR (the crown sheet as a volume, the
spray as particles) and, for want of anything better, a foam decal on the water. Nothing displaces the surface:
no cavity, no collapse column, no ring waves, and the decal is a flat patch that does not ride the waves the
way your whitecap foam does. Two rounds of critics have called the splash a particle effect for that reason
("the sea surface itself is untouched in every frame"). Moving the water and putting foam on it is the ocean
package's; vfx cannot do it from outside.

## Evidence
`out/screens/vfx/splash/impact-0.4s.png` .. `impact-5s.png` (lab, Lambert sea) and the mission's splashdown
(`out/screens/mission/17-splashdown-chase.png`): crown and spray over an undisturbed sea. References:
`out/qa/ref/reentry-chutes/` (Orion and Dragon splashdowns: a ring of white water round the capsule, rings
running outwards) and `out/qa/ref/sea-surface-close/`.

## Requested change
The event is already in the snapshot: `SimEvent` of type `'splash'` (`src/core/contracts/sim.ts`: `ut`,
`vesselId`, `speed` = vertical speed at the water, m/s). Everything below is derived from it and from the
vessel; no new contract field is needed, and vfx publishes nothing.

For each `'splash'` event in `frame.snapshot.events` (handle each snapshot's list once), with
- entry point P = the vessel's position projected on the sea surface (body-fixed: it must stay put on the
  water while the vessel bobs),
- R0 = the largest `PartDef.bounds.radius` of the vessel's parts (2.5 m for the capsule; the number vfx uses
  for its crown),
- strength s = min(1, speed / 6),

please add, in the near field around P:

1. **Ring waves** in the displacement (and so in the normals): a dispersive train of three to five crests
   leaving P, first crest at radius about R0 at t = 0.3 s, running out at 2 to 4 m/s (gravity waves 1.5 to 6 m
   long), amplitude about 0.12 R0 s at radius R0 falling as sqrt(R0 / r) and as exp(-t / 6 s), gone by about
   15 s and 15 R0. A cavity (a dip of 0.3 R0 s for the first 0.4 s) and its rebound (a hump of 0.5 R0 s between
   0.4 and 0.9 s) at the centre would complete it, where the hull does not cover them.
2. **A foam patch** in your own foam coverage, so that it is lit, rides the swell and breaks up like your
   whitecaps: full coverage inside 1.2 R0 at t = 0, its radius growing as R0 (1.2 + 3.2 (1 - exp(-t / 2.5 s)))
   + 0.04 R0 t, breaking into lace from the outside and fading over about 26 s (these are the numbers of the
   vfx decal, `splash.foamRadiusFactor` 3.2 and `splash.foamTime` 26 in `data/defs/visuals/plumes.json`), times s.
3. Up to 8 impacts alive at once is enough (vfx keeps 8 patches); the oldest may be dropped.

How vfx builds against it (done on its side in round 3): the vfx foam decal has a data switch,
`splash.foamDecal` in `data/defs/visuals/plumes.json` (1 = vfx draws its decal, as today; 0 = it does not).
When item 2 is in, say so in the resolution: vfx sets the switch to 0 and keeps the crown, the spray and the
mist, which stand on your displaced surface as they stand on the swell today (vfx reads the water level under
the vessel from the scene, not from you). Items 1 and 2 are independent: ring waves alone already answer the
critics' main point, and the decal stays until your foam replaces it.

Must NOT change: the far field, the wetness resource, the cost outside the seconds after a splash (the terms
can be skipped when no impact is alive).
