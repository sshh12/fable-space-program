Status: resolved (lead, 31e67fa: `LaunchQueueEntry`, `ClientStores.launchQueue`, `UniverseCommands.cancelSpawn`)
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

## Resolution (lead, 2026-11-17, commit 31e67fa)

The store, of the two forms offered, with a way out (`src/core/contracts/session.ts`; nothing on the wire
and nothing in `net.ts` changed; `SeatResult` is as it was):

- `LaunchQueueEntry`: `{ request: SpawnRequest; padClass: PadClass; position: number; etaSeconds: number }`
  (1 = next; the estimate can grow as well as shrink). It carries the request instead of the wire's `reqId`,
  which is the connection's own.
- `ClientStores.launchQueue: Store<LaunchQueueEntry | null>`: a new entry at every `spawnQueued`, null when
  the request has ended.
- `UniverseCommands.spawn` stays one promise that resolves once: it is pending while the request waits and
  resolves seated, refused, or refused with the reason that the player left.
- `UniverseCommands.cancelSpawn(): Promise<CommandResult>`: leaves the queue (the wire's `spawnCancel`).
- The place belongs to the session. A resume inside the grace keeps it (`ResumedSeat.queued`, then
  `spawnQueued` again); while the link is reconnecting the store keeps the last entry, which may be stale.
  A session lost past the grace or taken over by another tab loses it: its `spawn` resolves refused, and
  the new tab's store is null until it asks for a launch itself.
- A `LocalSession` (Practice) never queues: the store is always null, `cancelSpawn` reports that nothing
  waits.

The briefs of `shell-menu`, `universe-directory` and `netcode-client` carry a LEAD NOTE that names these
members; ARCHITECTURE 5.9 and 23 state the queue.
