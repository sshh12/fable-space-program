Status: resolved (vfx: `splash.foamDecal` is 0, the foam on the water after a splash is the ocean's alone)
From: ocean
Owner path: data/defs/visuals/plumes.json (`splash.foamDecal`), src/render/vfx/splash.ts (vfx)
Blocking: no        (visual close-out of the ocean, round 3, item 2: the aftermath of the splash in the mission's last scene)

## Problem
Since vfx-9 the foam an impact leaves on the sea is the ocean's (lit, riding the swell, torn by the foam lace). The
vfx decal is still on (`splash.foamDecal` is 1 in `data/defs/visuals/plumes.json`), so in the game two patches lie
on top of each other, and the vfx one keeps the old time course that the round-2 critique of the ocean called an ice
floe: a flat white disc that grows to (1.2 + 3.2) hull radii over 26 s and is opaque for most of that.

## Evidence
- `docs/qa/wave2/ocean.r2.combined.json`, finding 6 (the patch "keeps GROWING to about 600 px at +10 s and is as opaque
  and white then as at +1 s"). The ocean's own patch had the same numbers (they were taken from the decal in vfx-9).
- The ocean's patch as it is now (round 3): `out/screens/ocean/splash-impact-0.2s.png`, `-1s`, `-3s`, `-10s`
  (`tests/browser/ocean/splash.spec.ts`, which also asserts the ageing). Time course, for strength s = min(1, entry
  speed / 6 m/s) and hull radius R0:
  - radius R0 (1.2 + 2.0 (1 - e^(-t / 1.2 s))): 2.3 R0 after 1 s, 3.0 R0 after 3 s, 3.2 R0 at the end; no creep after;
    the rim stands in tongues (0.64 to 1 of that radius by direction);
  - thick white foam for the first 0.6 s, gone as a thick layer by 2.5 s;
  - density 0.95 until 0.8 s, then x e^(-(t - 0.8 s) / 5 s): the lace tears it into strands and holes by 2-4 s
    (58 % cover at 3 s), about 8 % cover in thin strands at 10 s, nothing after 13 s; from 2 s on what is left turns
    from a layer into a film the water shows through;
  - aerated water under and around it (out to 1.3 of the radius): a pale green lift of the water's own colour that
    is strongest at 0.5 s and fades with e^(-t / 4.5 s).
  The numbers are `splashFoamSpread` 2.0 and `splashFoamTimeS` 15 in `data/defs/render/earth.ocean.json`.
  Measured (splash.spec, foam = coverage x opacity on the water in front of the float): 1.3 to 1.7 hull radii out
  0.74 / 0.43 / 0.09 at 1 / 3 / 10 s; 2.1 to 2.9 radii out 0.00 / 0.13 / 0.00.

## Requested change
Set `splash.foamDecal` to 0 in `data/defs/visuals/plumes.json` (the switch vfx built for this in vfx-9): the foam on
the water after a splash is the ocean's alone. What the crown should do: keep the crown, the spray sheet and the mist
exactly as they are, standing on the water as they do now; if their fall-back onto the water (the spray's rain of
droplets at 1-3 s) is to leave white on the sea, it should not be a second disc: the ocean's patch already has the
tongues and the lace under it. If vfx would rather keep a decal of its own for a different look, it should follow
the time course above (stop growing by 3 s, lace by 3 s, a film by 10 s, gone by 15 s) so the two do not fight.

Must not change: the `'splash'` event and its fields (the ocean reads the same event), the crown / spray / mist.

## Resolution (vfx, 2026-11-12)
`splash.foamDecal` is 0 in `data/defs/visuals/plumes.json`. The switch scales one thing, the strength of the
decal's instances (`src/render/vfx/splash.ts`, `FoamRenderer.update`: `p.strength * S.foamDecal`), and the
decal's shader discards every fragment at strength 0: no second disc, no cost. The crown's sheet, the mist
and the spray take the patch's own strength and the `'splash'` event as before: nothing of theirs reads the
switch, and no code changed. No vfx decal of its own is kept (the ocean's patch has the tongues and the lace).

Checked: the vfx unit tests and the definition tests pass with the value 0. No vfx spec asserts the decal
(`tests/browser/vfx`: the splash appears in the matrix sheet and in the exposure test, which reads the sky
only), so no browser run was made for this: the pictures of the mission flight show the result. One thing
to know: the vfx lab has no ocean (a stand-in sea), so its splash sheet (`out/screens/vfx/splash/`) shows no
foam patch at all from now on.
