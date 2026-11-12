Status: resolved (commit 6a2fb76)
From: cockpit
Owner path: src/render/core/post/exposure.ts, src/render/core/renderer.ts (exposure adaptation; shared-code maintainer)
Blocking: yes (the lead's item "the cockpit is nearly black in the integrated game" is this, and nothing in src/render/cockpit can change it)

## Problem
Switching from the chase view to the cockpit, the picture is nearly black for three to four seconds: the
exposure keeps the exterior's value (EV100 about 15 in sunlight) and comes down to the cabin's (about 4) at
`ADAPT_DOWN` 0.8 EV/s, exponentially: 11 stops take about 3 s to come within one stop. A cut between two cameras
is not an eye that adapts: a real camera operator sets the exposure for the new shot. The two cockpit pictures of
the browser mission (`out/screens/mission/06-earth-orbit-cockpit.png`, `10-lunar-touchdown-cockpit.png`: black
cabin, displays a dim ghost) were taken 15 frames after the view change (`tests/browser/mission/lunar-direct.spec.ts`
`setViewAndWait`): they show the transient, not the cabin. A player who presses C sees the same.

## Evidence
- `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/app.spec.ts --project=functional`
  (the app, `/?scenario=qa-leo&view=cockpit`, nothing toggled, exposure settled): EV100 3.87 (histogram weight 1,
  lit fraction 0.99), picture median 133 of 255: `out/screens/cockpit/app-leo-seat.png`. Same vessel, same orbit,
  same seat as the mission's black picture; the only difference is the time since the cut.
- The mission picture itself: the MFD page is visible at about a tenth of white, the cabin at 0-3 of 255: an
  exposure of about EV 11-12, i.e. still seven or eight stops over the cabin a quarter of a second after the cut.

## Requested change
When `CameraState.kind` changes between two frames (exterior <-> interior; the same for a change of `mode` if you
prefer), treat it as a cut: take the metered target of the new view as soon as a histogram OF THE NEW VIEW has been
read back (the meter's read-back lags a few frames: until then hold the photometric prior of the new kind or the
last interior value, not the exterior's), instead of adapting from the old view's exposure. Or, equivalently for
the player, adapt at a rate of the order of 20 EV/s for the first half second after such a change. Must not
change: the slow dark adaptation within one view (the night sky), the rates inside a view, the metering rules
themselves. If the view manager blends between rigs over several frames, the cut is the frame the kind changes.

Workaround in my paths: none (the cockpit writes luminance x `frame.exposure`; brightening the cabin for the
transient would lie to the meter). The cockpit's own spec (`tests/browser/cockpit/app.spec.ts`) waits for the
exposure to settle before it shoots, so its pictures show the cabin; it also proves the settled state is right.

## Resolution
`src/render/core/renderer.ts`, `src/render/core/post/exposure.ts`: a change of `CameraState.kind` between two
frames is a cut. For `CUT_ADAPT_SECONDS` = 0.75 s after it the exposure follows the metered target with a time
constant of `CUT_ADAPT_TAU` = 0.06 s (`adaptEv100Cut`), in both directions and through the dark range, instead of
adapting at `ADAPT_UP` / `ADAPT_DOWN` / `ADAPT_DARK`. That is your second form ("of the order of 20 EV/s for the
first half second"): eleven stops are within 0.3 EV a quarter of a second after the target has moved. It was
chosen over "hold the prior until a histogram of the new view is back" because the target itself keeps moving
after the kind changes: the meter's read-back lags a few frames, and the view manager switches the kind at the
midpoint of its 0.6 s blend, a third of a second before the eye is in the seat (the near histogram goes from the
hull's outside to the cabin on the way). The exposure stays on the target through all of that and is the cabin's
when the blend ends.

Unchanged: the metering rules, the rates inside one view, the slow dark adaptation inside one view. The same
applies to flight <-> map (kind 'map') and to any rig whose kind differs from the one before it.

Tests: `tests/unit/render-core/exposureGovernor.test.ts`, "a cut between views takes the new exposure at once
(request cockpit-14)" (2 tests: EV 15 -> 4 within 0.3 EV in under 0.3 s where the eye-like rate takes more than
3 s; both directions; no overshoot). Browser: `tests/browser/integration/exposure.spec.ts`, "a cut to the cockpit
is exposed for the cabin within half a second" (integration lab, low orbit). Docs: RENDER_API section 13 ("A cut
between views") and 18. For the mission's pictures: `setViewAndWait` may shoot 45 frames after the view change
(the blend's 36 frames and the adaptation behind it); request cockpit-15 covers that spec.

