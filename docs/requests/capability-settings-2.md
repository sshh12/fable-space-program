Status: open
From: capability-settings
Owner path: src/render/vehicle/vesselFeature.ts (owned by capability-settings this wave for quality plumbing only; the change is not quality plumbing, so it is the lead's decision), with fleet-data / fleet-models-pads
Blocking: yes for every page that loads the vehicle feature on the full library (the integration lab, the app, the reference images); no for capability-settings (its bench lab works around it)

## Problem
Since fleet-data's commit 7ebd5ee the library holds 7 vehicles whose 33 new parts have no visual definition
yet (their art is fleet-models-pads'). The vehicle feature's `init` warms the visuals of every part of every
vehicle in the library (`vesselFeature.ts` line 480: `for (const vehicle of Object.values(defs.vehicles)) for
(const p of vehicle.parts) visualOf(p.def)`) and `visualOf` reports each part without a visual as an error.
Every page that loads the vehicle feature on the full library therefore starts with about 30 errors: the app
and the bench lab fail `openPage`, and the integration lab quarantines the vehicle feature (its pictures and
the reference images then have no rocket).

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/bench --project=functional`
(2026-11-24 21:10 UTC): `error: [test-api] vehicle: part "azimuth-s2" has no visual definition`, the same for
"wren-1v", "azimuth-interstage", "azimuth-s1", "wren-1", "launch-clamp-s", "pathfinder-bus", "lyra-k", ...
shell-menu's 31201be works around it in its lab by leaving the vessel visuals out.

## Requested change
Warm only the vehicles whose parts all have a visual definition, and report a part without one only when a
vessel that contains it is to be drawn (the `visualOf` call at line 284), once per part. Nothing changes for
meridian-lunar (every part has a visual): the reference images and the budget table are unaffected.
Workaround in capability-settings' own paths meanwhile: labs/bench hands its renderer a library of the
vehicles whose parts all have visuals (the bench shots fly meridian-lunar).
