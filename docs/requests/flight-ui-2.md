Status: resolved (commit 3416a9c)
From: flight-ui
Owner path: src/core/ui/theme.ts (and the pinned values in tests/unit/flight-ui/theme.test.ts, flight-ui's file: edit it in the same commit)
Blocking: no

## Problem
Both visual critics of round 1 still see the scene print through the HUD plates: `UI_COLORS.panel` is
`rgba(17, 24, 34, 0.86)`, so 14 % of whatever is behind a plate reaches it and a hard scene edge (the sunlit
regolith against black sky, the sea horizon, the white rocket) survives as a 1 px tone step of about 34 levels
across a row of text. The fix the critics ask for is a plate the edge falls to a few levels behind
(alpha 0.97: a white-to-black edge leaves 0.03 x 255 = 8 levels), measured on the screenshots.

## Evidence
out/qa/wave2/flight-ui.r1.photo.json (previousItemsStillOpen 4) and out/qa/wave2/flight-ui.r1.artifact.json
(first finding): out/screens/flight-ui/bright-lunarSurface-720p.png, landing-target panel (15, 21, 29) above
the horizon and (49, 55, 64) below it; out/screens/flight-ui/pad-4k.png, LAUNCH panel (41, 50, 62) above the
sea horizon and (25, 36, 49) below it. The HUD builds `--bg` and `--bg-strong` from these two tokens
(src/ui/hud/hudStyles.ts); the map view (src/map/theme.ts) does not read `panel` or `panelStrong`.

## Requested change
In src/core/ui/theme.ts:

```ts
panel: 'rgba(17, 24, 34, 0.97)',        // was 0.86
panelStrong: 'rgba(12, 17, 25, 0.985)', // was 0.94
```

and the same two values in the expected object of tests/unit/flight-ui/theme.test.ts (flight-ui agrees to the
edit). Nothing else must change: the RGB of both, every other token, the font stack. The HUD side (the plate's
top-gradient colour `--bg-top`, defined in hudStyles.ts) is changed by flight-ui. No workaround inside
flight-ui's paths keeps the shared token honest, so the HUD reads the token and waits for this change.

## Resolution
Done (commit 3416a9c): `UI_COLORS.panel` = `rgba(17, 24, 34, 0.97)`, `UI_COLORS.panelStrong` =
`rgba(12, 17, 25, 0.985)` in `src/core/ui/theme.ts`, and the same two values in the pinned object of
`tests/unit/flight-ui/theme.test.ts`. The RGB of both, every other token and the font stack are unchanged;
`--bg` and `--bg-strong` of the HUD follow through `hudStyles.ts` (not edited by me: `--bg-top` and the
"86 %" in its header comment are yours). The map view does not read either token.

Not re-run by me: `tests/browser/flight-ui` (the screenshots are yours to judge; your tree is mid-edit).
