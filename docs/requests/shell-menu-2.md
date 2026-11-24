Status: open
From: shell-menu
Owner path: src/app/game.ts (`inFlight`, the page's leave guard)
Blocking: no (it matters from the moment the app runs a session without a scenario)

## Problem
The lead's rule of 2026-11-24: a session without a scenario (a menu or lobby session) must NOT arm the page's
"leave this page?" guard; only a flight under way does. `src/app/game.ts` line 342 arms it for every session
whose `snapshot.scenario` is null:

```ts
const inFlight = (): boolean => !snapshot.mission.failed && (snapshot.scenario === null || snapshot.scenario.startKind !== 'pad' || snapshot.staging.nextStage > 0);
```

## Evidence
With `scenario === null` and `activeVesselId === null` (the menu, ARCHITECTURE 17.2) the expression is true, so
closing the tab from the title asks the player to confirm.

## Requested change
Use the shell's rule, which is pure and unit-tested (`tests/unit/shell/model.test.ts` covers the menu, the pad,
a staged flight, a scenario that starts in orbit, and a failed mission):

```ts
import { shouldGuardUnload } from '@/shell';
const inFlight = (): boolean => shouldGuardUnload(snapshot);
```

The rule (src/shell/leaveOutcome.ts): no active vessel, or a failed mission: no guard; a stage fired: guard;
otherwise guard only when the session's scenario starts somewhere other than a pad. A lobby session (no
scenario) is guarded once its craft has fired a stage. Nothing else in game.ts changes.
