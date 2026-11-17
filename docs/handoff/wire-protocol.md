# wire-protocol: hand-off

The wire layer of the v2 multiplayer universe (ARCHITECTURE 13, 14, 16.1; brief `wire-protocol` in
`docs/WORK_PACKAGES_V2.json`, wave 4.1): the message schema (the wire-message section of
`src/core/contracts/net.ts`) and its codec, framing, transports, the session layer for both ends, time sync and
the input-margin loop, the per-client downstream budget, the latency injector (wrapper and stand-alone proxy)
and a recorder/replayer of message streams. `src/net` imports `src/core` only and runs unchanged in Chrome, in
Node and in a worker (it imports no Node module and no package; timers and I/O are injected).

Ran beside `presentation-sweep` by the lead's decision: no presentation code is imported or run; `FakeSession`
does not exist yet, so the fixtures were recorded from the REAL session (section 6 lists what is to be
re-recorded from FakeSession scenes). Every verification was scoped (`typecheck:paths`, `vitest` on my paths,
the boundary test); the whole-tree typecheck was not used.

## 1. Acceptance, line by line (measured on this machine, 2026-11-16, other agents' GPU work running)

| Brief line | Result | Measured |
|---|---|---|
| Round trip: every message type on 1,000 seeded random instances decodes to equal values | MET | all 52 message types (socket, role, census documents), 1,000 each, equal values and equal bytes on re-encoding (`tests/unit/net/cases/codecCases.ts`) |
| ... and on fixtures recorded from FakeSession scenes | PARTLY MET | recorded from the real session instead (FakeSession does not exist yet): 3 scenes, 917 frames, every frame re-encodes byte for byte, every message round-trips (`tests/unit/net/fixtures`). The FakeSession scenes are listed in section 6 |
| Keys are bit-exact | MET | 2,000 random keys: float64 positions and velocities and float32 attitude and rate identical to the bit (Object.is) |
| Quantisation of deltas at most 16 um, 1 um/s, 5e-10 rad | MET | worst over 20,000 poses (0 to 2 s after the key, docking and 3 g motion, turning): 7.81 um, 0.500 um/s, 1.60e-10 rad |
| Single-owner key at most 110 B per vessel (with framing) | MET | 99 B (109 B with the pilot's `inputAck` in the same frame); 90 B per vessel in a key of 4 |
| Shared delta at most 130 B for two vessels | MET | 75 B (worst of every 30 Hz send tick of a key interval, 20 seeds, docking approach, one control group) |
| Shared delta at most 300 B for ten | MET | 282 B (same, two control groups) |
| A staging IslandOp under 100 B | MET | 61 B (`split` with the directory-style id of the spent stage and the checksum) |
| A census entry at most 90 B | MET | 84 B per entry in the relevant set (coasting ship, one patch, strings as session handles: ARCHITECTURE 13.1 "the mapping is sent once"); for the record: a public census document costs 112 B per entry with its own string table |
| Encode at most 5 us and decode at most 5 us per vessel for a delta (benchmark through the gate) | MET | `node tools/dev/heavy.mjs --class=cpu -- npx tsx src/net/bench.ts`: encode (quantise + write) 0.127 us per vessel (2 vessels), 0.110 (10); decode (read + rebuild poses) 0.199 / 0.151 us; key 0.04-0.08 us; input 0.14 / 0.13 us per message. Taken while other agents ran GPU jobs (PACKAGE_RULES 16: provisional) |
| Zero allocations per message in steady state for the high-rate types | MET | heap + array-buffer growth over 100,000 messages after warm-up (`tests/unit/net/alloc.test.ts`): encode at most 0.21 B and decode at most 0.33 B per message for `islandDelta` (10 vessels; and a contact pair with part-fast), `islandKey`, `inputAck`, `input`, `near`: noise, below one object. No collection during the benchmark's timed runs. (One `Uint8Array` view per FRAME is handed to the transport; not per message) |
| Fuzz: 1,000,000 random and mutated byte strings never throw, never read out of bounds, never allocate above 1 MB | MET | 1,000,000 inputs (40 % random, 60 % mutated valid frames of every type), through `decodeFrame` and `FrameReader`, from every side: 0 throws, 38,980 decoded, every other refused with a typed reason; largest sampled allocation 7.1 kB; the worst inputs a client can send: 256 pings 38 kB, a 60 kB plan 64 kB, a 64-sample input 31 kB |
| The same test file passes in Node (vitest) and in Chrome (Playwright spec loading the bundle) | see section 7 | one case module (`tests/unit/net/cases`), two runners: `tests/unit/net/shared.test.ts` (Node: 26 cases pass) and `tests/browser/net/net.spec.ts` (Chrome loads `runner.html`, which imports the same modules through Vite, plus the fixtures and the WebSocket transport) |
| Session layer: every transcript drives the client half against the server half over the loopback and over the injector at 300 ms with stalls to the same final states | MET | 9 transcripts (`tests/unit/net/transcripts/*.json`), each over the loopback and over the injector at a 300 ms round trip, 20 ms jitter, 5 % stalls of 200 ms, 3 seeds: the stated outcome every time; the loopback run reproduces the recorded frames byte for byte |
| Resume after a drop mid-handshake, mid-subscription and with inputs in flight | MET | transcripts `resume-mid-handshake`, `resume-mid-subscription`, `resume-inputs-in-flight` (every input applied once, every request answered once), plus `stall-and-declared-loss` and `outage-beyond-grace` (resume refused after the 120 s grace, a new session) |
| A takenOver session stops sending | MET | transcript `taken-over`: 0 frames sent after `takenOver`; its later command is answered as refused locally |
| Malformed and out-of-order messages are refused with a typed reason | MET | transcript `malformed-and-out-of-order` (server refuses 'malformed' and 'outOfOrder', client refuses a malformed server frame) and `version-mismatch` ('build', 'defsHash'); unit tests for each refusal |
| The injector reproduces a scripted profile (150 ms +/- 20 ms, 5 % stalls of 200 ms) within 5 ms, measured | MET (with the precise scheduler) | 300 frames on real timers: delivery minus the scripted arrival 0.01 .. 0.20 ms (p99 0.12 ms); base delays 130.0 .. 170.0 ms, 12 stall episodes, longest delay 350 ms. NOT met with plain `setTimeout` on this Windows machine: p99 15.4 ms, max 15.6 ms (the system timer's 15.6 ms grid), which is why `RealScheduler({ precise: true })` exists (section 5). The stand-alone proxy process (precise) gave round trips of 285-316 ms against a scripted 300 +/- 20 |

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
- `class Sender { constructor(transport, { highWaterBytes?, maxFrameBytes? }); push(m, table?); pushRecord(record, key); flush(): number; stats }` (holds back above the high-water mark, supersedes 'latest' records, never drops reliable ones)

### Time
- `interface Scheduler { now(); setTimer(ms, fn); clearTimer(h) }`, `ManualScheduler` (virtual time, livelock guard), `RealScheduler({ precise? })`
- `rttOf`, `offsetOf`, `estimateClock(samples)` (minimum-round-trip filter), `addSample`; `leadParams(rules)`, `initialLead(rtt, p)`, `nextLead(lead, marginMs, p)`, `stampTick`, `clockTickAt(clock, upMs)`

### Session layer (pure machines + drivers)
- `class ClientSession(cfg: { build; defsHash; cpuScore; accountId; rules?; random; protocol? })`: `connect()`, `leave()`, `spawn(req): reqId`, `attach(vesselId, clockId?)`, `detach()`, `cancelSpawn(reqId)`, `command(tick, cmd)`, `time(tick, req)`, `target(ref)`, `plan(craftId, data)`, `quick(phrase, to)`, `subscribe(change)`, `input(controls, applyTick, sasHold?)`; events `tick(now)`, `transportOpen()`, `transportClosed(info)`, `messages(list)`, `malformed(error)`, `signed(signature)`; `drain(): ClientAction[]`, `nextDeadline()`, `linkState(): LinkState`; state `phase`, `session`, `vesselId`, `clock` (sync estimate), `inputMarginMs`, `inputs`, `pendingRequests`, `currentSubscriptions`
- `class ServerSession(cfg: ServerConfig, nowMs, upMs)`: client events `messages`, `malformed`, `transportClosed`; host `authResult(AuthResult)`, `resumeResult(ResumeResult)`, `seatResult`, `spawnQueued`, `commandResult`, `setClock`, `inputApplied(seq, tick)`, `push(m)`, `takeOver()`, `end(reason, text)`, `retainedInputs()`; `tick(now, up)`, `drain(): ServerAction[]`, `nextDeadline()`
- `class ClientDriver({ session, scheduler, connect(attempt, nextCandidate), sign(nonce, serverId, build), onMessage?, onLink?, onFrameOut?, sender? })`: `start()`, `enter(fn)`, `stop()`
- `class ServerDriver({ transport, scheduler, config, upMs(), host: ServerHost, onFrameIn?, sender? })`: `enter(fn)`, `push(m)`, `authResult(r)`, `resumeResult(r)`; `interface ServerHost { verifyAuth(req, driver); resume(req, driver); forward(message, driver); lost?(info, driver); phase?(phase, driver) }` (the host answers the two checks by calling the driver)
- `InputWindow`, `InputBuffer`, `DownstreamBudget({ bytesPerSecond?, burstBytes? })` with `budgetClassOf(m)`, `RateWindow`, `backoffMs(attempt, random)`
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
- **Conics travel in a canonical form** (six float64 elements, `a` when not derivable, a closed flag; P, Q, W and
  the period recomputed): equal to the sender's to a few ulps (worst 1e-14 measured); a decoded conic re-encodes
  to the same bytes. Node and Chrome may differ by an ulp in sin/cos, so a census decoded in the two may differ
  in the last bit of P, Q, W (ARCHITECTURE 3: clients compare with tolerance).
- **Delivery**: 'latest' = `islandKey`, `islandDelta`, `islandSlow`, `near`, `durable` (superseded by island /
  type); everything else reliable. Inputs are reliable messages (a resume sends its catch-up in several).
- **Session rules a gateway and a client get for free**: version/build/defsHash refusal before the challenge;
  resume by token (no challenge), with `ResumedSeat.lastInputSeq` so the client retires applied inputs; a
  resumed gateway admits the catch-up once beyond the input rate; requests sent again after a resume are
  answered once (per socket by the gateway, and by the universe across sockets: the transcripts' host does it,
  server-persistence's must too); a request made while connecting waits for the welcome; after the grace a
  refused resume starts a new session and the requests of the old one are answered as refused ("the session
  ended; what it was waiting for is not known"); acknowledgements ride with keys and deltas or go alone after
  one control tick; declared loss after `lossTimeout` without a frame, pings every `pingInterval` when idle;
  standby: the next candidate at once, then the backoff.

## 5. Known limits (stated, not hidden)

- **The real `ws` package is not tested**: `ws`, `@types/ws` and `fflate` are not installed (request
  wire-protocol-1). The `ws` adapter is tested against an EventEmitter with the `ws` socket's interface; the
  browser-side transport is tested against a real RFC 6455 server written for the tests, in Node (Node's own
  WebSocket) and in Chrome. `src/net` needs neither package (the island blob is carried opaque, deflated by the
  application).
- **Timer precision on Windows**: plain `setTimeout` lands on a 15.6 ms grid here; `RealScheduler({ precise:
  true })` reaches 0.2 ms by busy-waiting the last 17 ms before each deadline, so it is for measurements (tests,
  the proxy process), not for games, bots or gateways.
- **Island operations and the island blob** are carried as data whose meaning is island-core's: `split.cutJoints`
  are the child part indices of the cut joints, `capture.state` is opaque bytes, `rebase` carries the anchor slot
  and the new reference state. island-core and contact-docking may need to refine these by request.
- **The launch queue reaches the app only through the wire** until the session contract can surface it
  (request wire-protocol-2).
- **The stand-alone proxy's entry lives in `tests/unit/net/proxy/`** (src/net may not import Node networking;
  `tools/net` belongs to net-joint-gate and acceptance-multiclient). It is a copy away from `tools/net`.
- **Fixtures**: the ascent scene's 40 s reach lift-off and ignitions but no decoupling, and the entry scene no
  chute event, so no recorded `islandOp` and no chute PART-FAST from the real session (the random-instance cases
  cover both). The whole-tree typecheck was not run (presentation-sweep's tree); the scoped checks pass.

## 6. Fixtures to re-record from FakeSession scenes (once presentation-sweep has built it)

With `tests/unit/net/fixtures/record.ts` extended by a FakeSession source: rendezvous (two vessels closing from
2 km: near tier, then an island with both, shared deltas at 30 Hz), docking approach (soft capture and hard dock:
the contact form, `islandOp capture` and `merge`, `docked` events), an assembly (two craft, helm hand-over,
`assembly` view, lend policies), echoes (recorded and projected echoes in the relevant set: `relevantFull` /
`relevantDelta` with forecast chains, reservations, `limitTick`), the time strip (`clock` with members,
proposals and offers; `prompts`; `conjunctions`; refused time requests with alternatives). Each becomes a `.fspw`
file in `FIXTURE_FILES` (`tests/unit/net/cases/fixtureCases.ts`).

## 7. Chrome run

See the last lines of this section (filled in after the gated run).

## 8. Requests

- `docs/requests/wire-protocol-1.md` (lead, root configuration): install `ws`, `@types/ws`, `fflate`. Open.
- `docs/requests/wire-protocol-2.md` (lead, `session.ts`): a way to surface the launch queue to the app. Open.
- No request against this package's paths was open when this note was written.
- Contract changes: only the wire-message section of `net.ts` (this package's own). Nothing of the lead's section
  was changed.

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
  `nodeWsTransport`); implement `ServerHost` (signature check, resume check with `lastInputSeq`, forwarding,
  U16 on `lost`); dedupe requests across a resume in the universe; role links are `streamTransport` over TCP
  with `route` envelopes. Replay the transcripts with your server side: `runTranscript(t, { link, server:
  yourSide })` must reach `t.expect`.
