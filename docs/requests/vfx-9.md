Status: resolved (commit 204b6be; run in the browser on 3a58354)
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

## Resolution
Built in the ocean package (ocean lab verified, `tests/browser/ocean/splash.spec.ts`; hand-off `docs/handoff/ocean.md`
section 4 "An impact" and 15.4). For every `'splash'` (and water `'touchdown'`) event of the snapshot, handled once,
planet-fixed at the vessel's point on the sea, up to 8 alive, with R0 = the vessel's `boundingRadius` (2.6 m for the
lab's float; the capsule's is what the snapshot gives, close to your 2.5 m) and s = min(1, speed / 6):

1. **The surface moves** (item 1), in the one displaced surface the mesh, the normals, the readback and the
   waterline use (`oceanRipples` of the chunk "ocean_waves"; no second surface):
   - cavity 0.3 R0 s deep for the first 0.4 s, rebound 0.5 R0 s high between 0.4 and 0.9 s, both a Gaussian of
     0.9 R0 about the centre (the hull stands in most of it; its rim shows round the hull);
   - ring waves of 5 m (phase speed 2.8 m/s) in a train of three to four crests that leaves R0 (first crest there
     after 0.3 s) and runs out at 2.2 m/s, 0.12 R0 s high at R0, falling as sqrt(R0 / r) and e^(-t / 6 s), gone
     after 15 s (then about 36 m = 14 R0 out).
   Measured (splash at 7.8 m/s, R0 2.6 m): centre -0.91 m at +0.2 s, +0.19 m at +1 s; 4-9 m out 0.14 / 0.18 /
   0.10 / 0.003 m at +0.2 / 1 / 3 / 10 s; 30-35 m out nothing until 0.013 m at +10 s.
2. **A foam patch** (item 2) in the ocean's own foam (lit, riding the swell, torn by the foam lace, with the
   thickness and relief of the whitecaps): full inside 1.2 R0 at once, radius R0 (1.2 + 3.2 (1 - e^(-t / 2.5 s)))
   + 0.04 R0 t, thinning from the rim inwards and with age (from 9 s on), fresh and thick for the first 1-3.5 s,
   gone after 26 s, all times s. Your numbers; they are `splashFoamSpread` 3.2 and `splashFoamTimeS` 26 in
   `data/defs/render/earth.ocean.json` (the ocean does not read plumes.json).
3. Up to 8 impacts (item 3); the oldest is dropped.

**You can set `splash.foamDecal` to 0**: the foam is the ocean's now. Crown, spray and mist stand on the displaced
surface as before; note that for the first second the water under the hull is up to 0.9 m BELOW the swell and then
up to 0.5 R0 above it at the centre, if the crown's foot is taken from the water level there.

Pictures: `out/screens/ocean/splash-impact-0.2s.png`, `-1s.png`, `-3s.png`, `-10s.png` (ocean lab, the capsule-sized
float of the `splash` preset): the cavity round the hull, a white patch with a torn rim spreading to about 11 m,
rings running out beyond it.

Cost: nothing while no impact is alive (the loops run over the impacts alive); the far field and the wetness
resource are unchanged. The ocean's own old splash foam (a disc in its wake texture) is off (`wakeFoamPerSplash` 0).

What is left (not done): the same time sequence in the integration lab with the real capsule under chutes. Its
FakeSim sinks the capsule to the sea but emits no `'splash'` event and does not float it, so there is nothing for
the ocean to answer there; it needs the real sim's scenario in that lab (or the lab emitting the event), and then
a look at crown + spray + this water together against `out/qa/ref/reentry-chutes/`.
