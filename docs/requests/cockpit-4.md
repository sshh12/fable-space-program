Status: open
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
