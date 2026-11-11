Status: resolved (commit c3568bf)
From: cockpit
Owner path: src/render/vfx/plasma.ts (the reentry plasma seen by a camera INSIDE the vessel)
Blocking: no (the cockpit's own part of QA item 9 is done; what is seen through the glass during entry is yours)

## Problem
During entry nothing shows in the cabin windows of the integrated scene: the panes are black while
`plasmaIntensity` is 0.85. From inside a capsule at peak heating the windows are the brightest thing in the
cabin: a pink-magenta to salmon field crossed by fine streaks, with a hot core at one edge
(`out/qa/ref/reentry-chutes/eft1-plasma-side-window.jpg`). The cockpit lights its cabin through the windows
with the plasma's colour (brief: "reentry plasma colours the cabin through the windows (read
plasmaIntensity)"), so with black windows the cabin is lit pink by a source nobody can see.

## Evidence
`node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g reentry`
(the integration lab, `scene=reentry&hud=0&paused=1`, the seat view looking up at the forward windows):
`out/screens/cockpit/world-reentry-plasma.png`: both forward panes are black (0-10/255) with the cabin's
reflection in them; the cabin is evenly pink. The lab reported terrain, vehicle, cockpit, ocean, sky,
atmosphere and vfx loaded and no problems. In the cockpit's own lab the stand-in sky paints a glow there
(`out/screens/cockpit/reentry-plasma.png`), which is what the cabin's light was tuned against.
I did not find a branch for an interior camera in `plasma.ts`; the volume is marched in a box aligned with
the flow around a shape proxy of the vessel, and the eye is inside that proxy.

## Requested change
The shock layer and the sheath visible from a camera inside the vessel, through the window openings: the
march must start at the eye (inside the proxy) and accumulate the layer beyond the hull along rays that
leave through a window (scene depth already stops the others at the cabin wall), so the panes show the
streaming glow at a luminance that follows `plasmaIntensity`. Please state in the resolution the luminance
(cd/m^2) and the colour the layer has at the leeward windows for `plasmaIntensity` 0.3, 0.6 and 1, or
export a function for it: the cockpit's cabin light then takes the same numbers instead of its own
`lighting.plasmaLuminance` / `plasmaColor` (data/defs/visuals/cockpits/kestrel.json), so the windows and the
light they throw agree. Nothing in the cockpit needs to change for the plasma to show: its panes are drawn
in `drawTransparent` at order 100, after yours, multiplying and adding over whatever is behind them.

## Resolution
`src/render/vfx/plasma.ts` (commit c3568bf). The march now knows when the eye is inside the vessel's shape
proxy (`plasmaBody(I, ro).sd < 0`, i.e. a cabin camera): it then leaves nothing out around the eye (the cut
of the first two radii in front of the lens and the cut round an eye that rides in the wake were what kept the
panes black) and lets scene depth do the work: the hull and the cabin stop every ray but those that leave
through a window, and those cross the shock layer near the shoulder or the sheath streaming past the
afterbody. Nothing in the cockpit had to change.

Seen in the integration lab (`/labs/integration/?scene=reentry&hud=0&paused=1`, `sitInCockpit(16, 40)` and
`sitAtWindowBelow(0.6)`, plasmaIntensity 0.85): `out/screens/vfx/dev/int-reentry-cabin-windows.png` (both
forward panes filled with the pink sheath) and `out/screens/vfx/dev/int-reentry-cabin-lean.png` (hatch
window). At the exposure the cabin sets the panes clip to pink-white: the sheath is far brighter than the cabin
walls, as it should be. (Your own `world.spec.ts` could not be run: `tests/browser/cockpit/world.ts`, untracked
work in progress, imports `labs/integration/features.ts`, whose `import.meta.glob` does not exist under node.)

The numbers, exported from `@/render/vfx` so that the light the windows throw agrees with what they show:

```ts
plasmaWindowRadiance(data: VfxData['reentry'], heatFlux: number, intensity: number, speed: number):
  { luminance: number /* cd/m^2 */; color: Vec3Tuple /* unit luminance */ }
```

(`data` = `loadVfxData(defs).reentry`; the same `heatFlux` and `plasmaIntensity` the vessel's aero state
carries, `speed` = |airVelocity|.) It is the shader's sheath one shoulder radius behind the shoulder, crossed
by a ray from the hull, averaged over its streaks and flicker (the flicker adds +-22 % at 8 to 30 Hz). With
the lab's heat flux (intensity x 3 MW/m^2) at 7.6 km/s: **610 cd/m^2 at 0.3, 1,540 at 0.6, 3,020 at 1.0**,
colour (1.49, 0.85, 1.05) at unit luminance, a pink-magenta (orange at 3.5 km/s, white-violet towards
10.5 km/s). Your `lighting.plasmaLuminance` 320 x plasma^1.5 is about nine times lower at full intensity;
use the function, or set the data to match (the curve is close to 3,000 x plasma^1.3). A window nearer the
shoulder sees more (up to the layer itself, 900,000 cd/m^2 at the stagnation point at full intensity).
