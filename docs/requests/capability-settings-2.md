Status: resolved (presentation-sweep; the commit that adds this section)
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

## Resolution (presentation-sweep, 2026-11-24; lead decision)
A vehicle is PRESENTABLE when every one of its parts has a visual definition. This is derived from the
definitions in one place, `src/core/access/presentable.ts` (docs/RENDER_API.md section 21):

- `isPresentableVehicle(defs, vehicleId)`: the rule;
- `presentableVehicleIds(defs)`: **the member the menu uses** (shell-menu offers these vehicles only);
- `firstPresentableVehicleId(defs)`: for a lab or a test that took "the first vehicle of the library";
- `presentableVehicles(defs)`, `presentableLibrary(defs)` (the library with the presentable vehicles and their
  scenarios: what a bench or a lab hands its renderer instead of filtering by hand), `isPresentableVessel(defs,
  vessel)`, `partHasVisual`, `partsWithoutVisual`.

What changed:

1. The vessel feature builds at `init` the models of the presentable vehicles only. Nothing is built, logged or
   thrown for the others.
2. A vessel of a snapshot one of whose parts has no visual is not drawn at all, and the feature names its
   vehicle ONCE in `VesselVisualFeature.status()` (`{ notPresentable: { vehicleId, parts }[] }`;
   `stats.notShown` counts the vessels passed over). This is DIFFERENT from what the request asked for (an
   error report once per part where a vessel is drawn): the lead decided that a data-only scenario in a lab
   must not fill the page with errors, so there is no `reportError` and no console line at all.
3. The effects draw nothing of such a vessel (plume, plasma, trail, canopy, effects at its events), and the
   cockpit feature does not draw its cabin.
4. The app's default scenario (`defaultScenario` of src/app/settings.ts: a page opened without `?scenario=`)
   is the first mission scenario in id order whose vehicle is presentable. Since fleet-data's scenarios it had
   become `fleet-azimuth-pathfinder`; it is `lunar-direct` again, by the rule and not by name.
5. Checked and left as they are: `loadVfxData` and `checkPartSounds` hold every engine definition to a plume
   look and a sound profile (all 58 parts of the library have theirs); the engine voices follow the simulation;
   the site feature builds an empty runtime for a pad without structures (the 24 new pads); the cockpit feature
   builds one model per cabin layout, not per vehicle; the HUD reads the craft of the snapshot, not the table
   of vehicles.

For capability-settings: `labs/bench/main.ts` hands its renderer `presentableLibrary(library)` (its commit
6cd05e1) and the integration lab's `&withart=1` is the same call: no page filters the library by hand any more.
Neither is needed for the errors of this request: the vessel feature no longer reports the vehicles it cannot
show.

Proof: `tests/unit/fakes/presentable.test.ts`, `tests/unit/vfx/director.test.ts`,
`tests/browser/integration/presentable.spec.ts`; the lunar stack's picture is unchanged (reference checkpoints
at 0 pixels under look 1).
