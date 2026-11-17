# wire-protocol: hand-off (after the review's fix round)

The wire layer of the v2 multiplayer universe (ARCHITECTURE 13, 14, 16.1; brief `wire-protocol` in
`docs/WORK_PACKAGES_V2.json`, wave 4.1): the message schema (the wire-message section of
`src/core/contracts/net.ts`) and its codec, framing, transports, the session layer for both ends, time sync and
the input-margin loop, the per-client downstream budget, the latency injector (wrapper and stand-alone proxy)
and a recorder/replayer of message streams. `src/net` imports `src/core` only and runs unchanged in Chrome, in
Node and in a worker (no Node module, no package; timers and I/O are injected).

Ran beside `presentation-sweep`: no presentation code is imported or run. Every verification was scoped
(`npm run typecheck:paths -- src/net src/core/contracts tests/unit/net tests/browser/net`; `node
tools/dev/heavy.mjs --class=cpu -- npx vitest run src/net tests/unit/net tools/dev/boundaries.test.ts`: 12 files,
180 tests pass; `node tools/dev/check-stubs.mjs` OK). Commits of the fix round: c6b1c9e, db4bdf6, 5ab57a5; of the last items: 98f10e3 and this note. Last suite: 13 files, 187
tests (with the real `ws` tests).

## 0. The review's findings: fixed / partly / not, with the evidence

