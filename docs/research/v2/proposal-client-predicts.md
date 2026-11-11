# Multiplayer core, proposal "client predicts": clients compute, the server rules

Status: design proposal for the v2 architecture (2026-11-11). Design only; nothing here is built, deployed or
measured beyond what the v2 research measured. Inputs: `PROMPT.txt` (everything below `--- expansion ---`),
`docs/research/v2/user-decisions.md`, and the six v2 research files (`codebase-audit`, `multiplayer-prior-art`,
`hosting`, `solar-system`, `fleet-docking`, `frontend-ux`), all read in full.

How numbers are labelled: **[measured]** = taken from a v2 research file that measured it on this machine;
**[derived]** = arithmetic on measured numbers, shown; **[assumed]** = an estimate that the load test must
replace. The one assumption everything rests on: a Railway vCPU is taken as **2.5 times slower** than the
Ryzen 9950X3D core the audit measured on **[assumed]**.

---

## 0. The proposal in one page

**Stance.** Every client runs the full deterministic simulation for its own craft at 120 Hz, with zero input
latency, exactly as single-player does. The server never trusts a client's state. It trusts only the client's
**timestamped inputs**, and computes the authoritative state itself by replaying them: a few seconds behind the
client when nobody else can be affected, in step with the client when someone could be, and in real time
itself only where two or more human pilots can touch each other. Everything a second player can be affected
by, and everything that is persisted, is a state the server computed.

