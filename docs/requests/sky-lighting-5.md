Status: withdrawn (the sky package shoots the views itself, commit after 8bb6e85; see Resolution)
From: sky-lighting
Owner path: labs/integration, tests/browser/integration (views of the sky with the real terrain, atmosphere-clouds and ocean)
Blocking: no

## Problem
The sky package's main views can only be staged on the lab stand-in Earth (`LabPlanet`, no atmosphere, a
stand-in cloud shell): render packages may not import each other. So the sun above the limb has never been
seen through an atmosphere (no scattering around the sun, no extinction or reddening of the disc and the
flare, no blue limb in the probe's reflections), and the probe's lighting of a hull over a real cloud field
and the night sky at the automatic exposure are judged on stand-ins (item 13 of
`out/qa/wave2/sky-lighting.md`; both visual critics asked for these views).

## Evidence
- `out/screens/sky/sun-at-earth-limb-leo-flare.png`, `pbr-spheres-leo-day.png`, `pbr-spheres-leo-night.png`:
  flat land shapes, no atmosphere arc, a stand-in cloud shell.
- `out/screens/integration/budget-leo.png` shows that in the integration lab the probe does light the
  vehicle's Earth side plausibly; there is no view there that is about the sky.

## Requested change
Three views in the integration lab (terrain, atmosphere-clouds, ocean, sky and a vessel registered), saved under
`out/screens/integration/` by a spec, each at the settled AUTOMATIC exposure:
1. `sky-sun-at-limb.png`: low orbit (200 km), the sun 5 to 7 deg above the limb, camera on the vessel looking
   at it with the limb in the lower third. Check: the flare is drawn (`sky.status().flareDrawn`), its source is
   dimmed by the atmosphere (`sky.readFlareState().transmittance` below 1 in blue), and the frame has no pixel
   row or column structure further than 10 deg from the sun.
2. `sky-hull-over-cloud.png`: the vessel (or the sky lab's sphere set) over a cloud field in daylight orbit,
   the sun behind the camera's shoulder. Check: a white surface facing the Earth is 0.15 to 0.25 of the same
   surface facing the sun (the critics' reference: Earth-facing white hardware is a blue-tinted light grey
   about a fifth of the sunlit side), and it is black facing space.
3. `sky-leo-night.png`: low orbit on the night side at the settled exposure (after request sky-lighting-3: the
   dark floor), looking along the galactic plane above the limb. Check: Milky Way mean at least 12/255.
Must not change: nothing in `src/render/sky` is needed for this; `createSkyFeature()` is registered as it is
in `labs/sky`.

## Resolution
Withdrawn by the requester: the integration lab's public handle (`window.__integration`: `setSun`,
`setSunInVesselFrame`, `watchVesselFromSunSide`, `handles['sky.createSkyFeature']`) and a free camera on
`window.__lab` are enough to take the views from a spec in the sky package's own paths, so nothing is needed in
`labs/integration` or `tests/browser/integration`. `tests/browser/sky/integration.spec.ts` writes
`out/screens/sky/integration-sun-above-limb.png` (sun 6 deg above the limb, flare drawn and unattenuated, no
row structure beyond 10 deg), `integration-sun-at-limb.png` (0.3 deg: transmittance 0.10 / 0.03 / 0.002; the
exposure of that view is request sky-lighting-10), `integration-hull-over-earth.png` (the vehicle over the
Earth by day) and `integration-leo-night.png` (moonless night side, Milky Way 34/255 over 60 px at EV -6; the
night face and the missing airglow are request sky-lighting-9).