| # | Finding | Status | Evidence (tests are under `tests/unit/net/`) |
|---|---|---|---|
| 1 | One 21-byte frame throws out of the gateway | FIXED | Reproduced first (the frame is an input stamped at -(2^53-1); the margin it produced made the `inputAck` encoder throw inside `ServerDriver.enter`). Causes fixed: stamps outside [clock(up) - inputBufferMs, clock(up) + roundTripAllowance] are dropped on BOTH sides (`InputBuffer.accept` 'past' / 'future'); without a pilot clock every stamped message is refused (`noClock`, fail closed); the margin is clamped to +-60 s where it is measured AND in the encoder; any error inside `ServerDriver.enter` (machine or host callback) closes THAT socket with 1011 and calls `host.error` (`ClientDriver` likewise, `onError`). `drivers.test.ts`: the exact frame without and with a clock, a throwing host closes one socket of two; the fuzz below |
| 2 | Ping and timeSync floods | FIXED | Per-socket UPSTREAM token bucket in bytes (16 kB/s, burst 80 kB) and frames (60/s, burst 120), checked in `ServerDriver` BEFORE decoding; over it the socket is closed (`refused`). Pings 2/s and time-sync probes 2/s (account windows); before the welcome a ping costs no answer and at most `handshakeMessages` (8) other messages are taken. Control class 0 of the budget goes at most one bucket into debt, then waits; what waits for a socket (budget + sender) is capped at 1 MiB and 10 s, over a cap the socket closes (4003 `slowConsumer`). `drivers.test.ts` 'blocker 2' (bucket, ping/timeSync rates, handshake cap, byte cap, age cap) |
| 3 | A limit for every client message type | FIXED | `wireLimits(rules)`: inputs, commands, time, seat requests (spawn/attach/detach/cancel), subscriptions, plans, quick, targets, pings, time-sync, samples per frame. ONE `rateLimited { what, dropped, ids, retryAfterMs }` per kind per window (new message, code 64; the client answers the dropped request ids as refused). The rate is checked BEFORE `repeat()`. `AccountLimits` is the account's windows, given by the host with the auth or resume answer (so a reconnect does not reset them); the resume catch-up burst is granted once per input-buffer span per account. The client paces its own requests at the same limits. `session.test.ts`, `drivers.test.ts` |
| 4 | Time sync | FIXED | The welcome is no longer a sample; probes run on their own timer (a burst of 4, 250 ms apart, then one every 10 ping intervals) whatever else is sent; `ServerDriverOptions.wallMs()` beside `upMs()`. `timing.test.ts`: over the injector with 150 ms up and 30 ms down: round trip 176.5 ms, wall and up-time offsets off by 58.1 ms, i.e. the inherent half-asymmetry (60 ms) of any two-way sync, 9 probes in 60 s while inputs flowed at 60 Hz |
| 5 | Input-margin loop | FIXED | The gateway reports the margin at most once per second (the earliest input of the window); `nextLead` shrinks the lead by at most half an input interval per report (grows at once); `InputWindow.add` never lets a stamp go back. `timing.test.ts` closed loop over the injector (80/40 ms, 15 ms jitter, 120 s): 116 reports, settled lead 114.1-114.8 ms, 0.00 % of 6,881 inputs late, 0 stamps back, 0 dropped as future |
| 6 | Downstream budget to the lead's decisions | FIXED | `DownstreamBudget` rewritten: (a) 6 kB/s sustained, refilled at 24 kB/s while island or near records wait, at most 60 s in any 600 s; (b) island deltas at an adaptive rate between 30 Hz and 10 Hz from the delta sizes produced, contact deltas at 60 Hz from the burst allowance; (c) pads, ships, roster, prompts, conjunctions, assembly latest-wins per type; (d) `islandEnter` free up to 256 kB, the excess charged; (e) class 3 keeps a floor of 10 % of the sustained rate (taken from the same bucket, never extra bytes). Rule fields: section 0.1. Table per scenario: section 0.2. `session.test.ts` (a)-(e), `bandwidth.test.ts` (ten-vessel island with near tier, relevant set and pads, ten minutes) |
| 7 | Drop-superseded unsafe | FIXED | `near` carries `band: 'near' | 'far'` and supersedes per band; `islandSlow` is reliable; a superseding record replaces the waiting one IN PLACE (budget and sender); an `islandKey` removes the waiting deltas of its island (`obsoletedKeys`); `deltaMatchesKey(delta, heldIsland, heldKeyTick)` refuses a delta whose keyTick is not the held key's. `review.test.ts`, `session.test.ts` (c) |
| 8 | Numbers reach the host unvalidated | FIXED (codec + machine); the universe's part listed in 0.3 | Stamp window of ARCHITECTURE 26 on commands and time requests in the machine (beyond clock(up) + 0.25 s refused; a late one is forwarded, the universe re-times it: 6.2); -0 canonicalised (`tick()`, `ranged`); ids printable ASCII <= 128 B, names <= 64 B without control characters, `relevantDistance` 0..1e9 m, `transfer.rate` 0..1e5, `advanceLimit.seconds` 0..250 years, `setRate` level within `WARP_LEVELS`, `sasHold` a unit vector (1e-3), every tick a safe integer, every float finite. `review.test.ts` |
| 9 | Identity | FIXED | A resume is challenged like a new session (the host's `resume` gets the token AND the signature over the fresh nonce); the host is given the CLIENT's build (the one it signed) and `cpuScore` (`IdentityProof`); the transcript host checks a real keyed signature (wrong nonce, server, build or account fails). All transcripts re-recorded |
| 10 | Visible queue across a reconnect | FIXED (one `LinkState` member requested) | `ResumedSeat` has a without-seat form (`vesselId: null`, `queued`); the contract says the universe re-sends `spawnQueued` after a resume and drops the entry of a session lost past the grace; a cancel made while reconnecting is remembered and sent on resume; `SpawnQueuedMessage.serverMs` (ETA in wall seconds from it). Reconciled with the session contract the records agent added (`LaunchQueueEntry`, `ClientStores.launchQueue`, `UniverseCommands.cancelSpawn`): `ClientSession.launchQueue` is a `LaunchQueueState` = `LaunchQueueEntry` (with the request as `spawn` was given it) plus the wire's `reqId` and `serverMs`; it belongs to the session (kept while reconnecting, kept by a resume, null after a take-over by message or by close code 4002, null in a new session). The pad queue lives in that store, not in `LinkState`; request wire-protocol-3 is restated as the one missing member for the ADMISSION queue: `LinkState.queueEtaSeconds` (the position already has `queuePosition`) |
| 11 | Fuzz | PARTLY | Structure-aware fuzzer of both drivers (valid messages of every type, extreme field values, bit flips, advancing time): server 20,000 frames, 1,167 sockets closed by the gateway, 0 internal errors; client 13,181 frames over 12 sessions, 0 internal errors. Byte fuzz 1,000,000 inputs, 0 throws. Samples per frame capped (128) inside the decoder; the largest client frame at the cap allocates 7.3 kB per decode, a frame over it 11.3 kB before it stops. NOT done, and why: `FrameReader` in the server driver is not a contained change. `decodeFrame` is all-or-nothing (the gateway acts on no message of a malformed frame); a `FrameReader` visits messages up to the failure, so the gateway would act on half frames unless it decodes twice (validate, then visit). And the only hot client type is `input`, whose samples the gateway must keep for 5 s (`InputBuffer`) and hand to the host, so they would be copied out of the pooled frame anyway. What it would take: a validating pass over the frame without building objects (a `FrameReader` with a no-op visit), then a visiting pass that copies the accepted samples into a pool of `InputSample`s owned by the `InputBuffer` and recycled when it prunes; the saving is about 32 B per sample, at most 60 samples a second per pilot (~2 kB/s) |
| 12 | Closing records and close codes | FIXED | `refused`, `takenOver`, `bye` are force-flushed (budget `takeAll`, sender `flush(true)`) before the close; the client maps 4002 without its message to taken over and 4000 to a loss with backoff. `review.test.ts` |
| 13 | Ten-vessel delta with all steering; census entry on first sight | FIXED for the brief's lines; stated beyond | Nothing had grown: the same scenes encode to identical bytes on 9b5ee22 and on the fix round (`scratchpad` comparison); the 458 B was a different scenario (3 g, not docking). Then reduced: the control state is packed (axis mask, only non-zero axes, flags and SAS mode in one byte: 9 B to 4 B for a pilot on two axes), the delta's tick is a signed varint instead of float64 (5 B saved at today's ticks), and p, e, inc, lan, argPe travel as 48-bit floats (10 B per conic). Ten DOCKING vessels with ALL ten steering: worst 296 B, mean 262.6 B (line 300: MET; was 351 B). At 3 g all steering: 403 B mean (floor without an acceleration term in the predictor, see 0.5). Census entry: 81 B steady (line 90: MET; was 91 B), 123-146 B on first sight with its new strings. 10,000 objects in one census document: 975 kB (was 1,075 kB; ARCHITECTURE 14 plans 840 kB): see 0.5 |
| 14 | `ws` adapter | FIXED | Against a REAL `ws` 8.23 server (`ws.test.ts`, 6 tests): `WS_SERVER_OPTIONS` in force (no extension negotiated; a 64 KiB + 1 message closed with 1009 before the gateway saw a byte of it), a message sent in two fragments arrives as one frame, close codes and reasons both ways (4000 'build' after the `refused` message; 4100 and its reason from the client), a socket declared lost is terminated (the client sees 1006, 0.35-2 s after the last frame with a 0.4 s loss timeout), a pre-auth flood of 400 pings is closed on the upstream bucket with 0 pongs answered, and under a peer that stopped reading `bufferedAmount` grew to 265 kB, the sender held 523 flushes back and its 2 MB cap tripped. `fflate` is not used anywhere in `src/net` |
| 15 | Version skew | FIXED | Hello (code 1) and `refused` (code 34) layouts frozen and their bytes held in `review.test.ts`; a client skips a record of an unknown type by its length, a server refuses one; transcript `version-mismatch` gained a client of protocol 2 refused 'protocol' |
| 16 | The client against a bad server frame | FIXED | `acknowledge()` tests ranges instead of materialising them (a range of 6,000,000: < 20 ms, < 1 MB); `lateApplied` keeps the last 256; `retryAfterMs` clamped to 10 min. `review.test.ts` |
| 17 | Varints and coarse bounds | FIXED | Non-canonical varints refused (`badVarint`). Stated: the coarse path of island frames is good to 8 um/s and 0.5 mm, and float64 positions lose sub-mm precision beyond 5e10 m from the body centre |
| 18 | Limits as contract constants, units | FIXED | 22 optional fields added to `UniverseRules.limits` with units and `WIRE_LIMIT_DEFAULTS` (section 0.1); `WIRE_RANGES`. Units: `transfer.rate` kg/s of the resource, `advanceLimit.seconds` seconds of the craft's own clock, `merge.rollStep` index of the port's roll steps (integer), `nearOrigin.r` / `v` m and m/s in the body-centred inertial frame of `bodyId` at the message's tick. Additions beyond ARCHITECTURE 13.2 / 13.3, flagged: `rateLimited`, `near.band`, `SpawnQueuedMessage.serverMs`, `ResumedSeat.queued` and nullable `vesselId`, close codes 4003 and 1011, and the protocol constants in section 0.4 |
| 19 | Fixtures | FIXED (stated) | Section 6 says what the fixtures are (recorded from the REAL session, not FakeSession) and lists the re-record set, extended |

### 0.1 Rule fields the default rules document must receive at the tighten step

Added (optional, documented with units) to `UniverseRules.limits` in the lead's section of `net.ts` under the fix
round's authorisation; `wireLimits(rules)` merges `WIRE_LIMIT_DEFAULTS` for any field the document in force does
not carry. Nothing under `data/defs/rules` was edited (PACKAGE_RULES 7a). Defaults:

| Field | Default | Unit |
|---|---|---|
| `upstreamBytesPerSecond` / `upstreamBurstBytes` | 16,000 / 81,920 | bytes per second / bytes |
| `upstreamFramesPerSecond` / `upstreamBurstFrames` | 60 / 120 | frames per second / frames |
| `pingsPerSecond` / `timeSyncsPerSecond` | 2 / 2 | messages per second |
| `handshakeMessages` | 8 | messages before the welcome (pings excluded) |
| `plansPerSecond` / `quicksPerSecond` / `targetsPerSecond` / `seatRequestsPerSecond` | 1 / 1 / 5 / 2 | messages per second |
| `inputSamplesPerFrame` | 128 | samples |
| `sendQueueBytes` / `sendQueueAge` | 1,048,576 / 10 | bytes / seconds |
| `downstreamBytesPerSecond` | 6,000 | bytes per second, sustained |
| `downstreamBurstBytesPerSecond` / `downstreamBurstSeconds` / `downstreamBurstWindow` | 24,000 / 60 / 600 | bytes per second / seconds / seconds |
| `deltaRateTarget` / `deltaRateFloor` | 30 / 10 | Hz |
| `islandEnterFreeBytes` | 262,144 | bytes |
| `relevantFloorShare` | 0.1 | share of the sustained rate |

### 0.2 Bytes per second per scenario (`bandwidth.test.ts`, real encoded frames, ten minutes each)

(Measured in the fix round, before the size changes of 0.5; the numbers after them are in 0.5 and are 2-11 % lower.)

Each scenario runs the island at 60 Hz offered, keys every second, plus an 8-vessel near tier at 10 Hz, two
census entries a second in the relevant set, the pads and an `inputAck` each second. "Island alone" is what the
island costs at a fixed rate (the reviewer's table); "delivered" is what the budget let through.

| Scenario | Delta (avg) | Island alone at 30 Hz | at 60 Hz | Reviewer's figure | Delivered, 600 s average | First minute (burst) | Delta rate settled |
|---|---|---|---|---|---|---|---|
| Ten vessels docking, two steering | 279 B | 9.2 kB/s | 17.6 kB/s | 8.5-10.6 at 30 Hz | 6.79 kB/s | 11.4 kB/s | 14.7 Hz |
| Ten vessels at 3 g, all steering | 455 B | 14.5 kB/s | 28.2 kB/s | 13.9-16.0 at 30 Hz | 7.08 kB/s | 16.7 kB/s | 10.0 Hz (floor) |
| A pair in contact, exact form | 264 B | 8.1 kB/s | 16.0 kB/s | 16.1 at 60 Hz | 7.23 kB/s | 18.2 kB/s | 16.4 Hz |
| A landed pair, four probes each | 452 B | 13.7 kB/s | 27.3 kB/s | 28.6 at 60 Hz | 7.81 kB/s | 24.1 kB/s | 10.0 Hz (floor) |

Read plainly: 6 kB/s sustained cannot carry any of these at 30 Hz; the budget holds the average at 6 kB/s
plus the one burst minute (at most 7.8 kB/s over any 600 s), gives 30 Hz (60 Hz in contact) for the burst
minute, and then the delta rate falls to what fits, down to the 10 Hz floor. Two scenarios sit at the floor,
where the island alone (4.6 kB/s) still fits beside the near tier and the relevant set's 10 % floor; a bigger
island than these would wait (the floor is a rate of release, not a promise of bytes). If 30 Hz must hold for
docking and contact, the sustained rate or the burst minute is the number to change (rule values above).

### 0.3 What remains for the universe to validate (the codec and the gateway cannot)

Authority and ownership (`craft.owner`, the helm on the island: ARCHITECTURE 26); that every id names an
existing, visible object of the right kind (craft, vessel, port, part, site, pad, vehicle, body, clock, account,
phrase); `transfer` resource valid for both craft and the rate within their plumbing; `advanceLimit` within the
group's rules; `setRate` / warp / jump / follow / link / proposals within the time rules of section 26 (the
gateway counts `time` messages, it does not judge them); a command's validity at its stamped tick (6.4); a spawn's
vehicle, site, pad, slot and the name policy; a plan's opaque bytes; subscription contents beyond the distance
range; lend-policy semantics; `cpuScore` is self-reported (a hint, never trusted); the rate of anything per
account across gateways (the gateway's windows are per account only within one gateway process).

### 0.4 Protocol constants (not rule values; flagged per finding 18)

`MARGIN_REPORT_MS` 1000 (margin reports), the contact delta rate 60 Hz, the client's `MAX_RETRY_AFTER_MS` 10 min,
time-sync burst 4 probes 250 ms apart then every 10 ping intervals, `lateApplied` memory 256, at most 64 ids per
`rateLimited`, `MAX_CLIENT_FRAME_MESSAGES` 256, the lead's half-input-interval step (derived from
`inputsPerSecond`).

### 0.5 The size lines after the review of 2026-11-17

What grew: nothing. Encoding the same scenes on the tree of 9b5ee22 (before the fix round) and on the fix
round gives identical bytes. The fix round's validation adds none, and its only new fields (`near.band`, 1 B;
`spawnQueued.serverMs`; `rateLimited`) are in neither deltas nor census entries. The 458 B was another scenario
(ten vessels at 3 g); the reviewer's 354 B is ten DOCKING vessels all steering (351 B worst here); the census
entry's 91 B against the first delivery's 84 B is another test entry.

What changed (every guarantee of the fix round kept; the decoders refuse non-canonical forms):
- the control state is packed: an axis mask, only the non-zero axes, then flags and SAS mode in one byte (9 B
  to 4 B for a pilot on two axes, 2 B for neutral controls); keys, deltas and the near tier carry it;
- the island delta's tick is a signed varint (3-6 B for the ticks of a universe's life), float64 beyond 2^52;
- p, e, inc, lan and argPe of every conic travel as 48-bit floats (relative 7.3e-12: 0.05 mm on a low orbit,
  9 mm at the Moon, 3.4 m at 1 AU); tPeriapsis and a sent `a` stay float64; `canonicalConic` gives a sender
  the conic its receivers hold.