| # | Decision | Section |
|---|---|---|
| P1 | **Four authority modes per vessel**: Rails (analytic, nobody computes), Pilot (the owner's client leads, the server replays behind it), Host (the server leads in real time, clients predict), Proxy (the server continues an unattended craft lazily). The mode is a field on the vessel and changes at defined hand-overs. | 1, 3 |
| P2 | **Time model: per-vessel head time, forward only, with three kinds of clock** (the shared live clock, consensual group clocks, private clocks). Private warp is unlimited and costs the server nothing: the server issues a *warp horizon* per orbit and the client advances inside it. | 2 |
| P3 | **Verification ladder**: bounds on every checkpoint (microseconds), full replay of every integrated segment by default (deferred, batched, 200-400 times faster than real time on a cloud vCPU), tight-follow replay when anyone else is near, and a sampling valve for isolated vacuum flight under overload. | 3.2 |
| P4 | **Host mode only where two or more attended pilots share an island.** Launch, orbit, landing, entry and docking with a parked ship or an empty station never use server real-time simulation. | 3.3, 5 |
| P5 | **Protocol: binary WebSocket, inputs up, seals down.** Solo flight sends about 0.3 kB/s up (free on Railway) and under 0.1 kB/s down. Islands use classic prediction with 20-30 Hz snapshots relative to a reference orbit. | 4 |
| P6 | **The client holds the redo log.** A client keeps its inputs until the server reports them durable, so network drops, server restarts and deploys do not rewind a solo flight. | 4.7, 6.3 |
| P7 | **Deterministic maths module (`dmath`)** so client and server agree bit for bit. Not needed for correctness of the default mode (the server never adopts client state); needed for exact-hash comparison, seamless hand-overs and the sampling valve. | 3.2, 7 |
| P8 | **One refactor, three hosts.** `World` is split into a pure `FlightCore` (one clock, N vessels, inputs in, state out) that runs unchanged in the browser (lead), in the verifier (trailing, batch) and in the island host (real time). `SimSnapshot` stays the presentation contract, built on the client. | 7 |
| P9 | **Topology**: Railway for everything stateful (edge, directory, verifier and island pools, Postgres, bucket), Modal for verifier overflow, bots, audits and bakes, Netlify (or a Railway static service) for the shell. | 6 |

**Numbers at a glance** (derivations in sections 3 and 6; all rest on the 2.5x assumption):

| | Value |
|---|---|
| Server CPU per connected player, normal mix | about 0.0026 vCPU, of which 0.0014 has no hard real-time deadline **[derived]** |
| Server CPU per connected player, launch-heavy "HN day" mix | about 0.0039 vCPU, of which 0.0030 has no hard deadline **[derived]** |
| Downstream bandwidth per player | 0.1 kB/s solo, 1-2.5 kB/s in an island or at a busy pad, about 1.0 kB/s average **[assumed]** |
| Upstream per player | 0.3 kB/s solo, 0.4 kB/s in an island (ingress is not billed) |
| Monthly cost at 20 / 500 / 5,000 concurrent, sustained | about $55 / $320 / $1,500-1,800 (pessimistic: $60 / $440 / $2,600) |
| Extra cost of one HN day at 5,000 concurrent | about $70-95, plus the $750 tile-path worst case from `hosting.md` |

**What this buys over "the server simulates everything":** not mainly money (the audit's measured step cost
makes every split cheap). It buys (a) solo flight that feels exactly like single-player at any latency, with no
reconciliation at all; (b) a server with almost no real-time deadlines, so a traffic spike lengthens a queue
instead of slowing anyone's physics; (c) the lowest egress, which `hosting.md` identifies as the largest
sustained cost; (d) no terrain data on the real-time path; (e) flights that survive network drops and server
restarts. **What it costs:** two authority modes with a hand-over between them, a hard dependency on
deterministic replay, and a window of a few seconds in which what others see of an isolated craft is a claim
the server has bounds-checked but not yet recomputed. Section 9 lists the weaknesses without softening.

---

## 1. Vocabulary and the four authority modes

Words from the research are kept: **craft** (what one player launched; a permanent id), **vessel** (one rigid
body holding the parts of one or more craft), **island** (vessels close enough to touch within seconds, stepped
together), **helm** (the one player whose inputs steer a vessel), **head time** (the latest universe time at
which a vessel's state is committed), **live clock**, **echo**.

New words:

- **Attended**: a connected player is flying the vessel (or is aboard a docked assembly with command rights).
- **Flight**: the set of vessels one client simulates in Pilot mode: its helm vessel, its own debris nearby,
  and any passive vessel it has claimed while alone with it.
- **Checkpoint**: a small message from a Pilot-mode client at a step boundary: step index, a digest of the full
  state, and the kinematic state. A claim, never an authority.
- **Seal**: the server's own state at a step, produced by replaying inputs from its previous seal. Only seals
  are persisted, shown as fact to others, and used for interaction. A seal is *durable* once its journal row
  is committed.
- **Warp horizon**: the furthest universe time to which the server has cleared a rails vessel to advance
  without asking.

| Mode | Who steps the vessel | Who is ahead | When |
|---|---|---|---|
| **Rails** | nobody; state is a conic (or a landed pose) evaluated on demand | - | coasting or landed, attended or not |
| **Pilot** | the owner's client at 120 Hz; the server's verifier replays the input log in batches | the client, by the verification lag (0.1-30 s) | integrated flight (thrust, atmosphere, terrain contact, proximity) with at most one attended pilot in the island |
| **Host** | an island host on the server at 120 Hz; clients predict the whole island and reconcile | the server | two or more attended pilots in one island; also any vessel the server has moved there by policy (weak or stalled client, repeated mismatches) |
| **Proxy** | the verifier, lazily and in batch, with controls decaying to safe values | the server | an integrated vessel whose pilot has stalled, hidden the tab, disconnected or logged out |

Hand-overs: Rails <-> Pilot (integration starts or stops; a session attaches or detaches), Pilot -> Host (a second
pilot comes within range), Host -> Pilot (the island dissolves or the other pilot leaves), Pilot -> Proxy (stall
or disconnect), Proxy -> Pilot (the pilot returns), Proxy -> Rails or removal (the craft comes to rest).

The mode field is also the knob the user asked for ("optimally pick a balance"): the server may place any vessel
in Host mode at any time, per vessel, without a protocol change. Pilot mode is the default because it is the
cheapest and feels best; Host mode is the fallback that is always correct.

---

## 2. The time model

Adopted from `multiplayer-prior-art.md` (model C plus model D plus a live clock), with the mechanics changed so
that the client does the advancing and the server only grants and records.

### 2.1 Rules

- **T1. One time axis, many worldlines.** Universe time (UT) is seconds since J2000. Every vessel has a head
  time and an immutable history before it. Heads never decrease.
- **T2. Passive vessels have no clock.** A vessel nobody attends, coasting or landed, is a function of time: for
  any UT at or after its head its state is its propagated state, exact and free. It is solid for every viewer
  whose time is not before its head.
- **T3. Three kinds of clock.** Every attended vessel is on exactly one clock:
  - the **live clock**: `UT_live = UT0 + (wall - W0)`, shared, always 1x, on a fixed 1/120 s step grid. It is
    the default spawn time, the time of the menu's Earth, and it keeps running through downtime;
  - a **group clock**: shared by a clock group (an island with two or more pilots, a docked assembly with two
    or more pilots aboard, or players who linked on purpose). Rate = the lowest rate any member requests or is
    limited to. It has a constant offset ("lead") from the live clock while at 1x;
  - a **private clock**: one player's own. Any rate the vessel's situation allows.
- **T4. Interaction needs one clock.** Contact, docking, transfer and control exist only between vessels on the
  same clock, or between an attended vessel and a passive vessel it has claimed (T5).
- **T5. Claim.** When an attended vessel's path brings it within island range of a passive vessel whose head is
  not later than the attended vessel's time, the passive vessel joins that island and its head becomes the
  island's time. The directory (one writer) orders competing claims; the loser sees an echo.
- **T6. Forward only.** A coasting or landed vessel may advance its head to any later UT allowed by its warp
  horizon. Nothing ever moves to an earlier UT. Leads shrink only by waiting: a vessel left passive is resumed
  at `max(head, UT_live)`.
- **T7. Echoes.** A vessel that is not on the viewer's clock and is not passive-and-solid is drawn as an echo:
  visibly distinct (dashed outline, time-offset tag), never collidable, labelled with the action that would
  make it reachable.
- **T8. Lead cap.** No head may be more than 150 years past the live clock (configurable). This bounds float64
  time: at the cap UT is below 5.7e9 s and one unit in the last place is 0.95 microseconds **[derived]**. That
  is harmless because vessels that interact share a clock and a body-centred frame, so the error is common to
  both. Integrated flight already counts whole steps from a base instant (`utBase` + steps), which stays.
- **T9. Wall-clock housekeeping.** Expiry, pad timers, reconnect grace and rate limits run on the wall clock,
  the only clock all vessels share.

### 2.2 What players at different times see

Planets: each client evaluates the bodies at its own vessel's UT. Two players at different times see different
planetary configurations, each correct. The menu shows the live clock.

| The other vessel is | behind me | on my clock | ahead of me |
|---|---|---|---|
| **passive** (head vs my UT) | solid, evaluated at my UT; claimable | - | recorded echo of its committed coast; "jump +X to reach" |
| **attended** | projected echo: where it would be at my UT if it coasted from now, updated when its pilot manoeuvres; "invite to sync" | live and solid; relayed at 4-10 Hz when visible, simulated together when in island range | recorded echo: where it was at my UT, from its stored worldline; "jump +X to sync" |

- Everyone who has not warped since spawning is on the live clock and sees everyone else there live. This is
  the pad crowd.
- A player who has warped sees: their clock group, live; every passive vessel whose head is not after their UT,
  solid; everyone else as echoes with an offset.
- The map has a read-only "view at this vessel's time" control, so "where is my friend, in their now" has a
  truthful answer.
- Recorded echoes need history. Conic patches are kept for the vessel's lifetime (about 100 bytes each, capped
  at 256 per vessel, oldest merged). Integrated arcs (ascent, landing) are kept as 1 Hz kinematic samples for
  30 minutes of wall time and drawn as a coarse arc or nothing after that.

### 2.3 Private warp without server work: the warp horizon

Rails motion is a pure function, so the server does not need to follow a warping client step by step. It needs
to guarantee that the interval the client skips contains nothing that must be simulated.

1. Whenever a vessel's conic is sealed (end of a burn, SOI change, spawn into orbit, undock), the directory
   computes from that conic, once: its next rails event (SOI change, atmosphere entry, impact, periapsis below a
   warp altitude limit), and its screened conjunctions with every vessel that is solid for it (passive with an
   earlier head, or on the same clock). This is the conjunction screening `fleet-docking.md` section 4.2
   specifies; it costs a few milliseconds per orbit change and nothing between changes.
2. The directory sends `Horizon { untilUt, maxRateIndex, limitedBy }`: the earliest of the next event, 30 s
   before the next screened conjunction, and the lead cap.
3. The client advances on rails inside the horizon at any rate it likes, up to the new top levels of
   1,000,000x and 10,000,000x. It reports its UT twice a second (`RailsReport`) and when it stops. The server
   answers with the acknowledged head. A client may run ahead of its last acknowledged head by at most one
   second of wall time at the current rate; that bounds the race in step 5.
4. At the horizon the client stops, reports, and the server (which computed the same event from the same sealed
   conic) commits the new conic and issues the next horizon. Passing an SOI boundary therefore costs one round
   trip, hidden inside the warp ramp-down that v1 already performs before events.
5. If another commit creates a new conjunction inside an outstanding horizon, the directory shortens it. If the
   client's acknowledged head is already past the new conjunction, the encounter lies in that vessel's committed
   past and does not happen. This is the one accepted inconsistency named in the prior-art research (an object
   that appears "in the past" is not collided against history already committed); the one-second rule keeps the
   window to about one round trip.
6. "Jump to T" (sync) is the same mechanism with one large step: a single `advanceRails` on the client, one
   message, one check on the server.

Server cost of a warping player: two small messages a second. Server cost of a parked or coasting ship nobody
attends: zero.

### 2.4 Arranging and flying a rendezvous

- **Target is passive** (a parked ship, an empty station). Target it. If its head is ahead of you, the planner
  offers "jump to its time" (T6); it places the jump shortly before the target's head and plans from there,
  because a long jump destroys any earlier phasing (a 1 m difference in semi-major axis is about 160 km after
  three years). Plan against its conic, warp inside your horizon, arrive. The horizon stops you 30 s before
  island range; the approach is flown at 1x (or up to 4x physics warp). On entering island range the target is
  claimed. Nobody's consent is involved, and no server real-time simulation runs (section 5.2).
- **Target is another attended player.** Whoever is behind jumps to the other's UT, which needs a coasting or
  landed ship. The two are then linked into a clock group (automatic on sync, or by invitation at any
  distance). Warp between burns is a ready-check; a burning member holds the group at 1x or unlinks. Inside
  island range the island host simulates both.
- **Arriving ahead of an occupied station.** The station is a projected echo. The arrival sends a sync
  invitation; the pilots aboard see "ORION is 3 d 4 h ahead and asks you to jump forward". If they accept and
  the station is coasting with a clear horizon, the whole group jumps. If they decline, the arrival parks (goes
  passive) until the station's time catches up, or leaves.
- **Neither will jump.** The one behind must; there is no other consistent option, and the UI says so.
- **Map.** A target's trajectory is drawn as committed patches up to its head and predicted patches after it,
  marked as such. Intercepts and the next three closest approaches are computed on the client from both conic
  chains (0.7 ms per update **[measured]**). The server sends each client its own screened conjunction list.
  This is one mechanism, the existing `Patch` chain, for own craft, targets, echoes and the server's screening.

### 2.5 Entering and leaving warp near other craft

| Situation | Rule |
|---|---|
| Alone (no solid vessel inside the horizon) | Free, any level the altitude limits allow. |
| A screened conjunction ahead (predicted miss under the two bounding radii plus 200 m) | The horizon ends 30 s before it. The pass is integrated at 1x with swept contact tests. Rails objects cannot tunnel because the screening covers every rails pair. |
| Another attended vessel on my clock within approach-watch range (5 km + 8 s x closing speed), or a close approach with one predicted inside 60 s | Rails warp refused, with the names and distances in the reason. Leaving time to dodge a collision is not possible. |
| Inside an island with one pilot (me and passive vessels) | Physics warp up to 4x at will. Rails warp once every vessel is coasting and the pairs are proven apart, or once docked (one vessel). |
| Inside an island or clock group with other pilots | Rate = lowest requested. "Warp to T" is a ready-check with a 15 s auto-decline. A member whose vessel is docked or outside island range stops blocking after the timeout. |
| Leaving a group | Allowed alone when no other attended vessel is inside island range and none is predicted; the departed vessel becomes a recorded echo for those left behind. |
| Arriving by jump next to others | Refused if the destination state is within 5 km of a vessel that is solid there; the planner moves the jump earlier. |

### 2.6 Burns, SOI changes, logout

- **Burns.** A burning vessel is integrated, so it is at 1x or at 2-4x physics warp. In Pilot mode physics warp
  costs the server nothing in real time (the verifier replays four times the steps, later). There is no thrust
  on rails; the fleet has no low-thrust craft (`fleet-docking.md` 2.1).
- **SOI changes.** Per vessel at the exact crossing time, as in v1. A Pilot-mode client crosses when its own
  simulation says so and the verifier reproduces it. An island changes sphere of influence as a unit, on its
  anchor's crossing, so two ships a hundred metres apart are never under two gravity models. In solar orbit an
  island integrates relative to a local origin on an exact Kepler orbit (Encke form), which is what keeps
  docking precise at 30 AU.
- **Network drop, tab hidden, logout.** Section 4.7. In short: a coasting or landed vessel becomes passive at
  its head at once. A vessel in integrated flight keeps flying on the client through a short drop and is
  replayed afterwards; if the client is gone it is carried on by Proxy (controls latched for 5 s, then throttle
  closed, SAS holding) until it can coast, lands or is destroyed. Disconnecting never removes a vessel from an
  island in the middle of a contact.

### 2.7 Paradoxes and how each is excluded

| Paradox | Exclusion |
|---|---|
| Changing something's past | History before a head is immutable; recorded echoes cannot be touched (T1, T7). |
| Touching a future its pilot has not flown | Projected echoes cannot be touched (T7). |
| Two players at different times take one passive vessel | The directory is a single writer and orders claims; the head moves once (T5). |
| Leaving a collision course by changing time | The horizon ends before every screened conjunction; warp is refused under approach watch (2.5). |
| Appearing inside another vessel after a jump | Refused by the 5 km arrival rule. |
| A vessel existing twice or vanishing | One record per vessel, written only by the directory; clients never own records. |
| A client "discovering" a better past after a disconnect | A backlog is accepted only if contiguous with the last acknowledged input and consistent with wall time (4.7). |
| One pad, two rockets at overlapping universe times | Pad reservations are intervals of UT held by the directory (5.6). |
| An object placed in the past that should have hit a committed history | Not resolved; accepted (2.3 step 5). It needs a metre-scale coincidence and nobody can witness it. |

### 2.8 Why this is the most fun workable model

- A solo player has everything single-player KSP gives, including 10,000,000x, and nobody can hold them back.
  Neptune is 1.6 minutes of cruise instead of 2.7 hours.
- New players spawn into a visibly shared launch site, because the default time is the same for everyone.
- Joining anyone ahead of you is one action when you are coasting, and it is free.
- Friends stay together with a link and a ready-check, which is how KSP multiplayer groups already play.
- Stations are always "now" for whoever arrives, as long as they are empty, and cost nothing while empty.
- The price is honest and small: a time offset next to every name, echoes you cannot touch, and the fact that
  someone ahead cannot come back to someone behind. No timeline is ever merged by moving a ship.

Open knobs, to settle in play: a per-station limit on how far one visit may pull it ahead of the live clock
(default off); overflow spawn slots at "live + a few minutes" when every pad is busy (default off, because it
takes those players off the shared clock).

---

## 3. Authority and compute split

### 3.1 The principle

1. The server's authoritative state of a vessel is a chain of seals. Each seal is computed **by the server**
   from the previous seal and the player's inputs. Client state never enters the chain (except under the
   sampling valve, 3.2 level V3, which is off by default).
