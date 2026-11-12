Status: open
From: vehicle-pad
Owner path: src/render/vfx (vapour of a fuelled vehicle on the pad, ice shed at lift-off), data/defs/visuals/plumes.json or a section of yours
Blocking: no (critique item 6 of `docs/qa/wave2/vehicle-pad.r1.combined.json`: "frost is invisible ... no vapour"; the frost coat itself is fixed on my side)

## Problem
A loaded cryogenic vehicle is recognised by what comes off it: white vapour rolling from the vent valves and
down the cold flanks, and sheets of ice that fall at lift-off. The vehicle package draws the frost on the skin
(a matte coat between frost lines with bare lanes, rime on the frames and feedlines); vapour and falling ice
are particles, which are yours. The anchor points have been in the part visual files all along and nothing
uses them.

## Evidence
`out/screens/vehicle/frost-prelaunch.png`, `game-pad-noon-300m.png`, `out/screens/app/pad-chase.png` (no
vapour anywhere). Reference: `out/qa/ref/launch-pad/sls-artemis2-launchday.jpg`, `apollo15-saturnv-from-ml.jpg`
(vent plumes drifting downwind, vapour down the flanks), `out/qa/ref/liftoff-ascent/apollo4-liftoff.jpg` (ice).

## Requested change
Everything you need is data or already public:

- **Vent positions**: section `visuals/parts/<partId>` (`getSection(defs, 'visuals/parts/' + def.id)`, or
  `PartDef.visual.params`), parameter `vents`: a list `"azimuthDeg,y,radius,length;..."` in the PART frame
   (azimuth from +Z toward +X, y along the part axis in the part frame, as every part coordinate;
  the vent's mouth is at `bounds.radius + length` on that azimuth, pointing radially outward). Today
  `meridian-m1` has three, the other stages theirs.
- **Frost bands** (where vapour rolls down and ice comes from): the barrels of the part's tanks,
  `PartDef.resources[].tankBottomY .. tankBottomY + tankHeight` for resources with `tankHeight > 1`, at radius
  `PartDef.bounds.radius`; a part frosts when its visual parameter `frost` is greater than 0 (default 1 for
  the generator `stage.tank`).
- **How much frost there is now**: `VesselVisualFeature.anim(vesselId, instanceId).frost` (0..1; 1 on the pad
  while loaded, falling to 0 within about half a minute of lift-off). The app holds the feature
  (`features.vessels`); if you would rather not depend on it, the same rule is two lines: 1 while
  `vessel.situation === 'prelaunch'`, then `exp(-t / 9 s)`.

Wanted: (1) a thin white plume at each vent while frost > 0.5 (boil-off: a few metres long, drifting with the
wind, denser on the oxidiser vents), (2) a faint sheet of vapour sinking down the frosted barrels (cold air
falls: it hugs the skin and spills off at the frost line), (3) at lift-off, for about ten seconds, flakes and
sheets of ice falling from the frost bands (count following how fast `frost` falls), lit by the plume.

Must NOT change: nothing of mine. I do not draw any of this (the mesh system has no transparent materials).

Workaround in my paths: none.
