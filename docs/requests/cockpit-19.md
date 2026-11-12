Status: open (the core's share is built in b9347f1: a hint for the panes, see "Answer on the core's share"; it takes effect when the cockpit passes it; the vfx's share, the sheath's structure across a window, is open)
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

## Answer on the core's share (shared-code maintainer, b9347f1, 2026-11-12): the meter takes a hint for the panes

**Built.** `coreOf(ctx).addEmissiveHint(luminance, coverage, true)`: the third argument marks a hint as meant
for an INTERIOR view. It says "the cabin's panes show an emitter of this luminance, and those panes cover
this share of the frame", and the interior meter then counts it as part of the outside seen through the
windows, by the same rule as a sunlit world or the daylight sky in them (request cockpit-16): from 0.2 to
0.8 % of the frame and three to six stops over the cabin's log-average, the cabin is keyed up to 2.25 EV low
and everything beyond the cabin is shown at its own exposure, its brightest tenth three stops over mid-grey.
RENDER_API section 13 (the emitter-hint paragraph), section 18.

**Why a marked hint and not the vfx's own.** The histogram is taken before the transparent pass, so the
meter cannot see the sheath; and the hints the vfx gives for exterior views are sized by the emitter's
ellipse on the frame, without the cabin wall between it and the eye. Only who knows the panes can say what
share of the frame shows it. That is the cockpit: call it from `prepare`, every frame the sheath shows, with
what the panes show of `'vfx.plasmaWindow'` (after the glass) and the share of the frame the panes that face
the sheath cover. An unmarked hint is ignored by an interior view as before, a marked one by exterior and
map views, so nothing changes for anyone until you pass the argument.

**What it gives, by the unit test** (`tests/unit/render-core/exposureGovernor.test.ts`, "an emitter the panes
show"; a cabin of 5 to 40 cd/m^2, nothing lit beyond it, the sheath at 1,664 cd/m^2 in panes that cover 6 %
of the frame):

| | no hint | with the hint |
|---|---|---|
| the cabin's exposure | keyed at mid-grey | 2.25 EV lower (its log-average at about Y 0.04) |
| the panes | 6.9 stops over mid-grey (clipped) | 3 stops over mid-grey (gain 0.29 on what lies beyond the cabin) |

At 0.2 % of the frame nothing, at 0.5 % half; a glow no brighter than the cabin (40 cd/m^2) changes
nothing; with a sunlit Earth in other panes the brighter of the two sets the level.

**Limits.** The gain is on every pixel beyond 8 m and the sky, and on what is drawn over those pixels in
`drawTransparent`: the sheath the vfx draws in the panes is scaled, and so is your glass layer over them
(as stated for cockpit-16). The level is one number for all panes: a pane full of sheath beside a pane full
of sunlit Earth are shown at the exposure of the brighter. Not run in a browser by me: no feature passes
the argument yet; the picture is yours to take once the cockpit does.

The vfx's share (the streaming structure of the sheath across a window) is theirs; the request stays open.
