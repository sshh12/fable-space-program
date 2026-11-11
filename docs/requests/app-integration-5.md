Status: open
From: app-integration-v1
Owner path: src/render/cockpit (how the interior takes local lights) and src/render/core (deferred local lights; shared-code maintainer)
Blocking: no

## Problem
In the cockpit view with the engines burning, the whole cabin is lit evenly in the plume's colour, as if the hull
were not there: the vfx feature registers its plume lights (capsule lights of 2e8-5.5e8 cd about 110-140 m below
the eye in the climb, 4.3e7 cd point lights at ignition) in `FrameContext.lights`, and the deferred local-light
pass lights every G-buffer pixel inside their range, the cabin's included. The interior meter then exposes for
that light (EV100 8.1 in the climb against 2.5 on the pad before ignition): the couches, the panel and the
displays turn into one flat beige relief, the MFD pages are washed out, and the picture stays so for the whole
powered ascent. Light from the plume can only enter the cabin through its windows.

## Evidence
- App: `out/screens/app/climb-cockpit-1km.png`, `out/screens/app-probe/cockpit-300m.png` (beige cabin), against
  `out/screens/app/pad-cockpit.png` (same seat before ignition). Probe (`window.__app.exposure()`,
  `window.__app.frameLights()`): pad EV100 7.4 adapting to target 2.5, no lights; 30 frames after ignition three
  4.3e7 cd point lights and three capsule lights at 107-112 m; at 300 m and 1.2 km EV100 8.1 with capsule lights
  of 5.4e8 / 2.0e8 / 3.1e7 cd at 141 / 115 / 107 m; engines cut at 1.4 km: lights fall to 1.2e7 cd and the
  target to 4.2.
- Integration lab, the same without the app: `/labs/integration/?scene=ascent&throttle=1`,
  `window.__integration.sitInCockpit(0, 0)`: EV100 8.24, cabin beige (`out/screens/app-probe/lab-ascent-cockpit.png`);
  with `&without=vfx`: EV100 2.26, the cabin as designed (`lab-ascent-cockpit-novfx.png`).

## Requested change
Exterior local lights must not light the cabin interior except through its windows. Two ways that keep the
packages apart (the owners choose): the cockpit marks its interior pixels so that the core's local-light pass
skips lights the cockpit has not registered itself (the cabin then takes outside light only through its own
window model, as it already does for the sun), or the core gives `LocalLight` an optional flag/mask that the
cockpit's interior material excludes. Must not change: the plume lighting the hull, the pad and the ground; the
cockpit's own cabin lights and the light it lets in through the windows.
