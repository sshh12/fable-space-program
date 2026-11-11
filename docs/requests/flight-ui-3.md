Status: open
From: flight-ui
Owner path: tests/browser/map-view/real-planet.spec.ts (map-view), and the app shell's map obstacles (src/app, app-integration)
Blocking: no

## Problem
Flight-ui round 6 rebuilt the HUD's bottom cluster as one instrument housing. The pitch / heading / roll chips
(`.hud .nbchips > div`) are gone: pitch and roll are windows at 9 and 3 o'clock (`.hud .prw`), speed and heading
share one window on the bezel's top arc (`.hud .bottom .speed`, still a `.panel`), and a gunmetal housing
(`.hud .housing`) joins the SAS controls, the ball and the gauges. Map obstacle lists built from the old
selectors miss the housing and the two windows, so map labels and the node panel could be placed over them.

## Evidence
`tests/browser/map-view/real-planet.spec.ts` line 61 (`mountHud`): the selector list
`.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more, .hud .nbchips > div,
.hud .toast, .hud .ball`. The flight-ui coverage check (`tests/browser/flight-ui/screens.spec.ts`, `hudCoverage`)
now uses `.hud .panel, .hud .later, .hud .tile:not(.compact), .hud .pill, .hud .helpbtn, .hud .more,
.hud .housing, .hud .prw, .hud .toast` plus the ball. Request map-view-5 lists the old selectors for the app shell.

## Requested change
Replace `.hud .nbchips > div` by `.hud .housing, .hud .prw` in the obstacle selectors (map-view's spec helper and
the app shell's `setObstacles` call, if it copies map-view-5's list). Nothing else changes: `.hud .ball` and every
other selector stay valid.