2. A client's simulation is therefore a prediction that happens to run ahead of the server instead of behind
   it. In Host mode it is ahead by the round-trip time; in Pilot mode by the verification lag.
3. Anything another player can be affected by, and anything persisted, uses seals only.
4. What other players *see* of a distant Pilot-mode craft between seals is its latest checkpoint, which has
   passed the bounds of level V0. It cannot touch them, and it is replaced by the seal within seconds.

### 3.2 The verification ladder

| Level | What | When | Server cost |
|---|---|---|---|
| **V0 bounds** | On every checkpoint: step count against wall time (no more than the permitted physics-warp factor, no less than 0.9x unless a stall is declared); position continuity within the craft's maximum acceleration; propellant never rising; achieved velocity change within the rocket-equation budget of the propellant spent; part set only shrinking, and only at steps with a logged stage, abort or undock command or a declared failure; resources within capacity; digest chained to the previous checkpoint. | always | 2-5 microseconds per checkpoint **[assumed]** |
| **V1 deferred replay** | The verifier replays each segment (at most 10 s, cut at events) from its own previous seal with the logged inputs, using the same `FlightCore`. The result is the seal. It is compared with the client's checkpoint: equal digest with `dmath`, or within a tolerance without. A mismatch sends the client a correction (the server's state); the client rewinds and replays its pending inputs. | every integrated segment, by default | the step cost of the segment, at any time before its deadline; on a cloud vCPU about 230 sim-seconds per CPU-second for an ascent and 415 for a vacuum burn **[derived]** |
| **V2 tight follow** | The same replay, run as inputs arrive, so the seal trails the client by network delay only. | approach watch; a single-pilot island that contains another owner's craft; the last segment before a hand-over, a persist-on-logout or an orbit commit; any vessel with recent mismatches | the same CPU, with a soft deadline of 0.5 s |
| **V3 sampling valve** | Only when the verifier queue exceeds its lag budget, and only with `dmath` in place: isolated vacuum burns (the upper-stage part of an ascent included) and integrated vacuum coasts are replayed with probability 0.25, chosen by the server after the fact; the other eligible segments are sealed from the client's checkpoint after V0. Atmospheric flight, terrain contact, structural events and everything under V2 are never sampled; their seals wait instead. | overload valve, off by default, state published in `/status` and on the rules screen | a quarter of V1 for the eligible segments |
| **V4 independent audit** | A nightly Modal job replays a random sample of the day's sealed segments from the journal on a separate runtime build and reports any difference. It audits the server, not the players. | nightly | a few CPU-minutes |

Lag targets for V1: seal within 5 s of the checkpoint in normal operation, 30 s at most; class V2 work always
runs first. A queue has no time dilation: when it is long, seals arrive later and nothing else changes.

Response to a mismatch: the server's state stands and the client is corrected. Three mismatches in ten minutes
put the vessel in Host mode for the session. A V0 violation that cannot be produced by an honest client (a
rising propellant mass, an impossible step count) ends the session. Nothing is punished on drift alone.

**Determinism.** Node 24 and Chrome 157 differ in the last bit for 15 of the 17 transcendental functions the
sim calls **[measured]**; plain arithmetic and `Math.sqrt` are identical. Consequences here:

- The default mode (V1 and V2 for everything) does not need bit identity. The server computes its own chain;
  drift between client and server starts at 1e-16 relative and is removed whenever the server's value is
  adopted: at every orbit commit (the server sends the conic, 56 bytes), at every hand-over to Host mode, and
  by a full-state resync if the kinematic difference passes the tolerance (1 mm and 0.1 mm/s per minute of
  integrated flight since the last resync).
- `dmath` (own implementations of the 15 functions over about 230 call sites, a contained change per the audit)
  makes digests equal, makes hand-overs exact, removes the tolerance, makes golden hashes independent of the
  V8 build (audit defect 8), and is the precondition for V3. It goes into the sim-core refactor; its acceptance
  gate is a slowdown of the vessel step of no more than 15 % and a browser-versus-Node golden test.
- Terrain is the other source of difference: the browser does not wait for final tiles and the verifier does.
  A checkpoint carries `terrainFinal`. When it was false during contact, a mismatch is expected and the
  server's result wins.
- `Vessel.struct` state (friction anchors, thermal wake factors, wet flags) must be part of the encoded state,
  or a replay from a decoded seal diverges (measured by the audit: 7-19 mm at rest, temperatures that never
  re-converge). Section 7.

### 3.3 Who computes what, per situation

Step costs are the audit's world-step measurements on one 9950X3D core (pad ascent 14.5 microseconds, vacuum
burn 6.9-8.9, entry 7.4-11.3, integrated coast about 6, touchdown 45 for 3 s then 13.7 for 5 s, plus about 3.5
of world overhead where only the vessel step was measured). "Server CPU" is per attended player while in that
situation, in milliseconds of CPU per second of wall time, desktop core then cloud vCPU at 2.5x.

| Situation | Mode | Client computes | Server computes | Server CPU, ms/s (desktop / cloud) | Real-time deadline on the server |
|---|---|---|---|---|---|
| Menu, hangar, spectating | - | rails propagation of the census | nothing per visitor; a 1 Hz spectator snapshot cached at the CDN | 0 | no |
| On the pad, clamps held | Rails (held) | idle vessel | pad timers | under 0.01 | no |
| Ascent through the atmosphere | Pilot | everything | V0, then V1 replay | 1.7 / 4.4 | no |
| Vacuum burn | Pilot | everything | V0, V1 (V3 eligible) | 0.95 / 2.4 | no |
| Coasting, warping, planning nodes | Rails | propagation, patch prediction, closest approaches, readouts | horizon and conjunction screening on orbit change; two messages a second while warping | 0.05 / 0.15, plus about 15 ms per orbit change | no |
| SOI change | Rails | event detection | the same event from the sealed conic; new conic and horizon | under 1 ms per event | no |
| Entry, descent, parachutes | Pilot | everything | V1, never sampled | 1.1 / 2.8 | no |
| Terrain landing | Pilot | everything, on its own streamed tiles | V1, never sampled, on height packs fetched from the bucket | 5.8 / 14.5 for 3 s, 2.0 / 5.1 for 5 s, then 0 | no; the seal waits for tiles |
| Approach to a passive vessel (parked ship, empty station), including docking | Pilot, V2 | the whole island | tight-follow replay of the whole island | 2.1 / 5.3 (two vessels, rising to about 12 / 30 at arm's length, estimated) | soft, 0.5 s |
| Flying a docked assembly alone, others' craft attached | Pilot, V2 | everything | tight-follow replay | as the vessel's regime | soft |
| Two or more pilots within island range (formation, docking, collision) | Host | prediction of the whole island with rollback | 120 Hz island step, contact, capture, damage; 20-30 Hz snapshots | 2.5-3 / 6-7.5 per pilot, peaks of 15 / 40 during close contact (estimated) | **yes** |
| Pilot stalled, hidden or gone, craft under way | Proxy | nothing | batch continuation, computed on demand | the regime's cost, once, at 200-400x real time | no |
| Parked, landed or coasting, unattended | Rails | - | nothing | 0 | no |
| Expiry, pads, roster, rules, chat | - | - | directory | negligible | no |

Two properties worth stating plainly:

- The only deadline-bound simulation on the server is the island with two or more pilots. Everything else can
  be late without anyone's physics slowing down.
- Batch replay touches one vessel for a thousand consecutive steps instead of a thousand vessels for one step.
  A live 42-part vessel is 375 kB of heap **[measured]**, so interleaved real-time stepping of many vessels
  walks hundreds of megabytes per tick. Batch replay should be faster per step than the same work done in real
  time; by how much is unmeasured.

### 3.4 Server CPU per connected player

Mixes **[assumed]**. Normal: 15 % in menus or the map, 45 % coasting, warping or planning, 10 % ascent, 8 %
vacuum burns, 10 % entry, landing or integrated atmosphere flight, 12 % in islands (half of them single-pilot).
HN day: 60 % ascent, 5 % other solo integrated flight, 5 % islands, 30 % coasting or menus. Network handling at
the edge is taken as 0.75 ms/s for a solo connection and 2.5 ms/s for a Host-mode connection; players in menus
hold no socket **[assumed]**.

| Component, cloud ms per player-second | Normal | HN day |
|---|---|---|
| Deferred replay (V1) | 0.44 + 0.19 + 0.28 = 0.91 | 2.61 + 0.13 = 2.74 |
| Tight-follow replay (V2), single-pilot islands | 0.32 | 0.13 |
| Host islands (real time) | 0.42 | 0.18 |
| Rails bookkeeping, directory | 0.17 | 0.15 |
| Edge: sockets, V0, fan-out | 0.74 | 0.70 |
| **Total** | **2.6 ms/s = 0.0026 vCPU** | **3.9 ms/s = 0.0039 vCPU** |
| of which without a hard real-time deadline (V1, V2, rails) | 1.4 | 3.0 |

| Concurrent players | Normal mix | HN-day mix | With the V3 valve open (HN mix) |
|---|---|---|---|
| 20 | 0.05 vCPU (the process baseline of about 0.3 dominates) | 0.08 | - |
| 500 | 1.3 vCPU | 1.9 | 1.3 |
| 5,000 | 13 vCPU | 19.5 | 13 |

The valve column assumes about two thirds of an ascent's duration is vacuum flight and therefore eligible.

For comparison, with the same measured costs, a server that integrates every attended vessel in real time
spends about the same CPU-seconds (plus 20 Hz snapshot building and fan-out for every player), but all of it
against a 8.3 ms deadline. `hosting.md` budgeted 0.03 vCPU per integrated vessel from the 0.1 ms figure in
`ARCHITECTURE.md`; the audit's measurement is 7 to 12 times lower. If the truth lies between (the vessel
hand-off quotes 23-29 microseconds for the same stack), the table above doubles and the conclusions hold.

