Status: open
From: cockpit
Owner path: tests/browser/mission/lunar-direct.spec.ts (`setViewAndWait`, the cockpit pictures at EARTH_ORBIT and LUNAR_TOUCHDOWN; app-integration)
Blocking: no

## Problem
The mission spec's two cockpit pictures are taken 15 frames after the view change, while the exposure is still
seven or eight stops above the cabin's (it adapts down at 0.8 EV/s from the chase view's daylight value): both
are black frames with a ghost of the displays, and they were read as "the cockpit is nearly black in the
integrated game". The cabin itself is lit: the same vessel in the same orbit, once the exposure has settled, has a
picture median of 133 of 255 (`out/screens/cockpit/app-leo-seat.png`, `tests/browser/cockpit/app.spec.ts`).
The cause of the slow transient is the core's (request cockpit-14); the picture is this spec's.

## Evidence
`tests/browser/mission/lunar-direct.spec.ts` `setViewAndWait`: waits for `!viewBlending()` and 15 frames, then
`saveScreenshot`. `out/screens/mission/06-earth-orbit-cockpit.png`, `10-lunar-touchdown-cockpit.png`.

## Requested change
Before a picture in a view that was just switched to, wait until the exposure has reached its target, as the
cockpit's and the integration lab's specs do:

```ts
await page.waitForFunction(() => { const e = window.__app!.exposure(); return Math.abs(e.ev100 - e.targetEv100) < 0.1; }, undefined, { polling: 100, timeout: 30_000 });
```

(With cockpit-14 resolved this returns within a few frames; without it, in about five seconds of real time. The
flight goes on meanwhile: the wait belongs before the screenshot only.) The cockpit perf window that follows
needs no change.
