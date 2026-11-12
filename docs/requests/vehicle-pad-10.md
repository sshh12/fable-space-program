Status: resolved (c9656d7, 32df5d0: within 8 m of the camera the contact shadow counts occluders two cascade texels thick that are thin, touch the receiver or are entered through a visible face; the band beside the grab bar 28.5 px and ragged -> a line of 15.3 px; its edge is still half resolution, see the resolution)
From: vehicle-pad
Owner path: src/render/core/lighting/ao.ts (screen-space contact shadow march), deferred.ts (its upsample)
Blocking: no (critique item 11 of `docs/qa/wave2/vehicle-pad.r1.combined.json`, major; worked round on my side for the one fitting in the hero view)

## Problem
A thin fitting that stands a few centimetres off a surface (a grab rail, a handle, a cable on stand-offs) gets
its shadow from the screen-space contact march, because the gap is under a texel of the vessel's finest shadow
cascade. The march resolves such a caster as noise: beside the rail lies a ragged black band with a furry,
speckled edge, wider than the rail itself. In orbital sunlight the real shadow is a razor-edged line of even
width.

## Evidence
`out/screens/vehicle/capsule-hatch.png` of 2026-11-12 01:00 (x 400-480, y 270-535 and x 525-565, y 335-415;
live capture, 72 frames of temporal accumulation). `src/render/core/lighting/ao.ts`: 10 jittered steps at half
resolution. Reference: `out/qa/ref/spacecraft-hardware/orion-a2-inflight.jpg` (every fitting has a hard, clean
shadow).

## Requested change
In the contact march, for pixels within a few metres of the camera: (1) full-resolution depth for the march
(or a depth-aware upsample that does not smear a one-pixel occluder over its neighbours), (2) the per-pixel
offset from a blue-noise sequence that the temporal filter integrates (so that 72 frames converge to a clean
edge), (3) a thickness test: a caster thinner than the march step shadows only the samples behind it, so a
thin caster gives a thin shadow.

Must NOT change: the reach of the march, its cost at distance (the 0.3 ms line of the lighting budget).

Workaround in my paths: the capsule's hatch handle is now a solid pull bar on a base plate (no gap under it).
Other stand-off fittings (the lander's ladder, cable stays) are far enough from their surfaces to be resolved
by the cascades.

## Maintainer's note (core-support, 2026-11-12: read, not started)
Not built in this round (it arrived behind three blocking requests and one GPU slot for eight agents; it is
not blocking and has its workaround). What the march does today (`src/render/core/lighting/ao.ts`, fragment at
half resolution): 10 steps over `marchLen = max(0.3 m, 1.5 % of the distance)` towards the sun, the step
offset from `blueNoise().z` (so part 2 of the request is in place: the resolve integrates it), and a sample
counts as blocked when the depth buffer's surface is in front of the ray by less than
`thickness = 0.6 x marchLen` (18 cm and more). The result is 0 or 1 per half-resolution pixel. Where I would
start: (3) the thickness: a rail 2 cm thick shadows everything within 18 cm behind it, which is the band
"wider than the rail"; a thickness of a few centimetres within some metres of the camera (growing with the
depth's footprint beyond) gives a thin caster a thin shadow, with steps no longer than the caster is thick
for those pixels (10 steps over 0.3 m are 3 cm each: a 2 cm rail is missed by some jitters, which is the
speckle); (1) is half in place: the march itself reads the full-resolution depth (`scene.depthOpaque`, one
pixel of each 2 x 2 block picked by blue noise), it is the RESULT that is half resolution, one bit per
pixel, and the lighting pass upsamples it with four depth-weighted taps (`deferred.ts`): a line one pixel
wide is carried by whichever pixel of the block was picked in that frame. For pixels within a few metres
the contact term would have to be marched at full resolution (in the lighting pass, or a full-resolution
contact target for the near field). (Corrected 2026-11-12: this note first said the march read a
half-resolution depth; it does not.)
Cost to watch: the `core.ao` line at 1440p (`tests/browser/render-core/core.perf.spec.ts`); an interior
view has the whole frame within those few metres.

## Resolution (shared-code maintainer, c9656d7 and 32df5d0, 2026-11-12)

The march has rules for the near field now (`src/render/core/lighting/ao.ts`, `ContactShadowParams`;
RENDER_API section 13, "The contact shadow near the camera"). Your three points, and what was built:

1. *Full-resolution depth.* It had it (my first note here was wrong, corrected above): the march reads
   `'scene.depthOpaque'`. Its RESULT is still half resolution, one bit per pixel. Not changed: see what is
   left, below.
2. *The offset from a sequence the resolve integrates.* In place before (`blueNoise().z`).
3. *A thickness test.* This was the fault. The rule was "a sample that lies behind a surface by less than
   18 cm is shadowed": everything whose ray passed within 18 cm BEHIND the rail's silhouette, as the camera
   sees it, was shadowed (the band wider than the rail), or not, by where the ten 3 cm steps fell (the furry
   edge). Within 8 m of the camera now: an occluder is two texels of the finest sun cascade thick (2.3 cm
   outside); it counts only if it is thin (the ray is seen again within two thicknesses), touches the
   receiver (a contact line), or the ray enters its visible face (the cascade draws the shadows of the
   rest); where the ray goes behind a surface between two samples, the place is found by bisection; a
   surface point in the receiver's own plane never occludes; 20 samples. Beyond 8 m the march is as it was
   (its reach of max(0.3 m, 1.5 % of the distance) is unchanged everywhere).

Measured on your view (`tests/browser/integration/contact.spec.ts`: the vehicle lab,
`stage=8&sunv=0.85,0.45,-0.1&eye=1.0,1.8,-3.4&at=0,1.2,-1.2&fov=40`, live, 90 frames per rule set; the dark
band beside the left grab bar, x 395-485, y 270-535, pixels under 40 % of the row's bright level; run of
19:00, your bar as it is since your last round):

| rules | band, px | spread over the rows, px | picture (`out/screens/integration/`) |
|---|---|---|---|
| as it was | 28.5 | 7.8 | `contact-hatch-legacy.png` |
| no contact shadow | 10.6 (the bar's own dark side: it casts no shadow at all, the cascade does not see it) | 3.8 | `contact-hatch-off.png` |
| the plane, the bisection, 2 texels, every occluder | 23.6, a speckled gap between bar and shadow | 6.3 | `contact-hatch-refine.png` |
| and only thin or touching occluders | 15.5 | 4.3 | `contact-hatch-thin.png` |
| the game's rules (and occluders entered through a visible face) | 15.3 | 4.4 | `contact-hatch-default.png` (written by the run that is queued; the same rule set is `contact-hatch-cross.png` of 19:00) |

The crops side by side: `contact-hatch-sheet0.png`. The shadow is a line as wide as the bar, standing off
it by the gap the bar stands off the hull, with an L at its foot.

Cost (the `core.ao` pass): 0.118 ms at 1440p under load (`core.perf.spec.ts`, line 0.6); on your view, idle
GPU, 0.048 -> 0.059 ms. Nothing changes beyond 8 m.

What is left. The line's edge is not razor-sharp: it is one bit per half-resolution pixel, smoothed by the
resolve (live) or rough by a pixel (frozen noise: `contact-hatch-frozen-sheet0.png`). A full-resolution
contact term for the near field would cure that; it is not built (a second march or a full-resolution
target: the cost is the whole frame from a cabin). Re-open with a frame if it shows.

Your workaround (the solid pull bar) is not needed for the shadow any more. I did not run your suite; your
`capsule-hatch.png` is in the queued run with the game's rules.
