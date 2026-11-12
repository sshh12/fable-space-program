Status: open
From: cockpit
Owner path: src/render/vfx/plasma.ts (the entry sheath as a camera INSIDE the vessel sees it through the lee-side windows; vfx), and src/render/core/post/exposure.ts (interior metering with a glowing sheath in the windows; shared-code maintainer)
Blocking: no (round-3 critique of the cockpit, photo lens, major: "entry is two frosted pink-white panes in an evenly lit grey cabin"; the cockpit's own half is done, see below)

## Problem
During entry the cabin's light follows `'vfx.plasmaWindow'` (317 / 1,664 / 7,288 cd/m^2 at intensity 0.3 / 0.6 /
1.0: `windowPlasma` in the cockpit's shader chunk; each window's share flickers), so frames, bezels and blankets
near the windows take the sheath's colour. The PANES themselves show what the vfx package draws for an interior
camera, and that is a flat field: (246, 237, 239) with a spread of 222 to 247 over the whole opening, no streak,
no hot edge toward the shoulder, no dark of space above the wake. Two causes, neither in the cockpit's paths:
1. vfx: the sheath seen from inside has no structure across a window (the published radiance is "averaged over
   the streaks"; the streaks themselves do not show).
2. core: the interior meter keys the cabin and lets the sheath clip (it weighs a sunlit world in the windows
   since 038cf6f / 06c9167, but not an emissive volume): at 1,664 cd/m^2 against a cabin of about 100 cd/m^2 the
   panes sit four stops over and lose their hue.

## Evidence
`out/screens/cockpit/world-reentry-plasma.png` (integration lab, `scene=reentry`, spec
`tests/browser/cockpit/world.spec.ts`; panes at x 880-1010, y 215-610 and x 1200-1440, y 300-620).
Reference: `out/qa/ref/reentry-chutes/eft1-plasma-side-window.jpg` (a pink-magenta to salmon field, mean
(120, 95, 109), crossed by fine bright streaks, a white-yellow core at one edge, black space above the shock).

## Requested change
1. vfx: for a camera inside the vessel, give the sheath along a window's line of sight its streaming structure:
   streaks along the flow (from the shoulder toward the apex) whose mean is the published `plasmaWindow` value,
   a brighter band toward the shoulder side of each window and a fall-off to black toward the lee side, moving
   at the flicker's rate. The published value and its meaning must not change (the cabin's light is built on it).
2. core: let the interior meter weigh emissive volumes seen through the windows as it weighs the sunlit world
   (the same share-of-frame rule), so that panes filled by the sheath are exposed to keep their colour and the
   cabin falls low-key beside them, as in the EFT-1 frames.
Workaround in the cockpit's paths: none that would not paint the sheath a second time on the glass.
