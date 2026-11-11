Status: open
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
