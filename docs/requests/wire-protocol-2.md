Status: open
From: wire-protocol
Owner path: src/core/contracts/session.ts (lead)
Blocking: no

## Problem
The user decision of 2026-11-13 asks for a VISIBLE QUEUE when every pad slot of the vehicle's class is taken
at launch time (the player's place and an honest wait). The wire carries it: `SpawnQueuedMessage` (net.ts,
wire section: `reqId`, `position`, `etaSeconds`, `padClass`), sent while the request waits and ended by
`seatResult` or the client's `spawnCancel`. But the session contract has no way to hand it to the app:
`UniverseCommands.spawn` resolves once with a `SeatResult` (seated or refused), and `LinkState.queuePosition`
is the ADMISSION queue (a full lobby), not the launch queue. netcode-client therefore cannot surface the
launch queue to shell-menu without a contract field.

## Evidence
src/core/contracts/session.ts: `spawn(request: SpawnRequest): Promise<SeatResult>`; `SeatResult` has
`{ ok: true; ... } | { ok: false; reason; alternative }` only. src/core/contracts/net.ts: `LinkState.state
'queued'` with `queuePosition` documented as the admission queue ("queue position while queued").

## Requested change
One of (the lead's choice; wire-protocol needs neither for its own acceptance):
- a store `ClientStores.launchQueue: Store<{ reqId: number; position: number; etaSeconds: number; padClass: PadClass } | null>`
  filled from `spawnQueued` and cleared by the seat result or a cancel, plus `UniverseCommands.cancelSpawn()`; or
- an `onQueued` callback in `UniverseCommands.spawn(request, opts?)`.
Nothing on the wire changes either way (the messages exist). `SeatResult` should stay as it is.
