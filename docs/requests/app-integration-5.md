Status: resolved (cockpit: 27fb5c8 the cabin, 38da0ee the displays; core: nothing to change, see "Core half")
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

## Resolution

The cockpit's part, in `src/render/cockpit/shaders.ts` (`pack` and the attitude ball's record): the cabin's light is
complete in the emission it writes (RT5), and its G-buffer record is now built so that the core's deferred pass
adds nothing to it whatever lights it runs: albedo 0, metallic 1, roughness 1, ambient occlusion 0, material
standard (never cloth). Diffuse response 0; specular with f0 = 0, i.e. Schlick's `(1 - LoH)^5` alone under a fully
rough lobe: about 1/1000 of a dielectric's specular at the usual angles and none head-on. For the 5e8 cd capsule
light 110 m below the cabin in your probe (about 4e4 lux) that is of the order of 1 cd/m^2 on a cabin at
10-30 cd/m^2, where the old record (painted albedos, 0.04 Fresnel) gave hundreds. Light from outside still
enters only through the cockpit's own window model (the sun through the apertures and the cabin sun map, the
sky / Earth / plume through each window's prism from the environment probe), as the request asks. Nothing of
the plume lighting the hull, the pad or the ground changes. A core-side mask on `LocalLight` is therefore not
needed for the interior; re-shoot `/labs/integration/?scene=ascent&throttle=1` with `sitInCockpit(0, 0)`.

## Follow-up (app-integration-v1, after 27fb5c8)
Re-shot in the app (`tests/browser/app/app.spec.ts` "a short real flight", cockpit view at 1 km, engines at full
throttle): the cabin is right now (grey couches and panel, cabin exposure as on the pad). The two MFD screens are
not: both pages are a flat peach / cream field with the page content faint in it (`out/screens/app/climb-cockpit-1km.png`),
where the same displays before ignition are dark with legible pages (`out/screens/app/pad-cockpit.png`). The plume's
lights (or whatever gives the peach) still reach the display surface or its cover glass. Requested: the same rule for
the displays' record (and their glass) as for the cabin's.

## Core half (shared-code maintainer, 2026-11-11)
Nothing changes in `src/render/core`, and nothing needs to:

- The deferred local-light pass lights a pixel by its G-buffer record alone, and that is right for everything
  outside the cabin (the hull, the pad, the ground under a plume). A cabin pixel is the cockpit's record: since
  27fb5c8 the interior writes a black, fully rough metal with ambient occlusion 0 and carries its whole light in
  the emission target, so no light of any feature adds to it, the core's sun and planetshine included.
- The follow-up (the two display pages washed out peach in the climb) was the one interior surface that still
  wrote another record: the displays were `MATERIAL_ID.display`, which the core lights as a glossy dielectric
  with every local light (correct for a display on an exterior panel). The cockpit changed that in 38da0ee
  (`src/render/cockpit/shaders.ts`, the display fragment: the interior's record, the image and the sun on the
  panel complete in the emission). The cover glass is drawn by the cockpit's own transparent shader, which does
  not sample `FrameContext.lights`.
- A flag or mask on `LocalLight` (the request's second way) would be a contract field plus a mask in the light
  uniform and in every forward-lit shader that includes `local_lights`; with both interior records inert it would
  have no pixel left to act on, so it is not added.

To check: `tests/browser/app/app.spec.ts` "a short real flight" (`out/screens/app/climb-cockpit-1km.png`: the
display pages legible as in `pad-cockpit.png`), or the lab `/labs/integration/?scene=ascent&throttle=1` with
`window.__integration.sitInCockpit(0, 0)`. If a surface of the cabin still takes the plume's colour there, it
writes a record of its own: name it here and reopen.

