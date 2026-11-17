Status: open
From: wire-protocol (fix round, review finding 10)
Owner path: src/core/contracts/net.ts, lead's section (`LinkState`)
Blocking: no (the client session exposes both queues itself meanwhile)

## Problem
The reviewer (finding 10) and the lead ruling of 2026-11-16 separate two queues:
- the ADMISSION queue: a full lobby refuses the Hello with `refused { reason: 'full', queue: { position,
  etaSeconds } }`; there is no session; the client is in `LinkState.state = 'queued'`;
- the LAUNCH queue: an admitted, online player whose spawn waits for a pad slot of its class
  (`spawnQueued { reqId, position, etaSeconds, serverMs, padClass }`, and the resumed seat's `queued` after a
  reconnect).
`LinkState` has one field, `queuePosition`, documented as the admission queue and only filled while
`state === 'queued'`. The launch queue is therefore invisible in `LinkState` while online, which is when it
matters.

## Evidence
src/core/contracts/net.ts `LinkState.queuePosition: number | null` ("queue position while queued").
src/net/session/client.ts: `ClientSession.admissionQueue` and `ClientSession.launchQueue` (public fields,
filled from the messages above; `etaSeconds` counts wall seconds from the message's `serverMs`).

## Requested change (additive)
In `LinkState`:
```ts
/** The admission queue (a full lobby; state 'queued'): place and an honest wait in wall seconds. */
admissionQueue: { position: number; etaSeconds: number } | null;
/** The launch queue (online, a spawn waiting for a pad slot of its class); etaSeconds counted from serverMs (server wall clock). */
launchQueue: { reqId: number; position: number; etaSeconds: number; serverMs: number; padClass: PadClass } | null;
```
`queuePosition` can stay (as the admission position) until the tighten step. When the fields exist, the
client's `status()` fills them from the two session fields, while online for the launch queue.