Fixtures shrank by 7-11 % (leo-coast 17,683 to 15,782 B); transcripts and fixtures were re-recorded.

| Line | Before | Now | Brief |
|---|---|---|---|
| Ten docking vessels, ALL steering, worst of a key interval (20 seeds) | 351 B | 296 B (mean 262.6) | 300: MET |
| Ten docking vessels, two steering, worst | 279 B | 264 B | 300: MET |
| Ten vessels at 3 g, all steering, mean | 432.9 B | 377.9-403 B | (no line) |
| Census entry, steady (relevant set) | 91 B | 81 B | 90: MET |
| Census entry, first sight with its strings | 133-156 B | 123-146 B | (no line) |
| Census document, 10,000 objects | 1,075 kB | 975 kB (74.6 B entry + 23.0 B strings per object) | ARCHITECTURE 14: 840 kB |

Bytes per second per scenario after the changes (`bandwidth.test.ts`): ten docking (two steering) 264 B per
delta, 8.7 kB/s at 30 Hz; ten at 3 g all steering 401 B, 12.8 kB/s; contact pair 259 B, 15.7 kB/s at 60 Hz;
landed pair with four probes 447 B, 27.0 kB/s at 60 Hz. Delivered by the budget over 600 s: 6.72, 7.00, 7.19,
7.81 kB/s; delta rate settled at 15.4, 10.1, 16.6, 10.0 Hz.

