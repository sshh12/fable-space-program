Status: open
From: cockpit
Owner path: src/camera/cockpitRig.ts (the head sway), src/app/game.ts (`renderExact`: what it restarts besides the renderer); shared-code maintainer
Blocking: yes, for the reference image `sweep-app-cockpit` (request lead-5): the cabin is frame-exact now, the camera in it is not

## Problem
In the app's cockpit view two consecutive `renderExact` captures still differ over the whole frame
(`sweep-app-cockpit`), after the cockpit package's own sequences restart (request lead-5; the two cockpit
checkpoints of the integration lab and the cockpit lab's outside views are identical to the bit). What moves
is the eye: the cockpit rig keeps a head sway that is integrated over frames (`stepSway`: a low-passed
acceleration `accSlow` with a time constant of 1.2 s, and a damped spring on the offset). It is not a render
feature, so nothing restarts it at a capture, and it only advances while frames are rendered with a positive
step: on the pad (1 g of proper acceleration, the sustained share of the sway is building up) every capture's
frames move the eye a little further towards its settled offset. The picture shifts by a fraction of a pixel
from capture to capture and comes to rest only after many captures.

## Evidence
`BASELINE_EXACT_PROBE=sweep-app-cockpit node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional`,
tree at 327a9a4 (the cockpit's resetTemporal is in and is forwarded by the app, request core-5):
770,062 / 619,924 / 682,165 / 395,546 / 251,185 of 921,600 pixels differ in the five pairs (223 falling to
143 levels), over the whole 3D picture, the sky in the panes included; only the DOM HUD is the same
(`out/screens/baselines/sweep-app-cockpit.probe.marks-*.png`). The numbers are those of the lead's table from
before the cockpit's fix (770,825 / 620,486 / 676,595 / 399,965 / 246,742): the cabin's restart changed
nothing here, so the cabin is not what moves. The same probe on the integration lab's cockpit checkpoints
(`lunar-surface-cockpit`, `sweep-cockpit-leo`: the lab places the camera itself, no sway) prints "identical"
for all five pairs.
In the code: `src/camera/cockpitRig.ts` lines 178-209 (`accSlow`, `sway`, `swayVel`, `stepSway(accel, dt)`
with `if (dt <= 0) return`), `eyeVes = seat.eyeVes + sway` (line 259); `src/app/game.ts` line 657
(`renderer.renderExact(frames, () => frame(performance.now()))`: the frame function steps the view manager
with the fixed step).

## Requested change
RENDER_API section 13's rule for smoothed values ("snap them to the target") applied to the rig: when the
sequences restart for a capture (the app's `renderExact`, before the frames), the rig takes its sway at the
settled value for the current acceleration (`accSlow = accel`, `sway = target`, `swayVel = 0`), or the sway is
not stepped at all while the renderer is deterministic. Either way the eye after N frames depends on the
snapshot and N alone. The same for any other eased value of the view manager in the cockpit view (the
field-of-view wheel's easing, a view blend in flight).

## Seen with it
The display pages' text in `sweep-app-cockpit.probe.last.png` is soft with a faint second copy of each row
(the lead's note in request lead-5). The eye was still moving in that capture, so successive frames were
resolved at slightly different places; whether anything of it is left once the eye stands still is to be
looked at in the first identical capture.

## Acceptance
The probe command above prints "identical" for every pair of `sweep-app-cockpit`.