### 3.5 Bandwidth, tick and send rates

| Stream | Direction | Rate | Size | Bytes per second |
|---|---|---|---|---|
| Physics step | - | 120 Hz everywhere | - | - |
| Control tick | - | 30 Hz of sim time | - | - |
| Pilot: input frames | up | 4 Hz, flushed at once on a discrete command | run-length-encoded control ticks, 7 bytes per change | 60-150 |
| Pilot: checkpoints | up | 1 Hz and at events; 10 Hz when observed nearby or under approach watch | 96 bytes (step, digest, body-centred state) | 100-1,000 |
| Pilot: seal acknowledgements | down | at most 1 Hz | 24 bytes | 25 |
| Pilot: corrections | down | on mismatch only | full state, 4-22 kB | about 0 |
| Rails: reports and horizons | both | 2 Hz while warping, else on change | 16-40 bytes | under 80 |
| Host: inputs | up | 30 Hz | 10-14 bytes | 300-420 |
| Host: snapshots | down | 20 Hz; 30 Hz when any pair is within 200 m | 16-byte header + up to 37 bytes per vessel before delta coding | 600-2,500 |
| Host: part-state deltas, events | down | 2 Hz, events at once | small | 100 |
| Visible craft on my clock, not in my island | down | 10 Hz within 5 km, 4 Hz within 50 km, 1 Hz beyond, capped per client | 43 bytes per sample | 0-2,000 |
| Same-SOI census (map) | down | on change; 0.5 Hz osculating elements for thrusting craft | 64 bytes per object | 100-600, hard cap 2,000 |
| Directory pages, roster, rules, feed, chat | down | on demand or 1 Hz | small | under 100 |

Per-client downstream is scheduled against a hard budget of 4 kB/s: island snapshots first, then nearest
visible craft, then census. Superseded samples are dropped before sending (latest wins), which is also what
makes the same messages fit datagrams if a UDP-capable host ever appears.

Average downstream **[assumed]**: about 1.0 kB/s per connected player in the normal mix, 1.2 kB/s on an HN
day (many players watching neighbours launch), against the 3 kB/s `hosting.md` budgeted for a design in which
every player receives their own craft back at 20-30 Hz. At $0.13 per player-month per kB/s this is the largest
single saving of the proposal. Upstream is not billed.

### 3.6 Cheat resistance, case by case

| Attack | Outcome |
|---|---|
| Forged state (fuel, position, speed) | Never adopted: seals come from replay. Others may see a forged checkpoint of a distant craft for the verification lag, inside V0 bounds; the seal replaces it. |
| Modified physics (more thrust, no drag, no heating) | The replay does not reproduce it; correction, then Host mode. |
| Running the local sim faster or slower than allowed, or pausing | V0 step-count bounds. Below 0.9x for 2 s is treated as a stall: Proxy or Host. |
| Forged trajectories | The server derives every conic from its own seal. Clients never send conics. |
| Dodging an interaction by lying about position | Proximity is judged on seals. Under approach watch the replay follows in real time; withholding inputs is a stall, and the craft continues under Proxy on its last commands. |
| Contact, docking, damage outcomes | Computed by the server in every case: Host step for two pilots, tight-follow replay for one. Effects that touch another owner's craft are displayed on confirmation. |
| Choosing the best of several pasts after a fake disconnect | A backlog must be contiguous, at most 30 s of powered flight, and match wall time within 10 %. |
| Flooding the verifier | V0 bounds the steps a connection can submit to 4x real time; admission limits bound connections per address. |
| Trying inputs offline in a copy of the sim, then playing back the best | Possible, as under every split: the sim is public and deterministic. It is automation, which no design here prevents. |
| Hidden information | None exists. |
| Under the V3 valve only: a forged result for an unsampled isolated vacuum segment, within V0 | Possible gain: a perfectly aimed burn and no steering losses, which an autopilot gives anyway. Detected with probability 0.25 per segment; the digest chain identifies the segment. |

---

## 4. Protocol

### 4.1 Transport and framing

- One binary WebSocket per playing client to the `edge` service (`wss`, HTTP/1.1, the only transport all three
  providers can carry). Menu visitors hold no socket: the title screen polls a CDN-cached spectator snapshot
  at 1 Hz, which keeps a front-page crowd away from the 10,000-connection limit.
- Frame: `u8 type, varint sequence, payload`, little-endian, at most 64 kB. No JSON on the flight path.
  `permessage-deflate` off (CPU for little gain on small binary frames).
- Identity as in `frontend-ux.md` F7: `api` issues a short-lived session token after a signed challenge with the
  device key; the token opens the socket. The account record is the seam for later sign-ins.
- `Hello` carries protocol version, build hash, `DefLibrary` hash, sim hash, a `dmath` self-test digest and the
  calibration's CPU score. A mismatch is refused with "new version ready". A low CPU score starts the client in
  Host mode.
- Clock sync: four ping-pong samples at connect, then one every 5 s; the client estimates server wall time and
  from it the live clock.

### 4.2 Message families

| Family | Messages (direction) | Notes |
|---|---|---|
| Session | `Hello`, `Welcome`, `Refuse`, `TimeSync`, `ServerNotice` (restart, version), `Bye` | |
| Directory | `Spawn` / `Spawned`, `Resume` / `Attached`, `PadSubscribe` / `PadState`, `PadReserve`, `CensusSubscribe` / `CensusDelta`, `RosterPage`, `ShipList`, `Rules`, `Feed`, `Chat` | request-response or on-change streams; these fill the view models of `frontend-ux.md` section 11 |
| Time | `WarpIntent` (rate or target UT), `Horizon`, `RailsReport`, `RailsAck`, `Jump`, `OrbitCommit`, `LinkRequest`, `GroupState`, `WarpProposal`, `WarpVote`, `SyncInvite` | section 2 |
| Pilot | `InputFrame`, `Checkpoint`, `StructureNotice` (up); `Seal`, `Correction`, `SetReportRate`, `ModeChange` (down) | section 4.3 |
| Host | `IslandEnter`, `IslandInput`, `IslandSnap`, `IslandEvent`, `IslandExit` | section 4.4 |
| Craft | `PortArm`, `Undock`, `HelmRequest`, `HelmGrant`, `LendPolicy`, `Transfer`, `Rename`, `Abandon` | carried in the input log in Pilot mode, so they replay |
| Observation | `VisibleSample` (down), `EchoRequest` / `EchoPatches` | section 4.5 |

Every high-rate message is a complete statement tagged with a step or tick ("latest wins"), never an increment
that must not be lost.

### 4.3 Pilot mode: inputs up, seals down

```
client                               edge (V0)            verifier                 directory / journal
  | InputFrame{from, n, rle, cmds} --->|  append to log ----->|                           |
  | Checkpoint{step, digest, kin} ---->|  bounds; relay kin to observers                  |
  |                                    |                    replay segment, seal --------> journal (group commit)
  | <----------- Seal{step, digest, durable} ---------------|                           |
  | (mismatch) <-- Correction{step, state} -----------------|                           |
```

- The **input log** is the ordered list of `(step, vesselId, ControlInputs or command)` for the flight, plus
  rails advances `(fromUt, toUt)`. Commands are those that change state: stage, abort, SAS, RCS, legs, the
  SAS hold direction for a maneuver node, helm changes between own craft, port and transfer commands. Planning
  (nodes, target, navball mode) stays on the client and is saved with the ship as an opaque blob.
