Status: open
From: vfx
Owner path: src/render/core/post/exposure.ts (the sunlit bounds on the exterior target; what the histogram holds of local lights)
Blocking: no

## Problem
By day the exposure still steps by more than half a stop within one lift-off sequence seen from a chase
camera. With vfx-4 and vfx-7 the exterior target stays inside sunny 16 +- 0.5 EV, but a lift-off uses the
whole band: while the pad under the flame is in the frame the meter sits ON the upper bound (the apron within
about 35 m of the foot of the jet takes more light from the flame than from the sun, 1.3e8 cd at 12 cd/N, and
is more than 1 % of the lit pixels), and when the vehicle has climbed and the pad has left the frame it falls
back to the prior. The critics of round 1 asked for the sky to stay within 0.4 EV from T+0 to T+10 s. Most of
that lit apron is not even seen: it lies under the pad cloud, which is drawn after the histogram is taken
(rightly, vfx-4), so the meter stops down for ground the camera cannot see.

## Evidence
`tests/browser/vfx/exposure.spec.ts`, "by day the chase camera keeps its exposure through the lift-off, from
T+0 to T+10 s (within half a stop)" (new in vfx round 2; lab URL `/labs/vfx/?scene=pad&dist=150&pitch=4`, lab
times 4, 7, 10, 14 s, 120 settled frames each):

```
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/vfx/exposure.spec.ts --project=functional -g "chase camera"
lift-off by day from the chase camera: T+0 s: sky 0.0632 at EV 15.58, T+3 s: sky 0.0632 at EV 15.58, T+6 s: sky 0.0629 at EV 15.58, T+10 s: sky 0.0922 at EV 15.01
```

0.57 EV between T+6 s and T+10 s (asserted under 0.5; it fails). EV 15.58 is sunny 16 (15.08 at this sun) plus
`SUNLIT_HIGHLIGHT_MAX_EV`. The pad camera of the same lab (`scene=pad`, 430 m) reads 15.02 with the engines on
and 14.58 off (0.45 EV, the test above it in the same spec).

## Requested change
While the sun lights the scene (the gate of `SUNLIT_HIGHLIGHT_MAX_EV` / `SUNLIT_SHADOW_MIN_EV`), what LOCAL
LIGHTS add to the lit geometry should not move the exterior target by more than about a quarter of a stop: a
daylight exposure is set for what the sun lights, and a flame-lit patch of ground clips as the flame does.
Either of these would do, whichever fits the meter better:

- take the highlight term (the 99th percentile against `HIGHLIGHT_CAP`) of a sunlit exterior frame from the
  sun-and-sky lighting only (the deferred pass knows the local lights' share of a pixel), or
- bound the rise above the prior that comes from pixels brighter than a sunlit white surface
  (`SUNLIT_SURFACE` x 4, say) to 0.25 EV while leaving the +0.5 EV for frames full of sunlit cloud or snow.

Must NOT change: night and twilight (there the ground the flame lights IS what the camera exposes for, the
night test of the same spec holds it), cabin views, the lower bound of vfx-7, frames of sunlit cloud or snow.
Workaround in vfx meanwhile: none that is honest (dimming the plume light by day would make the pad under a
flame darker than it is); the new test is left failing at 0.57 EV rather than loosened.