What cannot be met in this format, for the lead to decide:
- **3 g deltas**: the residuals are against key position + velocity x dt, so under 3 g they grow as a dt^2 / 2
  (14.7 m: 21 bits of 1/64 mm after one second) and a dt (29 m/s: 25 bits of um/s), about 21 B of position and
  velocity per vessel late in a key interval. The floor is ~380 B for ten. An acceleration term in the key (3
  float32 per vessel, +12 B per vessel per key) would take ~10 B per vessel off every delta (~280 B for ten); at
  30 Hz with a key a second, about 2.9 kB/s less per client, for a change of the IEEE-exact predictor of
  `quant.ts`. Not done.
- **Census at 840 kB**: the entries alone are 746 kB; the unique strings (a 12-character vessel id and a name,
  23 B per object) are the rest. 840 kB needs the names out of the snapshot (a names document fetched once and
  cached: ~790 kB), or the angles as 40-bit fixed point (5.7e-12 rad, 3 B less per object: ~945 kB), and both
  together give ~760 kB. At the design load the difference is the first fetch of a sphere (975 against 840 kB per
  client); the deltas that follow carry only what changed.
- **First sight**: an object's strings travel once per session (handles), 42-65 B of them with its first entry.
  That is the floor without shorter ids.

## 1. Acceptance, as the reviewer laid it out: proven / claimed / not done

Proven = a test or a measurement in this repository shows it now; claimed = measured once (machine-dependent or
run by hand), not a standing test; not done = stated.