- The client keeps every input since the last durable seal, and a ring of its own state at each checkpoint
  (30 entries, under 1 MB) so that a correction is a rewind and a replay of at most a few thousand steps.
- `Seal` tells the client how far the server has verified and persisted. The HUD's link panel shows the lag.
- Commands in Pilot mode apply at once on the client (staging has no latency). Events that touch another
  owner's craft carry `confirmed: false` until the seal covering them arrives; presentation plays their
  irreversible effects on confirmation (about one round trip under tight follow).
- New vessels created by a flight (spent stages, fragments) get ids by the existing deterministic rule
  (`<craftId>~<root part>`), are announced in a `StructureNotice` with their kinematics, and enter the
  directory when sealed.

### 4.4 Host mode: prediction and reconciliation inside an island

- The island host steps at 120 Hz and owns the island clock. Each client simulates the whole island ahead of
  the host by half the round trip plus a jitter buffer of two control ticks, and tags each `IslandInput` with
  the step it is meant for. The host applies it on that step; a late input is applied on the next step and the
  acknowledgement says so.
- `IslandSnap` carries, per vessel, the offset from the island's reference orbit (the anchor's conic,
  evaluated by the receiver in float64): position 3 x int32 at 0.1 mm, velocity 3 x int24 at 0.1 mm/s,
  attitude as the smallest three quaternion components (7 bytes), angular rate 3 x int16, throttle and flags:
  37 bytes before delta coding against the previous snapshot. It also carries every pilot's latest inputs, so
  clients extrapolate others with their last known controls, not ballistically.
- On each snapshot the client rewinds to the snapshot tick and replays its pending inputs (at most about 30
  steps for 250 ms; under 1 ms for three vessels). The visual error is blended out in the island frame over
  0.3 s. The state that is rolled back includes the former `struct` members.
- In prediction the step runs with irreversible transitions suppressed (capture, hard dock, part destruction,
  joint breaks, explosions). They happen when the `IslandEvent` arrives. A predicted bump is fine; a predicted
  explosion that the server then denies is not.
- Dead-man rule: if a pilot's inputs stop for 250 ms, the host zeroes that pilot's rotation and translation
  commands; after 2 s it closes the throttle. A stalled link cannot hold a thruster open against a station.
- Overload: an island that cannot hold 120 Hz runs slower than 1x. Its clock falls behind the live clock and
  stays a group clock; nobody else is affected.

### 4.5 Interest management

Relevance has two axes, space and time relation. Only vessels on the viewer's clock, or passive and solid for
the viewer, are streamed as live objects; everything else is an echo built from directory data.

| Tier | Who | What is sent | Rate |
|---|---|---|---|
| 0 | Own flight (Pilot) | seals, corrections | at most 1 Hz |
| 1 | Own island (Host) | snapshots, inputs of others, part deltas, events | 20-30 Hz |
| 2 | Visible craft on my clock | `VisibleSample`: body-centred state from the craft's latest checkpoint or snapshot, drawn by blending between the osculating conics of consecutive samples with a 150 ms delay; structure on change; ignition and staging events | 10 / 4 / 1 Hz by distance, nearest first, capped |
| 3 | Same sphere of influence | conic elements on change, flagged sealed or provisional; osculating elements for thrusting craft; head time and clock | on change; 0.5 Hz while thrusting |
| 4 | Everywhere else | directory entries (id, owner, body, head, coarse orbit, expiry), counts per body | paged, on demand |

Blending between conics instead of positions is what removes the 780 m per 100 ms problem: a coasting craft is
exact, and a thrusting craft is wrong by half its acceleration times the sample interval squared (about 1 m at
4 Hz), hidden by the delay.

### 4.6 The hand-over between Pilot and Host

```
T-8 s   directory: approach watch on A and B (5 km + 8 s x closing speed, from seals and checkpoints)
        verifier: tight follow for both; clients: checkpoints at 10 Hz
T-3 s   directory: IslandPlan{island, startStep H, host}. Both are on one clock, so H names the same instant.
        (If B is passive it is claimed: its head becomes the island time at H.)
H       verifier seals A and B at H; the island host starts from those seals.
        Clients switch their FlightCore to prediction at H. With dmath the client's state at H is the seal
        and nothing is sent; otherwise IslandEnter carries the seals (4-22 kB per vessel, once).
        If the inputs for steps before H arrive late, the host starts late and catches up at up to 1.25x.
exit    Pairs apart by twice the join distance and opening, or one pilot gone: IslandExit{tick, seals}.
        Each remaining pilot continues in Pilot mode from that tick.
```

Join distance for an island is `1 km + 2 s x closing speed`, as in `fleet-docking.md`. Two craft in crossing
orbits at 10 km/s therefore get about 8 s of watch and 2 s of island before the pass; if a hand-over cannot
complete in time because a link is poor, the host proceeds with the inputs it has, which is the Host-mode rule
for any late input.

### 4.7 Stalls, drops, reconnects, logout

| Event | Pilot mode | Host mode |
|---|---|---|
| Network drop, client still running | The client keeps flying and logging. On reconnect (any edge replica) it sends `Resume{vessel, lastDurableSeal}` and its backlog. Accepted if contiguous, at most 30 s of powered flight, and consistent with wall time within 10 %. The player sees no rewind. | Dead-man rule, then the vessel stays in the island under neutral controls for the 60 s grace. On reconnect: `IslandEnter` with full state. |
| Backlog refused or too long | The server's Proxy continuation from the last accepted input is the truth; the client receives it as a correction ("RESYNCED"). | - |
| Tab hidden (the frame loop stops) | The client sends `Yield`; the vessel goes to Proxy. Nothing is computed until someone needs the state: the player returning (the continuation is computed to that instant and handed back), another craft approaching, or the grace expiring. | The pilot's controls go neutral; the craft stays in the island. |
| Client gone past the grace (30 s powered, 120 s session) | Proxy runs the craft to rest in one batch: throttle closed 5 s after the last input, SAS holding, until it coasts (becomes Rails at that head), lands, or is destroyed. | The same, once the island lets it go; never during a contact. |
| Logout by choice | The flight menu states the outcome first (computed from the snapshot). Coasting or landed: passive at once. Otherwise as above. | As above; the helm becomes vacant and the hand-over rules of 5.5 apply. |
| Same account from a second tab | The newer session takes the flight after the older acknowledges or times out (2 s); the older shows "flown from another session". | Same. |
| Server restart or deploy | Announced with `ServerNotice`. Pilot-mode clients keep flying and re-send their logs afterwards; for announced restarts the powered backlog limit is raised to 120 s. | Islands freeze at their last journaled state. A group clock simply stops, so nothing diverges; they resume when the pilots are back or the grace ends. |

---

## 5. Docking, undocking, collisions and damage, end to end

The physical model is `fleet-docking.md` sections 3 and 4, adopted without change: craft, vessels as forests of
craft trees joined by links, two androgynous port types, soft capture as a compliant constraint in the 480 Hz
sub-steps, hard dock as a momentum-conserving merge, undock through `separateVessel` with the impulse at the
port, convex colliders from part data, three impact regimes by closing speed, the born-overlapping exemption,
conjunction screening, swept sphere tests and conservative advancement. This section says who runs it.

### 5.1 One code path, three hosts

The island step (per-vessel forces, then the contact and capture pass, sub-step by sub-step) is part of
`FlightCore`. A vessel alone is an island of one and steps exactly as today. The same function runs in the
browser, in the verifier and in the island host; which of them is authoritative is the vessel's mode.

### 5.2 Docking with a parked ship or an empty station (one pilot)

1. Rendezvous on rails; the horizon ends 30 s before island range.
2. Approach watch: tight-follow replay begins, the target's sealed state is sent to the client.
3. The target is claimed into the pilot's flight. The client simulates both vessels with no latency at all.
4. Capture, retraction and hard dock happen in the client's simulation and, a network delay later, in the
   verifier's replay. The CAPTURE and HARD DOCK lamps and any damage to the other owner's craft are shown on
   the seal. If the replay disagrees, the server's outcome stands and the client is corrected.
5. The merged vessel is sealed and journaled as one record with both craft and the link.

The server ran no real-time simulation, yet the outcome was computed by the server before it was shown as
fact or stored.

### 5.3 Docking, bumping or colliding with another pilot (two or more pilots)

1. Both must be on one clock (section 2.4). Approach watch, then the hand-over of 4.6.
2. The island host steps both. Each pilot predicts the whole island. At docking speeds a change in the other
   pilot's thrust is wrong on screen by millimetres for one round trip.
3. The capture envelope is judged in server time from simulated contact; there is no lag compensation because
   there are no instant-hit actions. The envelopes are two to three times wider than the real standard to
   leave room for keyboard flying under delay.
4. Soft capture, hard dock, destruction, joint breaks and explosions exist when the `IslandEvent` says so. Both
   players see the same numbers ("COLLISION 4.2 m/s, port 2 destroyed").
5. Two craft reaching one port in the same step: the host's fixed order (vessel id, then part index) decides;
   the other bounces off an occupied port.
6. After hard dock the assembly is one vessel with two pilots aboard: it stays in Host mode on a group clock.
   When one pilot leaves or logs out it returns to Pilot mode under the remaining helm.

### 5.4 Collisions at speed and tunnelling

