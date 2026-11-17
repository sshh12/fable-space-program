Status: open
From: presentation-sweep
Owner path: src/render/atmosphere (the atmosphere-clouds package)
Blocking: no (it predates the sweep; the origin test works around it, see below)

## Problem
The atmosphere draws a low-orbit view in one of two states, decided by which 64-frame boundary of the frame
index the page reaches when it first goes idle. Two loads of one and the same page that stop at the same
absolute frame index agree; two loads that stop 64 frames apart differ by up to 44 to 51 levels in single
pixels. Something in the feature has a phase longer than the 64 frames the temporal sequences are aligned to
(`SEQUENCE_ALIGN`, RENDER_API section 13) and does not start it over.

## Evidence
Found by the independent review of the presentation sweep (2026-11-17), with the procedure of
`tests/browser/integration/origin.spec.ts`, part 2, scene `leo` (the integration lab's `leo` scene, frames
stepped by hand from the first frame index that is a multiple of 64 after `window.__test.isIdle()`):
- two control runs that reach the same absolute frame index: the same picture;
- two control runs 64 frames apart: about 155,000 to 200,000 pixels differ, by up to 44 to 51 levels
  (99.9th percentile 9 to 10; mean 0.15); measured in this package's runs as 154,151 px / 49 levels and
  158,739 px / 50 levels on 0685bd0, and 202,054 px / 68 levels on b46bf4d;
- any pair with `&without=atmosphere`: 0 differing pixels;
- the source of the tag `pre-sweep-2026-11-16` gives the same numbers: not the sweep's.
The frame-exact capture (`renderExact`) is not affected in the recorded reference images (it restarts the
sequences and the features' `resetTemporal()`); a page that is stepped by hand, as a game is, is.

## Requested change
Find what in the atmosphere (or the clouds) keeps a phase across more than 64 frames from the page's first
frames (a lookup table refreshed on a longer cycle, a noise or march offset that is not `frame.misc.zw`, an
accumulation that is not restarted) and make two loads of one page draw the same low-orbit frame at any
frame index, or state in RENDER_API why they may not. What must NOT change: the recorded reference images.