| Brief line | Status | Evidence |
|---|---|---|
| Round trip of every message type on 1,000 seeded random instances | PROVEN | all message types incl. `rateLimited`, equal values and bytes (`shared.test.ts` via `cases/codecCases.ts`) |
| ... and on fixtures from FakeSession scenes | NOT DONE (substituted) | fixtures recorded from the real session (3 scenes, 917 frames), re-recorded after the fix round with no byte changed; FakeSession scenes listed in section 6 |
| Keys bit-exact; delta quantisation within 16 um, 1 um/s, 5e-10 rad | PROVEN | `shared.test.ts` cases (7.81 um, 0.500 um/s, 1.60e-10 rad worst) |
| Key at most 110 B per vessel; delta at most 130 B for two, 300 B for ten | PROVEN | keys smaller than before (the packed control state); two docking vessels 55-62 B; ten docking vessels with two steering 230.6 B mean, 264 B worst, and with ALL ten steering 262.6 B mean, 296 B worst (`bandwidth.test.ts`). At 3 g all steering: 403 B mean, not a line of the brief (0.5) |
| Staging op under 100 B; census entry at most 90 B | PROVEN | 61 B; census entry 81 B in steady state (the relevant set, strings as handles), 123-146 B on first sight with its new strings. The 10,000-object census document is 975 kB, above the 840 kB of ARCHITECTURE 14 (0.5) |
| Encode and decode at most 5 us per vessel | CLAIMED | `bench.ts` through the gate, 0.11-0.20 us per vessel, first delivery; not re-run since (the hot paths gained range checks and the packed control state: a few branches per vessel) |
| Zero allocation per message in steady state | PROVEN | `alloc.test.ts` (warm-up raised to 100,000 so the optimising compiler's own allocations finish first; growth now 5.7-19.5 kB over 100,000 messages, below one object per 5 messages, for delta, contact delta, key, inputAck, input, near) |
| Fuzz: 1,000,000 inputs never throw / out of bounds / above 1 MB | PROVEN | `fuzz.test.ts`: 0 throws, largest sampled allocation 27.8 kB; plus the driver fuzz (finding 11) |
| Same test file in Node and Chrome | PROVEN | section 7 |
| Transcripts over loopback and injector to the same final states | PROVEN | 9 transcripts re-recorded (resume now challenged, real signatures, 3 clients in `version-mismatch`), loopback byte for byte, injector at 300 ms with stalls, 3 seeds |
| Resume mid-handshake, mid-subscription, inputs in flight; takenOver stops sending; malformed / out of order refused | PROVEN | transcripts |
| Injector within 5 ms of a scripted profile | CLAIMED | real timers, precise scheduler: 0.2 ms, first delivery (`transport.test.ts` runs it each time, but the numbers depend on the machine) |
| Real `ws` server tests | PROVEN | `ws.test.ts` against `ws` 8.23 (finding 14). `fflate` is not used by `src/net` and was dropped |

## 2. Public API (exact signatures; all exported from `src/net/index.ts`)

### Contract: the wire-message section of `src/core/contracts/net.ts` (owned by this package from now on)
`WIRE_PROTOCOL_VERSION = 1`; `WIRE_CONSTANTS` (protocol constants that are not universe rules: `inputRepeatMs`
250, `inputBufferMs` 5000, `reconnectBackoffMs` [500, 1000, 2000, 4000, 8000], `reconnectSteadyMs` 15000,
`reconnectJitter` 0.25, `downstreamBytesPerSecond` 6000, `maxPredictionMs` 500, `handshakeTimeoutMs` 10000,
`requestMemory` 256, `maxClientFrameBytes` 64 KiB, `maxFrameBytes` 8 MiB). Every universe timer and limit is
read from `UniverseRules` (ping interval, loss timeout, reconnect grace, round-trip allowance, inputs /
commands / time messages / subscriptions per second).
Messages (the `type` tag is the name): client to server `hello`, `auth`, `spawn`, `attach`, `detach`,
`spawnCancel`, `input`, `command` (`WireCommand`), `time` (`TimeRequest`), `target`, `subscribe`, `plan`,
`quick`, `timeSync`; either side `ping`, `pong`, `bye`; server to client `challenge`, `welcome` (with
`ResumedSeat`), `refused` (`SessionRefusal`), `takenOver`, `seatResult`, `spawnQueued` (THE VISIBLE LAUNCH
QUEUE: `reqId`, `position`, `etaSeconds`, `padClass`; user decision of 2026-11-13), `handles`, `clock`,
`islandEnter`, `islandOp` (`IslandOpBody`, `IslandOpChecksum`), `islandKey` (`KeyVessel`), `islandDelta`
(`DeltaVessel`: `DeltaPose`, `WireControlState`, `PartFastEntry[]`, `ContactState`), `inputAck`, `islandSlow`,
`event`, `commandResult`, `nearOrigin`, `near` (`NearVessel`), `relevantFull`, `relevantDelta`
(`OsculatingElements`), `worldline` (`WorldlineSegment`), `conjunctions`, `durable`, `pads`, `ships`,
`assembly`, `roster`, `prompts`, `feed`, `rules`, `notice`, `timeSyncReply`; role to role `route`; HTTP
documents `censusSnapshot`, `censusDelta`. Unions `ClientMessage`, `ServerMessage`, `WireMessage`,
`CensusDocument`. Grids, units and frames are documented on each field.

### Codec and framing
- `encodeMessage(m: WireMessage, table?: StringTableOut | null): Uint8Array` (one record: code, length, payload)
- `encodeFrame(messages: readonly WireMessage[], table?): Uint8Array`; `assembleFrame(records: readonly Uint8Array[]): Uint8Array`
- `decodeFrame(bytes: Uint8Array, opts: { source: 'client' | 'server' | 'role' | 'document'; handles?: HandleTableIn | null; maxBytes?: number }): { ok: true; messages } | { ok: false; error: DecodeError & { index }; messages }` (never throws; checks direction, size, at most 256 messages in a client frame)
- `class FrameWriter { w; begin(); add(m); addEncoded(record); finish(): Uint8Array; size; bytesSoFar }`
- `class FrameReader { constructor(source, handles?, maxBytes?); read(bytes, visit: (m) => void): DecodeError | null }` (high-rate types into reused frames: valid only inside `visit`)
- `encodeDocument(doc)`, `decodeDocument(bytes)` (census documents as HTTP bodies, own string table)
- `HandleTableOut { handleOf(s); takePending(): HandlesMessage | null }`, `HandleTableIn { lookup(h); apply(msg) }`, `DocumentStrings`
- `MESSAGE_SPECS`, `specOf(type)`, `specByCode(code)`, `supersedeKey(m)`, `randomMessage(type, gen)`, `class Gen(seed)`
- `quantizePose(key: KeyVessel | IslandPose, dtTicks, cur: IslandPose, out: DeltaPose)`, `dequantizePose(key, dtTicks, d, out): boolean`, `nearAttitude(q)`, `nearQuat(L, a, b, c, out)`, `quatAngle(p, q)`, scales `POS_FINE` .. `NEAR_ATT_SCALE`
- `canonicalConic(c)`, `expandConic(...)`, `canonicalRadius(r)`
- `DecodeErrorCode`: 'truncated' | 'badVarint' | 'badLength' | 'badCount' | 'badUtf8' | 'badEnum' | 'nonFinite' | 'badTick' | 'badValue' | 'badType' | 'wrongDirection' | 'trailing' | 'tooLarge' | 'unknownHandle'; encoders throw `WireEncodeError` on invalid input (a producer bug)

### Transports
- `interface Transport { kind; state; bufferedAmount; setHandler({ open?, frame, close }); send(frame); close(code?, reason?) }`, `CLOSE` codes (4000 refused, 4001 lost, 4002 takenOver)
- `createLoopbackPair(scheduler): [LoopbackTransport, LoopbackTransport]` (`.fail()` drops like a network)
- `webSocketTransport(ws: WebSocketLike)`, `connectWebSocket(url)` (browser, worker, Node 22+ global WebSocket)
- `nodeWsTransport(ws: WsSocketLike)` (a `ws` package socket, structurally typed)
- `streamTransport(stream: ByteStreamLike, maxFrameBytes?)` (u32 LE length prefix; a Node `net.Socket` fits), `FrameAssembler`, `lengthPrefixed`
- `class Sender { constructor(transport, { highWaterBytes?, maxFrameBytes?, maxQueuedBytes?, maxQueueAgeMs? }); push(m, table?, nowMs?); pushRecord(record, key, nowMs?); flush(force?): number; overflowed(nowMs): boolean; clear(); stats }` (holds back above the high-water mark, supersedes 'latest' records in place, never drops reliable ones; `WS_SERVER_OPTIONS` for a `ws` server)

### Time
- `interface Scheduler { now(); setTimer(ms, fn); clearTimer(h) }`, `ManualScheduler` (virtual time, livelock guard), `RealScheduler({ precise? })`
- `rttOf`, `offsetOf`, `estimateClock(samples)` (minimum-round-trip filter), `addSample`; `leadParams(rules)` (with `maxDecreaseMs`), `initialLead(rtt, p)`, `nextLead(lead, marginMs, p)` (once per report), `stampTick`, `clockTickAt(clock, upMs)`

### Session layer (pure machines + drivers)
- `class ClientSession(cfg: { build; defsHash; cpuScore; accountId; rules?; random; protocol? })`: `connect()`, `leave()`, `spawn(req): reqId`, `attach(vesselId, clockId?)`, `detach()`, `cancelSpawn(reqId)`, `command(tick, cmd)`, `time(tick, req)`, `target(ref)`, `plan(craftId, data)`, `quick(phrase, to)`, `subscribe(change)`, `input(controls, applyTick, sasHold?)`; events `tick(now)`, `transportOpen()`, `transportClosed(info)`, `messages(list)`, `malformed(error)`, `signed(signature)`; `drain(): ClientAction[]`, `nextDeadline()`, `linkState(): LinkState`; state `phase`, `session`, `vesselId`, `clock` (sync estimate), `inputMarginMs`, `inputs`, `pendingRequests`, `currentSubscriptions`
- `class ServerSession(cfg: ServerConfig, nowMs, upMs)`: client events `messages`, `malformed`, `transportClosed`; host `authResult(AuthResult)`, `resumeResult(ResumeResult)`, `seatResult`, `spawnQueued`, `commandResult`, `setClock`, `inputApplied(seq, tick)`, `push(m)`, `takeOver()`, `end(reason, text)`, `abort(code, reason)`, `retainedInputs()`; `AuthResult` / `ResumeResult` carry an optional `limits: AccountLimits`; `tick(now, up)`, `drain(): ServerAction[]`, `nextDeadline()`
- `class ClientDriver({ session, scheduler, connect(attempt, nextCandidate), sign(nonce, serverId, build), onMessage?, onLink?, onFrameOut?, sender? })`: `start()`, `enter(fn)`, `stop()`
- `class ServerDriver({ transport, scheduler, config, upMs(), wallMs?(), host: ServerHost, onFrameIn?, sender? })`: `enter(fn)`, `push(m)`, `authResult(r)`, `resumeResult(r)`; `interface ServerHost { verifyAuth(req: IdentityProof, driver); resume(req: IdentityProof & { session, relevantSeq }, driver); forward(message, driver); lost?(info, driver); phase?(phase, driver); error?(e, driver) }`; `IdentityProof { accountId, signature, nonce, serverId, build (the client's), cpuScore }` (the host answers the two checks by calling the driver)
- `InputWindow`, `InputBuffer`, `DownstreamBudget({ bytesPerSecond?, burstBytesPerSecond?, burstSeconds?, burstWindowSeconds?, islandEnterFreeBytes?, relevantFloorShare?, deltaRateTarget?, deltaRateFloor? })` (`budgetOptionsOf(wireLimits(rules))`) with `budgetClassOf(m)`, `AccountLimits`, `RateWindow`, `backoffMs(attempt, random)`
- Transcripts (`src/net/testing/transcripts.ts`, a testing module): `runTranscript(t, { link, rules?, client?, server? }): { outcome, recorded }`, `parseTranscript(json)`, `recordedFrames(entries)`; the pluggable halves `TranscriptClientHalf`, `TranscriptServerSide`

### Injector and recorder
- `DelayLine`, `roundTripProfile(rtt, opts)`, `InjectorProfile`, `DirectionProfile` (delay, jitter, stall chance and length, bandwidth cap)
- `injectTransport(inner, profile, scheduler, script?: InjectorStep[], { logUnits? }): InjectedTransport` (`setProfile`, `stall`, `disconnect`, `log`)
- `pipeWithInjection(client: ByteStreamLike, upstream: ByteStreamLike, profile, scheduler): InjectedPipe`, `parseProfile(spec)`; the process: `npx tsx tests/unit/net/proxy/latencyProxy.ts --listen 0 --target host:port --profile "rtt=150,jitter=20,stall=0.05,stallMs=200,seed=1" [--precise]` (prints `listening <port>`)
- `recordingTransport(inner, log)`, `StreamRecorder(scheduler, side).wrap(t)`, `encodeRecording`, `decodeRecording`, `replayFrames(frames, scheduler, deliver, speed?)`, `toHex`, `fromHex` (`.fspw` files)

## 3. How to run and verify

```
npm run typecheck:paths -- src/net src/core/contracts tests/unit/net tests/browser/net
node tools/dev/heavy.mjs --class=cpu -- npx vitest run src/net tests/unit/net tools/dev/boundaries.test.ts   # 155 tests, 8 files
node tools/dev/heavy.mjs --class=cpu -- npx tsx src/net/bench.ts
node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/net --project=functional
node tools/dev/check-stubs.mjs
```
Tools: `npx tsx tests/unit/net/transcripts/record.ts` (re-records the transcripts' frames after a deliberate
protocol change; never writes the expected outcomes, which are written by hand), `npx tsx
tests/unit/net/fixtures/record.ts` (re-records the fixtures from the real session).

## 4. Design notes the next packages build on

- **Island frames name vessels by slot** (index in `islandEnter.members`, changed by `islandOp`), so a shard's
  key and delta bytes are the same for every subscriber; the gateway sends the per-client `inputAck` before them
  (ARCHITECTURE 13.4). Strings of the relevant set and the near tier are session-local handles (`handles`
  message, reliable, before first use); census documents carry their own table.
- **Deltas are against the last key, in residual units** (`DeltaPose`): the decoded message holds integers;
  `dequantizePose(key, dt, pose, out)` rebuilds float64 poses bit-identically in every runtime (only IEEE-exact
  operations). The key's attitude and rate are float32 as the brief says.
- **Conics travel in a canonical form** (p, e, inc, lan, argPe as 48-bit floats, tPeriapsis float64, `a` when not
  derivable, a closed flag; P, Q, W and the period recomputed): the receiver holds exactly `canonicalConic(sent)`,
  within 2^-37 of the sender's elements (0.5); a decoded conic re-encodes to the same bytes. Node and Chrome may differ by an ulp in sin/cos, so a census decoded in the two may differ
  in the last bit of P, Q, W (ARCHITECTURE 3: clients compare with tolerance).
- **Delivery**: 'latest' = `islandKey`, `islandDelta` (per island), `near` (per band), `durable`, and the
  list-like view models `pads`, `ships`, `assembly`, `roster`, `prompts`, `conjunctions` (per type); a newer one
  replaces the waiting one in place, and a key removes the waiting deltas of its island. Everything else,
  `islandSlow` included, is reliable. Inputs are reliable messages (a resume sends its catch-up in several).
- **Session rules a gateway and a client get for free**: version/build/defsHash refusal before the challenge;
  resume by token AND a signature over a fresh nonce, with `ResumedSeat.lastInputSeq` so the client retires
  applied inputs (and `ResumedSeat.queued` for a player still in the launch queue); a resumed gateway admits the
  catch-up once per input-buffer span per account beyond the input rate; requests sent again after a resume are
  answered once (per socket by the gateway, and by the universe across sockets: the transcripts' host does it,
  server-persistence's must too); a request made while connecting waits for the welcome; after the grace a
  refused resume starts a new session and the requests of the old one are answered as refused ("the session
  ended; what it was waiting for is not known"); acknowledgements ride with keys and deltas or go alone after
  one control tick; declared loss after `lossTimeout` without a frame, pings every `pingInterval` when idle;
  standby: the next candidate at once, then the backoff.

## 5. Known limits (stated, not hidden)

- **`ws`** is tested for real (`ws.test.ts`); `src/net` itself still imports no package (the gateway hands its
  `ws` sockets to `nodeWsTransport`). The brief's "PROVIDED BY THE LEAD: ... fflate" is the lead's line to edit:
  nothing here needs it (the island blob is carried opaque).
- **Rate windows are per account within one gateway process** (`AccountLimits`, handed out by the host); an
  account spread over gateways would need the windows in the universe.
- **The server driver decodes with `decodeFrame`** (allocating, bounded by the frame and sample caps as
  measured), not a `FrameReader` (finding 11 says what it would take); the margin loop's functions (`nextLead`, `stampTick`) are the app's to call
  (netcode-client), the session does not run the lead itself.
- **Timer precision on Windows**: plain `setTimeout` lands on a 15.6 ms grid here; `RealScheduler({ precise:
  true })` reaches 0.2 ms by busy-waiting the last 17 ms before each deadline, so it is for measurements (tests,
  the proxy process), not for games, bots or gateways.
- **Island operations and the island blob** are carried as data whose meaning is island-core's: `split.cutJoints`
  are the child part indices of the cut joints, `capture.state` is opaque bytes, `rebase` carries the anchor slot
  and the new reference state. island-core and contact-docking may need to refine these by request.
- **The admission queue's estimated wait** has no `LinkState` field yet (request wire-protocol-3); the launch queue
  reaches the app as `ClientSession.launchQueue` (`LaunchQueueEntry` plus `reqId` and `serverMs`) for netcode-client
  to put in `ClientStores.launchQueue`.
- **The stand-alone proxy's entry lives in `tests/unit/net/proxy/`** (src/net may not import Node networking;
  `tools/net` belongs to net-joint-gate and acceptance-multiclient). It is a copy away from `tools/net`.
- **Fixtures**: the ascent scene's 40 s reach lift-off and ignitions but no decoupling, and the entry scene no
  chute event, so no recorded `islandOp` and no chute PART-FAST from the real session (the random-instance cases
  cover both). The whole-tree typecheck was not run (presentation-sweep's tree); the scoped checks pass.

## 6. Fixtures to re-record from FakeSession scenes (once presentation-sweep has built it)

What the fixtures ARE: three `.fspw` recordings (`leo-coast-rcs`, `ascent-staging`, `entry-chutes`) of the
real session's server messages (clock, keys, deltas, relevant deltas, durable, events) for one pilot alone, 917
frames; they test that recorded bytes still decode and re-encode identically. They contain no near tier, no
launch queue, no contact and no second vessel. Re-recording after the fix round changed no byte (`npx tsx
tests/unit/net/fixtures/record.ts`).

With `tests/unit/net/fixtures/record.ts` extended by a FakeSession source: rendezvous (two vessels closing from
2 km: near tier, then an island with both, shared deltas at 30 Hz), docking approach (soft capture and hard dock:
the contact form, `islandOp capture` and `merge`, `docked` events), an assembly (two craft, helm hand-over,
`assembly` view, lend policies), echoes (recorded and projected echoes in the relevant set: `relevantFull` /
`relevantDelta` with forecast chains, reservations, `limitTick`), the time strip (`clock` with members,
proposals and offers; `prompts`; `conjunctions`; refused time requests with alternatives), and from the fix
round: the near tier in both bands, a landed pair with probes (contact form at 60 Hz), the launch queue
(`spawnQueued` with `serverMs`, a resume with `ResumedSeat.queued`, a cancel made while reconnecting), and
`rateLimited`. Each becomes a `.fspw` file in `FIXTURE_FILES` (`tests/unit/net/cases/fixtureCases.ts`).

## 7. Chrome run

Last run, after the size changes: `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/net
--project=functional`, 2026-11-17: HeadlessChrome 157, 30 cases, 0 failed, 694 ms (1 Playwright test passed in
2.0 s), with the re-recorded transcripts and fixtures and the packed codec. After the fix round: 30 of 30, 687 ms. First delivery: 30 cases, 0 failed, 803 ms. Every Node case (26), the three fixtures fetched from the
dev server, and the WHATWG WebSocket transport against the RFC 6455 test server the spec starts. The page uses no
WebGPU, so no adapter is asserted. No resource failed to load, no console error or warning. Two earlier runs
failed for reasons now fixed: Node's loader in the spec needs the JSON import attribute (`with { type: 'json' }`),
and the page's favicon request returned 404 (the page now has an icon of its own).

## 8. Requests

- `docs/requests/wire-protocol-1.md` (lead, root configuration): `ws`, `@types/ws`. CLOSED (installed; `fflate` dropped).
- `docs/requests/wire-protocol-2.md` (lead, `session.ts`): answered by the records agent (`LaunchQueueEntry`, `ClientStores.launchQueue`, `UniverseCommands.cancelSpawn`); the client follows it.
- `docs/requests/wire-protocol-3.md` (lead, `LinkState`): restated as ONE member, `queueEtaSeconds`, for the admission queue (the launch queue lives in `ClientStores.launchQueue`). Open.
- No request against this package's paths was open when this note was written.
- Contract changes: the wire-message section of `net.ts` (this package's own), and, under the fix round's
  authorisation, the optional limits fields of `UniverseRules.limits` with `WIRE_LIMIT_DEFAULTS`, `wireLimits()`
  and `WIRE_RANGES` (section 0.1). Nothing else of the lead's section was changed.

## 9. For the next packages

- **universe-directory**: emit the server messages of net.ts as typed objects; `spawnQueued` carries the launch
  queue (place and an honest wait from the pad timetable) and ends with `seatResult` or `spawnCancel`; census
  entries must have parallel `craftIds` / `ownerIds` / `ownerCallsigns`, whole-ms `expiresWallMs`, and a radius
  that travels on a 1 cm grid (rounded up); a forecast chain's first patch starting at the head and the last
  ending at `chainEndTick` is the cheap case.
- **netcode-client**: build `NetSession` on `ClientSession` + `ClientDriver` (or a driver of your own on the
  same machine); decode island frames with `FrameReader` (no allocation) and rebuild poses with
  `dequantizePose` against the last key; feed `inputAck.marginMs` to `nextLead`; stamp inputs with `stampTick`;
  apply `handles` before relevant-set and near messages (the decoder does when given the table). Replay the
  transcripts with your client half: `runTranscript(t, { link, client: yourHalf })` must reach `t.expect`.
- **server-persistence**: the gateway is `ServerSession` + `ServerDriver` per socket (the `ws` socket through
  `nodeWsTransport`, the server built with `WS_SERVER_OPTIONS`); implement `ServerHost` (signature check over
  `IdentityProof` for auth AND resume, resume check with `lastInputSeq` and the launch-queue entry, forwarding,
  U16 on `lost`, `error` for a socket closed by an internal error); keep one `AccountLimits` per account and hand
  it out with every auth and resume answer; give the driver `wallMs()`; set the pilot's clock (`setClock`) or
  every stamped message is refused; validate what section 0.3 lists; dedupe requests across a resume in the universe; role links are `streamTransport` over TCP
  with `route` envelopes. Replay the transcripts with your server side: `runTranscript(t, { link, server:
  yourSide })` must reach `t.expect`.