| Pair | Mechanism | Who decides |
|---|---|---|
| Rails against rails (parked ships, debris, coasting craft on one clock) | Conjunction screening on every orbit change; a predicted miss under the bounding radii plus the margin schedules an encounter that is integrated. Rails objects are never stepped, so they cannot tunnel. | Directory schedules; verifier (Proxy) integrates the pass if nobody attends, else the attended vessel's mode applies. |
| Attended against passive | The horizon stops warp before screened conjunctions; a coarse spatial hash of rails objects (64 km cells, refreshed each second from seals and checkpoints) promotes anything inside the join distance into the island. | Tight-follow replay (one pilot). |
| Attended against attended | Approach watch from seals and checkpoints, then Host mode. Inside the island: swept bounding spheres each step, speculative contacts for slow pairs, conservative advancement for fast pairs. | Island host. |
| Above about 250 m/s closing | No rigid solve; the energy rule of `fleet-docking.md` 4.5. | As the row above. |

An unattended object placed where it should have crossed an already committed history is the accepted
inconsistency of 2.3.

### 5.5 Control sharing

`fleet-docking.md` 3.7 option A: one helm, explicit hand-over, craft sovereignty, lend policies, seniority
anchor. In protocol terms:

- Continuous inputs are accepted for a vessel only from its helm. Craft-scoped commands (stage my craft, arm or
  release my port, pump out of my tanks, change my lend policy) are accepted from the craft's owner at any
  time. The host or the verifier enforces both, since both run the same rule code.
- `HelmRequest` goes to the helm as a prompt; granted on `HelmGrant`, or automatically after 30 s without input
  from the helm, subject to the anchor's `helmPolicy`.
- Helm disconnects: vacant at once, throttle to zero, SAS keeps its mode; the next pilot may take it.
- Warp of an assembly: one vessel has one time. Pilots aboard and online form its clock group; offline owners
  do not block.
- Either side of a port can always release it. Undock: the link is removed, the forest splits by connected
  components, the spring impulse acts at the port, both ports cool down. Each piece's mode is decided afresh
  (the departing pilot is usually back in Pilot mode within one hand-over).

### 5.6 Pads

