Status: resolved (commit 03242a3)
From: cockpit
Owner path: src/render/core/shaders/chunksLighting.ts
Blocking: no (visual quality of sun patches in cockpit close-ups)

## Problem
Inside the cabin the sun enters only through the windows, so every sunlit surface ends in a window-shaped
patch whose edges are the cascade-0 penumbra. With the vessel-anchored 24 m cascade (1.17 cm texels) the
filter radius is the minimum kernel (1.5 texels, about 1.8 cm), and the 12 taps rotated per pixel by the
blue noise leave a coarse, static-looking speckle along the patch edges after TAA (the noise has a high
contrast at a sharp lit/unlit edge, so the history clamp keeps much of it). At the cockpit's viewing distance
(0.4 to 1 m) a 2 cm speckled band is several tens of pixels wide; real sun patches through a window at 1 m
have a 0.5 cm penumbra (blocker distance x sun angular diameter) and a smooth edge.

## Evidence
`/labs/cockpit/?scene=leo&aim=switches&fov=26` and `?scene=leo` (sun through the right side window onto
MFD 1): `out/screens/cockpit/closeup-switches.png`, `out/screens/cockpit/leo-sun-patch-console.png`, the
grain at the right-hand patch edge. Same speckle in `closeup-fdai.png` on the blanket.

## Requested change
Any of: (a) for an every-frame vessel-anchored cascade with an interior camera, more taps (or a fixed
rotated grid instead of per-pixel blue-noise rotation) when the penumbra is at the minimum kernel, where the
stochastic rotation buys nothing; (b) a smaller cascade-0 radius for interior cameras (6 m covers any
capsule cabin plus the room for its shadows), halving the texel; (c) feed the shadow term through the TAA
history with a wider clamp. Must not change: exterior shadows, cascade planning for external cameras.

## Resolution
Option (b), as the smallest change that touches nothing outside (core-support, commit 03242a3): cascade 0 of
an INTERIOR camera (the vessel-anchored one) is 6 m in radius instead of 12 m
(`INTERIOR_CASCADE_RADIUS` in `src/render/core/shadows/cascadeMath.ts`). The texel is 0.59 cm instead of
1.17 cm, so the smallest penumbra (1.5 texels) is 0.9 cm instead of 1.8 cm, close to the 0.5 cm a real
window edge gives at 1 m, and the grain of the 12 rotated taps is confined to a band half as wide.
Exterior cameras, the other cascades and the planning for external views are unchanged (unit test
"anchors cascade 0 to the vessel frame for an interior camera" asserts both).

What it does not change: the taps are still rotated per pixel. Options (a) and (c) were not taken now:
(a) a fixed grid at the minimum kernel trades the grain for a visible regular pattern on a straight patch
edge, and (c) a wider history clamp for the shadow term would have to be a separate shadow buffer, which
the deferred pass does not have. If the grain is still objectionable in `closeup-switches.png` with the
6 m cascade, file the screenshot: the next step is a 16-tap kernel for every-frame vessel cascades.

Consequences for you: receivers farther than 6 m from the eye (the nose or the lander seen through a
window) take the 60 m cascade (5.9 cm texels); casters towards the sun are caught at any distance as
before. Re-run your sun-patch screenshots.
