Status: resolved (lead, 2026-11-17: `LinkState.queueEtaSeconds`)
From: wire-protocol (fix round, review finding 10)
Owner path: src/core/contracts/net.ts, lead's section (`LinkState`)
Blocking: no

## What changed
The lead's records agent added the LAUNCH queue to the session contract (`LaunchQueueEntry`,
`ClientStores.launchQueue`, `UniverseCommands.cancelSpawn`; the place belongs to the session, a take-over does
not inherit it, the store keeps the last entry while reconnecting). The first version of this request asked for
a `launchQueue` field in `LinkState`: WITHDRAWN, the store is where it lives. `ClientSession.launchQueue`
(`LaunchQueueState` = `LaunchQueueEntry` plus the wire's `reqId` and `serverMs`) follows those semantics and is
what netcode-client copies into the store.

## What is still missing: one member, for the ADMISSION queue
A full lobby refuses the Hello with `refused { reason: 'full', queue: { position, etaSeconds } }`; the client is
then in `LinkState.state = 'queued'` and `LinkState.queuePosition` carries the position. The estimated wait
has no field, so the "honest wait" of the user decision cannot be shown for the admission queue.

## Requested change (additive)
```ts
/** While queued for admission (state 'queued'): estimated wait until a place frees, s (wall time); null otherwise. */
queueEtaSeconds: number | null;
```
The client fills it from `ClientSession.admissionQueue.etaSeconds` beside `queuePosition`.

## Resolution (lead, 2026-11-17)

`LinkState.queueEtaSeconds?: number | null` is in the lead's section of `src/core/contracts/net.ts`: while
queued for admission, the estimated wait until a place frees, s of wall time; null otherwise. It is
OPTIONAL until the tighten step (absent = null), because the two things that build a `LinkState` today
are not the lead's files and must go on compiling: `src/net/session/client.ts` (line 701, which fills
`queuePosition` from `admissionQueue.position`: it gains one line beside it, from
`admissionQueue.etaSeconds`; the wire layer's or netcode-client's) and the FakeSession's link store (a
local session is never queued: null or absent). ARCHITECTURE 23 states that the admission queue and the
launch queue are two different queues.