Pad state (`free`, `reserved`, `occupied`, `clearing`) and timers live in the directory. A reservation is an
interval of universe time on a pad; at the live clock that is the familiar queue. The server builds the craft
(`validateVehicle`, `assembleVessel`, a new craft id), seals its initial state, and sends the id and digest;
the client assembles the same craft locally and compares. Pads are analytic discs, so nothing on a pad needs
terrain data. Neighbouring pads are 1-2.5 km apart, outside island range, so simultaneous launches are
independent Pilot-mode flights that see each other through tier 2. The range-safety rule (impact point inside
another pad's keep-out below 5 km altitude) is evaluated on seals.

---

## 6. Persistence, topology, capacity and cost

### 6.1 Schema (Postgres on Railway, private network)

| Table | Key columns | Purpose |
|---|---|---|
| `accounts`, `credentials` | account id, callsign; kind, public key, label | identity seam (device key today) |
| `vessels` | id, mode, clock ref, head UT, body, conic (r0, v0, t0) or landed pose, situation, bounding radius, state blob (binary, 4-22 kB), state digest, seal step, flags | one row per rigid body; the index columns are also held in memory, the blob is read on demand |
| `crafts` | craft id, vessel id, owner account, vehicle id or design ref, name, joined UT, lend and helm policy, planning blob | ownership and expiry are per craft |
| `worldlines` | vessel id, sequence, body, conic, end time, end reason | committed history for recorded echoes |
| `journal` | serial, wall time, kind, vessel id, payload | append-only: spawn, seal, dock, undock, destroy, claim, horizon, expiry, policy; the recovery log |
| `input_logs` | vessel id, segment, step range, bytes | kept 72 h for audits and disputes, then deleted |
| `pads`, `clock_groups`, `islands` | | restart state for the directory and hosts |
| `rules` | version, document | `UniverseRules`, versioned, served to clients |
| `strikes`, `reports`, `chat_log` | | moderation; chat kept 24 h |

The state codec is binary, tags non-finite numbers and negative zero (JSON loses both), writes definitions as
ids, and includes the former `struct` state. Its acceptance test: decode(encode(v)) continues bit-identically
in every regime, mid-touchdown and mid-entry included.

### 6.2 Write path

- Seals, directory events and incoming input frames go to the journal through one writer with group commit
  every 100 ms. A seal is reported to the client as durable after its commit.
- Between structural changes a seal is a delta (kinematics, resources, module states: 0.3-1 kB). The full blob
  is written at staging, docking, undocking, damage and when a vessel goes to rest.
- Island hosts journal their inputs continuously and a delta seal every 2 s, so an island is recoverable to
  within 2 s by replay in the same runtime.
- Estimated journal volume at 5,000 players: about 0.5 MB/s **[assumed]**; 3,000 IOPS on the volume is ample.
- Second copy: hourly export of the vessel tables and a daily `pg_dump` to a Railway bucket, named by time and
  pruned by the application (buckets have no lifecycle rules). Volume backups daily.

### 6.3 Restart recovery

Every deploy of a stateful service is a restart, so this is the normal path, not the exceptional one.

1. On SIGTERM (drain set to 30 s): stop admitting, send `ServerNotice`, flush the journal, write a clean marker.
2. On start: load rules, the vessel index, pads, groups; rebuild the conjunction screening per sphere of
   influence; replay the journal tail after the last full seals.
3. Passive vessels need nothing: they have no clock.
4. Vessels that were in Pilot mode are restored to their last durable seal plus the journaled inputs. When the
   client reconnects it re-sends everything after that seal from its own log, so the flight continues without
   a rewind. If it does not return within the grace, Proxy runs the craft to rest.
5. Islands resume frozen at their last journaled state and start stepping when their pilots are back or the
   grace ends. The live clock kept running; the island is now a group clock slightly behind it, which the time
   model already allows.
6. A crash (no clean marker) differs only in that up to 100 ms of journal may be missing, which Pilot-mode
   clients re-supply and islands lose.

### 6.4 Expiry and cleanup (all on the wall clock; every number is a `UniverseRules` field)

| Object | Rule (default) |
|---|---|
| Craft with a command part | Kept 14 days after its owner's last session. Any login renews all of the owner's craft. At most 10 craft per account; launching an eleventh asks which to retire. |
| Docked assembly | Lives while any member craft is unexpired. A member whose owner has lapsed becomes unowned but stays attached; the owner of the port it sits on may release it, and it is then debris. So docking to an active station protects a craft's hardware but not its ownership. |
| Debris (no command part, or unowned) | Suborbital: resolved at once at reduced fidelity (impact or burn-up). In orbit: removed 2 hours after it was last inside an attended island, at most 24 hours after creation. At most 24 pieces per owner and 12 new vessels per collision; the smallest go first. |
| Vessel on a pad | Rolled back after 300 s without ignition (one 120 s extension with engines running); 60 s after a disconnect. |
| Splashed down or landed on Earth, owner gone | Recovered (removed) after 10 minutes. |
| Heliocentric escape beyond 100 AU | Removed. |
| Global bound | 50,000 passive objects per universe; beyond it the oldest debris is removed, then admission of new launches is queued. |
| Never swept | A vessel with an attached session, in an island, or under Proxy. |

A sweeper in the directory runs once a minute over an index on the expiry time. Removal is a journal event
and removes the worldline. Every craft's remaining time and the rule that set it are in `ShipRecord` and on the
map; the rules screen renders the table above from the same document.

### 6.5 Topology

```
browser -- HTTPS --> shell      Netlify (T1) or a Railway static service (T2): HTML, JS, CSS, COOP/COEP
        -- HTTPS --> api        Railway, 2 small replicas: identity, lobby, queue, rules, status, signed pack
                                URLs, the 1 Hz spectator snapshot (CDN-cached, max-age 1 s)
        -- WSS ----> edge       Railway, replicated; any replica will do: sockets, token check, V0 bounds,
                                interest filtering and fan-out, input logs towards the journal
        -- Range --> bucket     tile, sky and asset packs (hosting.md, option A; unchanged by this proposal)

Railway private network:
   edge  --> core               one service, one large replica, worker threads:
                                  directory (1 thread, the single writer)
                                  verifier pool (V1, V2, Proxy), vessels pinned to a thread by id
                                  island pool (Host mode, 120 Hz)
                                  journal writer
   core  --> Postgres (volume, backups)      core --> bucket (height packs by range, exports)

Modal (own environment, prefixed apps; existing apps untouched):
   verifier overflow (preemptible; batches of segments in, seals out)    nightly audit (V4)
   bot fleets (the real client core, headless)                           bakes, transfer-window grids
```

- Connections dial inward only: `edge` replicas open persistent connections to `core`, a single addressable
  service. Nothing depends on addressing an individual replica, which Railway does not offer from outside and
  has not confirmed inside.
- Below about 1,500 players `api`, `edge` and `core` are one Node process with worker threads; the boundaries
  are message channels from the first day, so splitting them is configuration.
- Terrain: only the verifier and island pools need height tiles, lazily, by range from the bucket into an LRU
  on ephemeral disk. A solo landing never waits on the server's tiles; its seal does.
- Netlify, if used, needs from the user: a Pro team with auto-recharge on, the CLI installed, and a token and
  site id for CI (or the GitHub App). Nothing in the multiplayer core depends on it; T2 is a full substitute
  and cheaper, and at 5,000 sustained players the shell's bandwidth alone is about $380 a month on Netlify.

### 6.6 Capacity, bottlenecks, scaling path

Estimates **[derived from the assumptions above]** for one 24-vCPU, 24 GB Railway replica running `core` and
the `edge` threads together:

| Resource | Capacity per thread | Binding at |
|---|---|---|
| Verifier | about 230 concurrent ascents, 415 vacuum burns, or 350 entries | 5,000 players: about 6 threads in the normal mix, about 14 in the HN mix |
| Island host | about 45 two-pilot islands at 60 % duty | normal mix at 5,000 (150 islands): 3-4 threads |
| Edge | about 900 solo-heavy connections at 70 % duty | 5,000 players: 5-6 threads |
| Directory, journal writer | several thousand state-changing events per second | one thread each; not binding before tens of thousands of players |

So one replica should hold about 5,000 connected players in the normal mix (about 19 busy threads) and about
4,000 in the launch-heavy mix before verifier overflow goes to Modal. These are estimates; the load test
replaces them.

Bottlenecks, in the order they are expected to bind:

1. **Pads, not CPU**: 12 pads give 180-480 launches an hour (`fleet-docking.md`). More pads are data.
2. **Verifier throughput** on a launch-heavy day. It degrades by lag, then by the V3 valve, never by slowing
   anyone's flight. Overflow to Modal costs about $0.00003 per ascent **[derived]**.
3. **Egress** as a cost, bounded by the per-client budget.
4. **The directory as a single writer.** It is deliberately small; if it ever binds, it splits by sphere of
   influence, since a claim or a screening never spans two.
5. **10,000 connections per Railway service**: a second `edge` service, or a raised limit on request.
6. **Journal write rate**: delta seals keep it low; Postgres HA only when reads compete.

Scaling path: (1) one process; (2) split `edge`; (3) split `core` into `directory`, `verify-*` and `island-*`
services, each one replica and addressable by name; (4) Modal for verifier bursts; (5) a second lobby, which is
a second copy of the stack.

### 6.7 Monthly cost

List prices from `hosting.md` (Railway $20 per vCPU-month, $10 per GB-month, $0.05 per GB egress; Netlify
$0.133 per GB at recharge). "Sustained" means that concurrency held all month. Topology T1; T2 saves the
Netlify line.

| Line | 20 | 500 | 5,000 sustained | One HN day at 5,000 (extra) |
|---|---|---|---|---|
| Simulation, verification, edge CPU | $7 (baseline) | $40 | $306 | $13 |
| RAM | $12 | $50 | $110 | $4 |
| Postgres, volume, backups | $9 | $51 | $210 | $3 |
| WebSocket egress at 1.0 kB/s (1.2 on the HN day) | $3 | $66 | $657 | $26 |
| API, edge mirror for tiles, bucket | $4 | $25 | $70 | $2 |
| Modal (audits, overflow, occasional bots) | $0 | $10 | $60 | $2 |
| Netlify shell | $20 | $80 | $380 | $20 |
| **Total, T1** | **about $55** | **about $320** | **about $1,800** | **about $70** |
| Total, T2 | about $35 | about $250 | about $1,500 | about $55 |
| Pessimistic (CPU x2.5, egress 1.5 kB/s), T1 | about $60 | about $440 | about $2,600 | about $95 |

- Railway's $20 Pro fee includes $20 of usage and is inside these totals.
- Tile delivery is as in `hosting.md`: $0 on the bucket path, up to $750 for an HN day if that path fails.
- Rehearsals: a one-hour run of 5,000 bots that really fly costs about $3-13 on Modal plus about $2 on Railway.
- Funds to ask the user for: a standing $100 a month, a spike reserve of $300 (plus the $750 tile worst case),
  and $150 for rehearsals. The $500 per provider allowance stays for R&D.

---

## 7. What changes in place, and where single-player flying lives

Nothing is bolted on. The single-player game is the general case of this architecture: a flight with no second
pilot nearby. The multiplayer parts are what the directory adds around it.

### 7.1 The central refactor: `World` becomes three things

| New unit | Where | Contents | Runs in |
|---|---|---|---|
| `FlightCore` | `src/sim/flight/` (from `src/sim/world/sim.ts`) | One clock (`utBase` + steps), N vessels, controls per vessel id, the landed / rails / integrated state machine, `advanceRails` with exact events, SOI hand-over, the reduced tier, island formation and the island step, events. No player, no active vessel, no warp policy, no snapshot building, no scenario. `step()`, `advanceRails()`, `applyInput()`, `encode()`, `digest()`, and the pure `replay(seal, log) -> seal`. | browser (lead or prediction), verifier (batch), island host (real time), tests |
| `ClientSim` | `src/client/sim/` | Implements the existing `Sim` facade for presentation: owns a `FlightCore`, the input log and checkpoints, the planning state (nodes, target, navball mode), and builds `SimSnapshot` (readouts, navball, staging, patches) from the core plus the replica of other craft. | browser; Node for bots and the mission test |
| `Directory` | `src/sim/universe/` (pure logic) and `src/server/` (hosting) | Heads, clocks, horizons, claims, conjunction screening, clock groups, pads, expiry. Pure functions over a store, testable headless. | server; in-process for offline use |

The 35-42 microsecond snapshot build and the 27-140 microsecond patch prediction, which the audit found cost
more than stepping, never run on the server.

### 7.2 By module

| Module | Change |
|---|---|
| `src/core/math` | Add `dmath` (deterministic sin, cos, tan, atan, atan2, asin, acos, exp, log, log2, sinh, cosh, atanh, acosh, cbrt). A boundary test forbids the native ones in `src/sim`, `src/core/geo` and `src/terrain`. New golden test: the same ascent in Chrome and in Node gives equal digests. |
| `src/sim/vessel` | The `fleet-docking.md` 2.7 model: `crafts[]`, `links[]`, `helm`, `PartRuntime.craft`, universe-unique ids, stage stack per craft. Move the stateful members of `struct` (friction anchors, wake factors, wet and contact flags) into vessel state. Binary codec and digest. Momentum-conserving merge. A single-craft vessel behaves exactly as today. |
| `src/sim/dynamics` | Island stepping sub-step by sub-step, the contact and capture pass, swept tests, optional local origin, and a step mode `authoritative` or `predict` (irreversible transitions suppressed). |
| `src/sim/orbit` | Per-patch prediction horizon (the 60-day defect), vessel-versus-vessel closest approach, conjunction screening, warp levels to 1e7, SOI search floor scaled to the SOI. |
| `src/sim/bodies` | Sun-rooted set, as `solar-system.md`; the frame handed to presentation is centred near the viewer. |
| `src/sim/world/milestones.ts` | Kept as an optional per-vessel observer (the lunar proof). |
| `src/core/contracts/sim.ts` | `Sim` stays as the presentation-facing facade. `SimSnapshot`: `activeVesselId` nullable; `warp` joined by `time: TimeView`; `scenario`, `mission`, `milestones` become an optional objectives block; `VesselSnapshot` gains `crafts`, `links`, `timeRelation` (`solid`, `echoRecorded`, `echoProjected`), `leadS`, `mode`, `provisional`; `PartSnapshot` gains `craftId`; events gain `confirmed`, docking, collision and mode-change kinds. `stateHash` becomes the digest. `Sim.debug` exists only under local authority. |
| `src/core/contracts/controls.ts` | `PlayerCommands` results become tickets (`applied`, `pending`, `refused` with reason), resolved by an event. `setWarpLevel` becomes `requestWarp`; add `jumpTo`, `syncWith`, `link`, `unlink`, `voteWarp`, `setTarget(TargetRef)`, port, helm, lend and transfer commands. Planning commands are documented as client-local. |
| `src/core/contracts/defs.ts` | Warp table (nine rails levels), pads, docking ports and colliders, `ScenarioDef` demoted to a spawn recipe plus optional objectives. |
| New `src/core/contracts/net.ts`, `universe.ts` | Wire messages, `UniverseRules`, `VesselRecord`, `ClockRef`, `Horizon`, `ShipRecord`, `PadState`, `TimeView`. One source for client, server and bots. |
| `src/net/` (shared), `src/client/net/`, `src/server/` | Codec; client transport and replica; edge, directory host, verifier, island host, journal. |
| `src/app` | Written once against `ClientSim` (it is still a shell today). |
| `src/pilot` | Unchanged interface (it drives the `Sim` facade), so the scripted pilot is also the bot. Commands become ticket-aware. |
| Presentation (`src/render/**`, `src/ui`, `src/map`, `src/audio`, `src/camera`) | Keep reading `SimSnapshot`. Keys become `craftId/instanceId`; lookups by `vehicleId` move to the craft; echoes get a material and a tag; relevance caps for many craft. |
| `ARCHITECTURE.md` decisions touched | Row 15 (sim on the main thread) stays. Row 27 (no vessel contact) and the single-clock, single-warp text are replaced. Decision 4 (no pack files) changes for deployment only. |

### 7.3 Where the Earth-Moon-return mission lives

- In play: the player spawns on a pad at the live clock. The whole flight is Pilot mode and Rails with private
  warp. Unless another pilot comes within island range, the server never simulates in real time and the player
  never waits on the network. Staging, burns, the landing and the entry respond exactly as in v1.
- In tests: `tests/mission` runs `ClientSim` with **local authority**, an in-process directory and verifier with
  no network. That is the same code path as online with zero latency. The proof gains an assertion: every seal
  the verifier produces equals the client's checkpoint digest for the entire mission. The golden hash is
  re-baselined once, after the id change, the Sun re-root and `dmath`.
- Local authority is also what the calibration benchmark and the labs use, so the no-cheat rule (a debug API
  that voids the run) keeps its meaning there and does not exist online.

### 7.4 Order of work

(1) Vessel model, ids, codec, `struct` state, `dmath`. (2) `FlightCore` and `ClientSim` with local authority;
the lunar mission passes on it. (3) Directory, time model, edge, verifier: private warp, persistence, restart.
(4) Islands, contact, docking in Pilot mode against passive targets. (5) Host mode and the hand-over.
(6) Load tests and tuning. Each stage is playable.

### 7.5 Answers to the open questions of `frontend-ux.md` section 15

| Question | Answer in this design |
|---|---|
| Time relations and sync action | `synced` = on the live clock; `ahead` / `behind` = on a private or group clock with an offset; `catchingUp` = a jump or a host catch-up in progress. `syncAction` is "jump to X" or "invite X to jump". Proposals and votes exist inside clock groups only. |
| Control of a docked assembly | One helm with hand-over; owners may always stage and undock their own craft; a vacant helm passes on request (5.5). |
| Expiry | Wall clock; 14 days from the owner's last session; 10 slots; debris 2-24 hours (6.4). |
| Damage model | Parts are intact or destroyed; no health value. |
| Spectating | A CDN-cached 1 Hz census for the menu; one remote craft at tier-2 rate for the live camera. |
| Admission | Soft cap per lobby at the `api`; queued players may use the hangar and the spectator view. |
| Nodes saved with the ship | Yes, as an opaque planning blob on the craft. |
| Pads | Reservation 90 s, on-pad hold 300 s, clearing 20 s (`fleet-docking.md` 5.3). |
| Logout under thrust | Controls latched 5 s, throttle closed, SAS holds, carried to rest (4.7). |
| Sharing nodes with partners | Not in the first version; the planning blob stays private. |

---

## 8. Verification plan

Everything below runs against the real protocol. "Bot" means the real `ClientSim` driven by the scripted pilot
in Node; "browser client" means a separate Chrome instance under Playwright.

| # | What | How | Passes when |
|---|---|---|---|
| 1 | Cross-runtime determinism | The same ascent, entry and touchdown in Chrome and in Node; `dmath` unit vectors in both | Digests equal at every checkpoint |
| 2 | Codec exactness | Encode and decode mid-touchdown, mid-entry, mid-capture; continue both copies 6,000 steps | Bit-identical; the audit's 7-19 mm divergence is gone |
| 3 | Lunar mission under local authority | The existing headless and browser missions on `ClientSim` | Mission completes; every seal equals the client digest |
| 4 | Two separate browser clients | Two Chrome processes against a local server: launch from two pads at once, rendezvous, dock, hand over the helm, undock, collide at 5 m/s and at 500 m/s, warp by ready-check | Both clients report the same event numbers; momentum conserved across dock and undock to 1e-9; no pass-through at any phase |
| 5 | Latency injection | A proxy between client and edge adding delay, jitter, multi-second stalls and bandwidth caps (TCP cannot drop or reorder, so stalls stand in for loss); profiles 50, 150, 300 ms and 2 s stalls | Pilot-mode flight shows no correction; Host-mode docking succeeds at 300 ms; corrections stay under the stated blend limits |
| 6 | Disconnect and reconnect | Pull the socket in ascent, in a burn, in an island, on a pad; hide the tab; open a second tab | Outcomes of table 4.7; no rewind for a 20 s drop in Pilot mode |
| 7 | Hand-over | Two pilots approaching at 0.2 m/s, 50 m/s and 10 km/s crossing, with and without injected delay | Island starts from seals; no discontinuity above 1 cm with `dmath`; the fast pass is resolved by the host |
| 8 | Time model | Private warp to Mars and capture; jump to a parked ship ahead; sync invitation to an occupied station; warp refused under approach watch; horizon shortened by a late commit; claims of one vessel from two times | Each rule of section 2 has a test that fails if the rule is removed |
| 9 | Cheating clients | A bot with altered thrust, forged checkpoints, a fast clock, withheld inputs before an encounter, a forged conic, a replayed backlog | Each is corrected or refused; no forged state is ever sealed |
| 10 | Restart recovery | `kill -9` of `core` during an ascent, a docking in Host mode and with assemblies parked; then a clean deploy | State after restart equals the last durable seals plus replay; docked assemblies intact; Pilot flights continue |
| 11 | Expiry | An injectable wall clock advanced through every rule of 6.4 | Objects removed exactly as the rules document says; protected ones kept |
| 12 | Interplanetary flight | A bot flies Earth to a capture orbit at Mars and at Jupiter with private warp | The server's sealed state is a bound orbit at the target |
| 13 | Load test | Modal bot fleets flying real ascents, orbits, rendezvous and dockings at 20, 500, 2,000 and 5,000; a pad-heavy mix and a normal mix; a reconnect storm after a deploy | Reported as measured: seal lag p50 and p99, island tick time, edge and directory CPU, messages and bytes per player, journal rate, the player count at which each limit is reached, and whether the V3 valve opened |
| 14 | Soak | 200 bots for 24 hours with expiry accelerated | Bounded memory and object counts; no drift between seals and the nightly audit |

The load test replaces the three assumptions this document rests on: the cloud slowdown factor, the average
downstream bitrate, and the edge cost per connection. Capacity is published from its results, not from 6.6.

---

## 9. Honest weaknesses

1. **Two authority modes and a hand-over between them.** This is the hardest engineering in the proposal. The
   join at island formation must be exact under delay, and every feature (contact, staging, docking, SOI change)
   has to be correct in the browser as lead, in the verifier as follower and in the host as authority. A design
   in which the server always leads has one schedule.
2. **Everything depends on deterministic replay.** Any difference between runtimes, any state missing from the
   codec, any iteration-order slip becomes a visible correction in the middle of someone's flight. `dmath`
   costs sim speed (unmeasured; the gate is 15 %) and about 230 edited call sites. Without it the design still
   works, by tolerance, but hand-overs carry full states and the sampling valve must stay shut.
3. **A claim is visible before it is verified.** For up to the verification lag (seconds, normally) other
   players see an isolated craft where its client says it is, within physical bounds. It cannot touch them and
   is replaced by the seal, but it is not yet the server's number. Outcomes are always the server's; live
   positions of distant solo craft are not, briefly.
4. **The saving is not mainly money.** With the audit's measured step cost, simulating everything on the server
   would cost a similar number of CPU-seconds. What this design saves is deadlines, egress and latency. If the
   load test shows the server has ample real-time headroom, the simpler design may be the better trade.
5. **The sampling valve, if ever opened, admits bounded cheats** in isolated vacuum flight (a perfectly aimed
   burn), detected with probability 0.25 per segment. It is off by default for that reason.
6. **Terrain mismatch.** A client that touches down on tiles that were not final will be corrected at the
   moment it matters most. Prefetch along the predicted impact point reduces it; it cannot be excluded.
7. **Weak, throttled and hidden clients.** A client that cannot hold 120 Hz, or whose tab is hidden, loses
   Pilot mode and falls back to Host or Proxy. The feel then is that of the server-led design, and the server
   pays real-time CPU for exactly the clients that are already struggling.
8. **Fast encounters between two pilots leave little time.** At 10 km/s closing, the island exists for about
   two seconds before the pass and the watch for about eight. A poor link at that moment means the host decides
   with the inputs it has.
9. **Warp at 10,000,000x outruns the network.** One round trip is days of universe time. The one-second rule
   bounds it, but a late commit by someone else can still fall inside a vessel's committed past and be ignored.
10. **Forward-only time strands people.** Whoever is ahead cannot return; a popular station is pulled ahead by
    its latest visitor; echoes need teaching. The prior art shows this is tolerated by small groups. A lobby of
    thousands is untested.
11. **A larger attack surface.** The server parses and replays client-supplied logs. The verifier must be robust
    against malformed and adversarial input, and must bound its own work per connection.
12. **Bots cost more.** A load-test bot is a full client. That is honest load, and several times the price of
    idle sockets.
13. **Unmeasured:** cloud vCPU speed, batch-replay throughput, real-terrain contact cost on the server, memory
    per hot vessel in the verifier, edge cost per connection, Railway behaviour at 10,000 sockets, and every
    bandwidth average in this document.

---

## 10. Decisions and approvals needed

| From | What |
|---|---|
| Architect | Accept or reject Pilot mode as the default. If rejected, the same protocol and refactor run with every vessel in Host mode; nothing else in sections 2, 5, 6 or 7 changes. |
| Architect | `dmath` in the sim-core refactor (recommended), or tolerance comparison only. |
| Architect | The two time-model knobs of 2.8 (station pull-ahead limit, overflow spawn slots). |
| User | Railway Pro and a new project; a dedicated Modal environment; Netlify Pro with auto-recharge, CLI and token if T1 is wanted, otherwise T2. |
| User | Budget: $100 a month standing, a $300 spike reserve (plus the $750 tile worst case), $150 for rehearsals. |
