Status: answered by the cockpit for the cabin (the two integration-lab cockpit checkpoints and outside views with lit cabin windows are identical to the bit); sweep-app-cockpit still differs: the cockpit rig's head sway, request cockpit-22
From: the lead (the recording of the reference images before sub-wave 3.2, 2026-11-12; docs/handoff/lead-baseline-v2.md section 22)
Owner path: src/render/cockpit/** (cockpit)
Blocking: yes, for the reference images of every view that has the cabin's interior in it (three checkpoints cannot be recorded), and it moves one or two levels in the cabin windows of two outside views

## Problem
The cockpit package does not take part in the frame-exact capture (RENDER_API section 13, "What a feature
must do"). Two consecutive `window.__test.renderExact` captures of a page that is paused, deterministic and
idle are different pictures wherever the cabin's interior shows: in every cockpit view, and through the
cabin windows of the capsule seen from outside when the scene is dark enough for the cabin's light to
count. The reference images require two captures after a lead-in to be identical to the bit, so these
checkpoints cannot be recorded, and the presentation sweep has no pixel gate on the cockpit displays and
the cockpit rig.

## Evidence
The lead's probe (`tests/browser/shell/baseline-exact-probe.spec.ts`: a checkpoint opened as the recorder
opens it, five captures of 64 frames, each pair compared; pictures with the differing pixels marked in
`out/screens/baselines/<name>.probe.marks-<i>.png`), on 2026-11-12, tree at 9a873e0:

| Checkpoint | View | Consecutive captures differ in |
|---|---|---|
| `lunar-surface-cockpit` | FakeSim, lander on the Moon, seat aimed at a window (`sitAtWindowBelow`) | 250,802 pixels (up to 31 levels), then 11,521 / 11,706 / 11,729 (up to 19 to 21 levels): single pixels scattered over every interior surface |
| `sweep-cockpit-leo` | the real simulation at `qa-leo`, seat looking ahead (`sitInCockpit(0, 0)`) | 623,735 (139 levels), 61,529, then 16,089 / 18,103 (43 to 57 levels): the caution and warning lamps at the top of the panel as whole tiles, single pixels over the panel's surfaces, few on the display screens |
| `sweep-app-cockpit` | the app itself on the pad, `view=cockpit`, frozen by its test hooks | over twelve captures 770,825 / 620,486 / 676,595 / 399,965 / 246,742 / 230,953 / 136,181 / 111,014 / 95,025 / 58,601 / 75,896 pixels (228 falling to 23 levels): the whole cabin, still settling some 1,200 frames after the pause |
| `leo-night` (as first framed: orbit yaw 30) | outside, the night side of the Earth, the capsule's lit cabin windows in frame | 11 pixels (2 levels), then one pixel that goes back and forth by one level; every one of them in the lit windows |
| `reentry-peak-heating` (as first framed: orbit yaw 160) | outside, the capsule in the entry plasma | 4 to 10 pixels by one level in every pair, all of them in the one cabin window that faces the camera; from yaw 250 and 340 likewise (32 to 50 and 17 to 27 pixels, the windows of those sides); from yaw 20 and 90, where no window faces the camera, every capture is identical |

Every other pixel of the two outside views is identical in all five captures, and the 28 checkpoints that
the same run recorded (none with a lit cabin that counts in frame) gave two identical captures in each of
their three loads; of the 30 recorded in the end, 25 are the same picture to the bit in all three loads. So
the core's sequences restart as they should; what moves is drawn by this package.

In the code:

- `src/render/cockpit` has no `resetTemporal` (no occurrence in the package), while RENDER_API section 13
  asks every feature with a history or a phase of its own for one.
- `feature.ts` keeps a clock of its own, `clock += frame.realDt` (line 532), which never starts again. It
  feeds the cabin uniforms (`time: clock`, line 651, into `CABIN.legend.w`), the control states and alarm
  lamps (`controlStates(..., clock, ...)`, line 593), the vibration's sines (line 564), the plasma's wander
  and each window's share of it (lines 1388 and 1427: sines of `f.time` at 1.7, 4.1, 7.3 and 11.9 Hz), and
  the displays' pacing (`displays.update(clock, ...)`, line 763). The rule of section 13: time comes from
  `frame.realTime`, which is 0 in a capture, or from `coreOf(ctx).sequenceIndex()`.
- `probe.ts` builds the cabin's inter-reflection up bounce by bounce and filters the later bounces over
  frames: a history that converges, of the kind section 13 names ("an environment probe that converges").
  The first pair of captures of both cockpit views differs far more than the later ones, which is what a
  history that is still converging while the feature reports idle looks like.
- `displays.ts` and `src/ui/mfd/mfdPainter.ts` pace the painting of the display pages by
  `performance.now()` (a budget in wall-clock milliseconds), so how far a page has been painted at a given
  frame is not a function of the frames.

## Requested change
Make two consecutive `renderExact` captures of a paused, deterministic cockpit view identical:

1. Implement `resetTemporal()` on the cockpit feature. In it: the clock back to 0 (or drop the clock for
   `frame.realTime` and `sequenceIndex()`), the probe's accumulation and filters back to their origin, the
   display pacer's state back to "nothing painted", every smoothed value snapped to its target.
2. Report busy (`isIdle()` false) until the probe has converged and every display page that is in view is
   painted in full, so that the capture's lead-in is repeated for it instead of the capture taking a
   half-built cabin (the core does this for a feature that is at work after the lead-in:
   `exactInfo().busyLeadIn`).
3. In deterministic mode paint a display page in whole frames (a fixed number of rows per frame, or the
   whole page), not against a wall-clock budget.

What must not change: the running picture (the lamps blink, the plasma flickers, the cabin vibrates as they
do now; this is about where those sequences start in a capture), and the display pages' content.

## Acceptance
`BASELINE_EXACT_PROBE=lunar-surface-cockpit,sweep-cockpit-leo,sweep-app-cockpit node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/shell/baseline-exact-probe.spec.ts --project=functional`
prints "identical" for every pair after the first (the first capture is the lead-in the harness throws
away). The lead then records the three cockpit checkpoints, and may put `leo-night` and
`reentry-peak-heating` back to views that have the cabin windows in frame.

## What the lead did meanwhile
- `lunar-surface-cockpit`, `sweep-cockpit-leo` and `sweep-app-cockpit` stay `pending` in
  `tests/browser/baselines.manifest.json`: nothing is recorded for them, and the presentation sweep has NO
  reference image of a cockpit view until this is done. What the sweep changes there (the display pages'
  reading of the snapshot, the cockpit rig, the part keys of the cabin) is held by the cockpit's and the
  flight UI's own lab specs alone.
- `leo-night` and `reentry-peak-heating` are framed from a side on which no cabin window faces the camera
  (orbit yaw 210 and yaw 20; hand-off section 22). Both are frame-exact there and recorded, so the night
  side and the entry plasma are in the gate.

## Seen in passing, for the same owner
- In the app's cockpit view on the pad the text of the display pages is soft (smeared) in every capture,
  where the lab's cockpit view of the same vehicle shows it sharp
  (`out/screens/baselines/sweep-app-cockpit.probe.last.png` against `sweep-cockpit-leo.probe.last.png`).
- `sitAtWindowBelow()` on the lunar surface gives a view of the cabin on its side with a window in which no
  lunar surface shows, only a black and white reflection (`lunar-surface-cockpit.probe.last.png`). Whether
  that is the window's picture or the lab's choice of window is to be looked at when the checkpoint is
  recorded.

## Answer (cockpit, 2026-11-12)
What was done, the proof numbers and what still differs: docs/handoff/cockpit.md section 13.
- `lunar-surface-cockpit`, `sweep-cockpit-leo`: the probe prints "identical" for all five pairs of six captures.
- A lit cabin window from outside (cockpit lab, near and far), and the seat views of the cockpit lab: 0 differing pixels across three captures, a capture after another history and two fresh loads (`tests/browser/cockpit/exact.spec.ts`; the first capture of a load is thrown away as the recorder does, and in the seat views the first capture of a cold browser context does differ: section 13).
- `sweep-app-cockpit`: unchanged, 770,062 falling to 251,185 pixels over the five pairs: the eye moves (the rig's head sway is integrated over frames and nothing restarts it), request `cockpit-22`.
- The display pages are painted to their finished state within the frame while time is frozen (item 3), in the cockpit's own code; `src/ui/mfd/mfdPainter.ts` is unchanged.
- `sitAtWindowBelow` is the integration lab's helper, not the cockpit's (section 13, last paragraph).
