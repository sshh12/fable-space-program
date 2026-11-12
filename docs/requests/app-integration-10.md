Status: open
From: app-integration-v1
Owner path: src/camera (chaseRig.ts, cameraMath.ts; shared-code maintainer), data/defs/vehicles/*.json `cameras.chase` (sim-world-pilot data)
Blocking: no   (visual: the largest gap of the browser mission's pictures)

## Problem
From TLI to the entry interface the default chase view shows the vehicle as a few dozen pixels in the middle of a
black frame, with neither the Earth nor the Moon in sight, or it looks straight into the Sun. Two causes:
1. Distance. The chase distance is one number per vehicle (`VehicleDef.cameras.chase.defaultDistance`, 140 m for the
   whole 100 m launch stack). The rig keeps that distance after every separation, so the 10 m lander stack and the
   capsule are seen from 140 m: about 90 px wide in a 2560 px frame.
2. Direction. In orbit mode the rig's frame is the orbit plane with azimuth 0 along the velocity and the eye
   "behind the nose, 12 degrees above the plane" (`init`, `chaseReferenceFrame`). Nothing looks for a body: at
   105 km above the Moon the eye looks along the track into the Sun with the Moon below the frame; on the
   translunar and trans-Earth coasts the Earth and the Moon are wherever they happen to be, usually out of frame.

## Evidence (browser mission of 2026-11-11, 2560 x 1440, chase view, nothing touched by the player)
- `out/screens/mission/07-tli-complete-chase.png`: the stack tail-on into the Sun at 300 km; a starburst fills the
  frame; the Earth, 300 km below, is not in it.
- `out/screens/mission/08-moon-soi-enter-chase.png`: the lander stack is about 90 x 50 px in a black frame at
  64,360 km from the Moon; no Moon, no Earth.
- `out/screens/mission/09-lunar-orbit-chase.png`: 105 km lunar orbit; the Sun's starburst in the centre, the vehicle
  a dark speck beside it, the Moon not in frame at all.
- `out/screens/mission/11-lunar-liftoff-chase.png`: the eye below the ascent stage looking up into black; neither
  the ground nor the descent stage left behind is in frame.
- `out/screens/mission/12-moon-soi-exit-chase.png`, `13-earth-perigee-targeted-chase.png`: the ascent stage and
  capsule tiny on black at 360,000 km.
- `out/screens/mission/14-entry-interface-chase.png`: the capsule at 121 km; the eye looks away from the Earth.
- `out/screens/mission/10-lunar-touchdown-chase.png`: the lander is about 130 px of 1,440 (same distance problem).

## Requested change
In `createChaseRig` (generic: no body or vehicle id in code):
1. Default distance from the vessel as it is now, not from the vehicle as launched: when the rig (re)initialises,
   and when the active vessel's `boundingRadius` changes by more than a factor (a separation, a jettison), ease
   the default to `k x boundingRadius` (about 3.5 radii fills a third of the frame height at 55 degrees), clamped
   to the vehicle's `minDistance` / `maxDistance`; a distance the player set with the wheel since the last change
   is kept as a multiple of the radius. `cameras.chase.defaultDistance` then only applies to the full stack (or
   becomes `defaultRadii` in the data).
2. A default direction that keeps the nearest body in frame where possible: when the rig initialises without a
   previous camera, when the reference body changes (SOI change) and when the navball mode changes, choose the
   azimuth / elevation so that (a) the eye is on the side of the vessel away from the dominant body (the body of
   the SOI when its angular radius from the vessel exceeds a few degrees, i.e. roughly below 20 radii; otherwise
   whichever of the SOI body and its parent subtends more), elevated so the vessel sits in the lower-middle of the
   frame and the body's limb crosses the frame behind it, and (b) the Sun is at least about 25 degrees outside
   the frustum where (a) allows (the starburst otherwise covers the vehicle: pictures 07 and 09). In low orbit
   this is the classic "over the shoulder, planet below" view; far out it puts the Earth or the Moon as a disc
   behind the vehicle. The player's orbiting (drag, arrows) overrides it as now and is kept until the next
   SOI / mode change or the reset key.
3. Expose both as options with these defaults (`ChaseRigOptions.frameBody?: boolean` default true,
   `distanceRadii?: number`) so the app and the labs can pin the old behaviour; say in the resolution what the app
   should pass. The app wires whatever results (`createChaseRig({ defs, terrain, ... })` in `src/app/game.ts`).

Must not change: the surface-mode view on the pad (request app-integration-3: the starboard-side view clear of
the tower), the continuity rule when switching from another view ("start behind the previous view direction"),
terrain clearance, `setOrbit`.
