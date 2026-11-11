# Design proposal: the server simulates everything that matters (v2 multiplayer core)

Status: design proposal for the v2 architecture, written 2026-11-11. Design only: no source, contract, test,
data file or existing document was changed, nothing was deployed, no cloud resource was created.

Stance argued here: **clients send inputs and render; the server integrates every vessel that is not on
rails; clients predict only so that the controls feel immediate.** The proposal pushes that as far as it
goes, shows how it scales (analytic rails, physics bubbles, worker shards, tick-rate tiers) and what it costs.

Inputs read in full: `PROMPT.txt` (both halves), `docs/research/v2/*.md` (codebase-audit, multiplayer-prior-art,
hosting, solar-system, fleet-docking, frontend-ux, user-decisions), plus `docs/ARCHITECTURE.md` section list and
`src/core/contracts/{sim,controls}.ts`.

Status of the numbers in this file:

- **measured** = quoted from a v2 research file that measured it (mostly `codebase-audit.md` section 3.3, on one
  Ryzen 9950X3D core, Node 24);
- **derived** = arithmetic done for this proposal from measured inputs and stated assumptions;
- **assumed** = a planning value that the load test must replace. Cloud vCPU speed has not been measured by
  anyone yet; every capacity and cost figure below carries that uncertainty (a factor of 3 to 6).

---

## 0. The proposal in one page

### 0.1 Decisions

| # | Topic | Decision |
|---|---|---|
| P1 | Authority | The server is the only place where a vessel's state advances. A client never owns, uploads or commits vessel state. It sends control inputs and commands; it receives state. |
| P2 | Unit of simulation | A **bubble**: the set of vessels that can touch within the next seconds, stepped together at 120 Hz in a local frame, on one clock. A vessel alone is a bubble of one. Everything not in a bubble is an analytic trajectory that costs nothing between events. |
| P3 | Time model | **Worldlines.** Every vessel has a committed history up to its own head time. Time only moves forward. Vessels interact only at equal time. A vessel nobody is flying has no clock and is solid for everyone at or after its head. Active vessels belong to **clocks**; one shared **live clock** gathers everyone who has not warped. Warp is private for a clock with one pilot and by consent for a clock with several. (Section 2.) |
| P4 | Client role | The client runs the same `src/sim` code as a **replica** of its own bubble: it predicts every vessel in the bubble, replays on correction, and builds the existing `SimSnapshot` locally for the renderer, HUD, map and audio. Planning (nodes, patches, closest approaches) is client-only. |
| P5 | Protocol | Binary WebSocket. Inputs up at 30 Hz; exact bubble state down at 10 Hz (one pilot) or 30 Hz (shared bubble); structural changes as deterministic operations; coasting craft as orbital elements sent only on change. (Section 4.) |
| P6 | Irreversible outcomes | Staging, separation, capture, hard dock, undock, destruction, joint breaks, spawned ids, pad assignment, warp grants: decided by the server only, shown by clients only after the server's event. |
| P7 | Persistence | Postgres holds every vessel record. Bubbles are made durable by a periodic full checkpoint plus a journal of inputs; the server's own determinism (same runtime, same build) makes replay exact. A deploy is a lossless restart. (Section 6.) |
| P8 | Topology | Railway: stateless **gateways** (sockets, fan-out), one **directory** (the universe's single writer), **simulation workers** (one isolate per core, many bubbles each), Postgres, a bucket. Netlify or a Railway static service for the shell. Modal for bots, batch jobs and overflow. One binary, roles chosen by configuration, so the same code runs in one process (quiet times, tests, single-player) or across machines. (Section 7.) |
| P9 | Offline and tests | The Earth-Moon-return mission, the calibration benchmark and every lab run the same universe code in-process over a loopback transport. There is no separate single-player simulation. (Section 8.4.) |

### 0.2 The numbers that carry the argument

| Quantity | Value | Status |
|---|---|---|
| Server CPU per integrated vessel-step | 2.6 to 14.5 us, 45 us at touchdown | measured |
| Weighted cost of one integrated object, normal activity mix | 9.0 us per step, 11.7 us with bubble overhead, 1.4 ms of CPU per second on the measured core | derived |
| Same, on a cloud vCPU at an assumed 2.5x slowdown | 0.0035 vCPU (normal mix), 0.0045 vCPU (launch-heavy mix) | derived, assumed derate |
| Server CPU per connected player, everything included | 0.0055 vCPU (normal), 0.0094 vCPU (everyone launching) | derived |
| Same on the hosting research's conservative figure (0.03 vCPU per vessel) | 0.025 and 0.043 vCPU | assumed |
| Integrated objects one worker thread carries at 50 % load | about 100 to 125 (33 at 100 % on the conservative figure) | derived |
| Downstream bandwidth per player, average | 1.75 kB/s (normal mix) to 2.25 kB/s (launch-heavy); plan with 2.5 kB/s | derived |
| Upstream per player | under 0.6 kB/s | derived |
| Monthly cost, 20 / 500 concurrent held all month | about $60-70 / about $430-650 | derived |
| 5,000 concurrent: held all month / one front-page day on top of a quiet month | about $2,800-5,000 / about $105-255 | derived |
| What "server simulates everything" adds over letting clients integrate solo vessels | $1 to $6 per day at 500 players, $20 to $100 for a 5,000-player day | derived from hosting.md section 7 |

The last row is the core of the stance: at the measured costs, simulating every attended vessel on the server
is not a money question. It buys one execution path instead of two, no trust in client state, no hand-over when
a solo vessel meets another, a universe that does not depend on any client keeping up, and deterministic
replay as a durability and audit tool. Its price is real-time deadlines on the server, terrain data on the
server, and the engineering of shards. Section 10 lists the weaknesses without softening them.

### 0.3 What the user has to provide or approve

- Railway Pro on the workspace and a new Railway project (the existing project is not touched).
- A dedicated Modal environment for bots and batch jobs (existing Modal apps and volumes stay out of reach).
- Either a Netlify Pro team with auto-recharge plus a token (the Netlify CLI is not installed and `.env` has no
  token), or agreement to serve the shell from Railway.
- Budget: about $100 a month standing, about $300 reserve for a traffic spike, about $150 once for load-test
  rehearsals (same request as `hosting.md` section 11; this design does not raise it).

---

## 1. Vocabulary and system shape

| Word | Meaning |
|---|---|
| **Craft** | What one player launched: one instance of a `VehicleDef` with a server-assigned id that never changes (as in `fleet-docking.md`). |
| **Vessel** / **assembly** | One rigid body. It holds the parts of one craft, or of several docked craft. |
| **Tick** | 1/120 s of universe time. The canonical universe time is an integer tick count since J2000 (section 2.11). `ut` in seconds is derived from it. |
| **Head** | The latest tick at which a vessel's state is committed. History before the head never changes. |
| **Attended** | A vessel with a connected pilot aboard, or one the server is still carrying for a pilot who left (section 2.6). |
| **Passive** | A vessel nobody attends that is coasting or landed. It has no clock: its state at any tick at or after its head is its propagated state. |
| **Clock** | A server object: a tick counter and a rate. Every attended vessel belongs to exactly one clock. |
| **Live clock** | The one shared clock that runs at 1x and never warps. It is the default spawn time. |
| **Lead** | A clock's tick minus the live clock's tick. |
| **Bubble** | Vessels of one clock that are close enough to touch, integrated together in one local frame. What `fleet-docking.md` calls an island. |
| **Solid** | Another vessel is solid for me when it exists at my time and can therefore touch me. |
| **Echo** | A drawing of a vessel that is not at my time. A *recorded echo* shows where a vessel that is ahead was at my time. A *projected echo* shows where a vessel that is behind would be at my time if it coasted from now. Echoes are never collidable and are labelled with the time offset. |
| **Helm** | The one player whose control inputs steer a vessel. |
| **Directory** | The server process that holds every vessel record, every clock and every passive trajectory, and orders everything that changes them. |
| **Worker** | A server isolate that steps bubbles. |
| **Gateway** | A server process that holds client sockets and forwards state. It runs no physics. |
| **Replica** | The client-side copy of the player's bubble, predicted with the same code. |

```
browser                                Railway (private network)                         Modal
+-------------------------+            +-----------+        +-------------------------+   +---------------+
| input -> controls       |--inputs--->|           |------->| worker: bubbles @120 Hz |   | bot players   |
| replica (predict bubble)|<--bubble---|  gateway  |<-------|  (one isolate per core) |   | batch: fates, |
| census (rails objects)  |<--census---| (sockets, |        +-----------^-------------+   |  screening,   |
| SimSnapshot -> renderer,|            |  fan-out) |                    | assign, claim,  |  transfer     |
|  HUD, map, audio        |            +-----^-----+                    | hand-over       |  grids, bakes |
+-------------------------+                  | census, clocks, pads  +--v--------------+  +---------------+
        ^  tiles, shell                      +-----------------------| directory       |
        |                                                            | (single writer) |--> Postgres, bucket
  Netlify / bucket                                                   +-----------------+
```

---

## 2. Time model: worldlines

`multiplayer-prior-art.md` section 5 compares the model families and recommends per-vessel head time. This
proposal adopts that recommendation and turns it into server objects, exact rules and numbers. What is added
here: the clock as a server object, the live clock as one shared clock (so the pad crowd is one group without
anyone asking), integer tick time, a jump that is planned to arrive in phase, consent rules for idle pilots,
time-shifted launch slots, and the bound on how much history an echo needs.

### 2.1 The objects

- **One universe, one time axis.** Bodies are functions of the tick. Anyone can evaluate any body at any tick.
- **Worldline.** Per vessel: a chain of committed conic patches and sampled integrated arcs up to the head.
- **Passive vessel.** A record in the directory: body, conic (seven numbers), head tick, and its precomputed
  end (none, impact, atmosphere entry outcome, escape). It is evaluated on demand. It is never stepped.
- **Clock.** `{ id, tick, rate, anchorWallMs, members, untilTick, limitedBy }`. The schedule
  `tick(wall) = tick + rate x 120 x (wall - anchorWallMs)`, clamped at `untilTick` (the next event of any
  member), is all a worker and a client need to agree on the time of every vessel on that clock.
- **Live clock.** A clock with fixed rate 1. Every spawn joins it by default. A vessel leaves it the moment it
  warps or jumps, and can never rejoin it, because nothing moves backward.
- **Bubble.** A group of vessels of one clock within touching range, with a local origin on an exact Kepler
  orbit (section 3.3).

### 2.2 Rules

Every number is a field of the server's `UniverseRules` document (`frontend-ux.md` F15); the values below are
the proposed defaults.

- **T1. Forward only.** A head never decreases. No operation moves a vessel or a clock to an earlier tick.
- **T2. Equal time to interact.** Contact, docking, resource transfer and control exist only between vessels
  on the same clock, or between a vessel on a clock and a passive vessel whose head is not later than that
  clock.
- **T3. Passive vessels are timeless.** For a viewer at tick `t >= head`, a passive vessel is at its propagated
  state at `t`, solid and exact. For a viewer at `t < head` it is a recorded echo.
- **T4. Claim.** When an attended vessel comes within bubble range of a solid passive vessel, the server moves
  the passive vessel into that bubble and its head becomes the clock's tick. The directory is single-threaded,
  so competing claims have one order; the loser sees the vessel become an echo ("changed at +3 h 12 m, jump
  to reach it").
- **T5. Warp belongs to the clock.** The clock's rate is the lowest of: what each pilot on it requests, and
  what each member vessel permits (1x to 4x while anything on the clock must be integrated; the altitude
  ladder of `src/sim/orbit/warp.ts`; 1x before any scheduled encounter). A clock with one pilot is private
  warp with no one to ask. Levels are the v1 table plus 1,000,000x and 10,000,000x.
- **T6. Sharing a clock.** Vessels in one bubble must be on one clock (they already are, by T2). Pilots may
  also **link** at any distance ("fly together"): their vessels move onto one clock. A rate change above 1x on
  a clock with several pilots is a proposal with a 15 s ready-check. A pilot may set "follow" for a named
  pilot, which accepts that pilot's proposals automatically. A pilot who has given no input for 120 s and
  whose vessel is coasting, landed or docked is counted as accepting.
- **T7. Leaving a clock.** A pilot may take their vessel off a shared clock (to warp alone) when no other
  pilot's vessel is in its bubble. Inside a shared bubble, leaving needs consent, or distance: a bubble
  dissolves at twice its join range (join range is 1 km plus 2 s of closing speed, so about 2 to 2.5 km apart
  at docking speeds). To those left behind, the departed vessel is from then on a recorded echo.
- **T8. Jump.** A vessel that is coasting or landed may move its head to any later tick in one step. It is
  rails warp done at once and uses the same checks. It is refused if an atmosphere entry or impact lies in
  the interval, if a hit with a solid passive vessel is predicted in the interval (T10), or if the arrival
  point is within 200 m of a solid vessel. Jumping **to a clock** joins that clock.
- **T9. Advance for a visitor.** A clock that is behind a waiting visitor may be jumped forward to the
  visitor's tick when no member is thrusting or in atmosphere, the interval is clean for every member (T8
  checks), and its pilots accept (T6 idle rule applies). While a visitor waits, the group accepts no further
  visitors, so the wait is bounded by one ready-check.
- **T10. Nothing tunnels through warp.** Before a clock runs faster than 4x, and before any jump, every member
  trajectory is screened analytically against the solid passive vessels in its sphere of influence. A
  predicted miss below the two bounding radii plus 10 m schedules an encounter: the clock drops to 1x 10 s
  before it, both vessels are placed in a bubble, and the pass is integrated with swept contact tests
  (section 5.4). The closest approach to the pilot's selected target is a warp event too (drop to 50x at 60 s,
  1x at 10 s), which is what makes a rendezvous convenient.
- **T11. Lead cap.** A clock may run at most 250 years ahead of the live clock. The cap keeps the ephemeris
  within a stated range and bounds the absurd; precision does not depend on it (section 2.11).
- **T12. Spawn.** A spawn is a pad plus a tick at or after the live clock. The default is the live clock.
  Alternatives offered in the menu: the clock of a friend or of a target (the craft joins that clock), and a
  time-shifted slot when every live pad is busy (section 2.7).
- **T13. Echoes are honest.** Anything not at the viewer's time is drawn as an echo: distinct outline, never
  collidable, labelled with the offset and with the action that would make it reachable ("JUMP +3 d 4 h" or
  "ASK TO SYNC"). Every interaction the brief requires happens between solid vessels.
- **T14. Expiry runs on the wall clock** (section 6.5). It is the only clock all vessels share.

### 2.3 What players at different times see

| The other vessel is | behind my clock | on my clock | ahead of my clock |
|---|---|---|---|
| **passive** | Solid, at its propagated state at my tick. Claimed into my bubble if I come close. | (a passive vessel is on no clock) | Recorded echo along its committed worldline. I can jump to its head or later. |
| **attended** | Projected echo: its current state coasted to my tick, updated as its pilot manoeuvres. Its pilot can jump to me; I cannot go back. | Solid and live. | Recorded echo. I can jump to its clock. |

- **Planets and moons:** each client draws every body at its own clock's tick. Two players at different
  times see different configurations, correctly. The menu draws the live clock.
- **The pad crowd:** everyone who spawned at the default and has not warped is on the live clock and solid to
  everyone else there.
- **After warping:** the people on my clock are live; every passive vessel with head at or before my tick is
  solid; everyone else is an echo with an offset on the nameplate and a dashed map icon.
- **How much history an echo needs.** No clock is ever behind the live clock except one slowed by overload
  (section 3.3), so worldline history older than the live clock minus one hour is deleted. A vessel 30 years
  ahead carries a handful of conic patches plus its burn arcs, sampled at 0.2 Hz and capped at 256 kB per
  vessel (older arcs collapse to a gap in which the echo is not drawn).
- **The map** can show the universe at another clock's tick (read-only), so "where is my friend, in their now"
  has a truthful answer.

### 2.4 Arranging and flying a rendezvous

The planner on the map does this from data the client already has (the census of section 4.5):

1. **Target is passive and not ahead** (a parked ship, an empty station): plan against its conic, warp, arrive.
   T10 drops warp at the approach, T4 claims it. No one's consent is involved.
2. **Target is ahead** (passive with a later head, or attended on a later clock): get to orbit first, then
   jump. Bodies are perturbation-free, so the target's orbit plane does not move; only the phase depends on
   time. The planner therefore offers a **jump that arrives in phase**: among the ticks at or after the
   target's time it picks the first at which the chaser's own coasting orbit puts it at the wanted phase angle
   behind the target (at most one synodic period of the two orbits later). Waiting on the phasing orbit and
   the time jump become one action. A long jump before the approach, never after: a 1 m difference in
   semi-major axis in low orbit is about 160 km after three years (`multiplayer-prior-art.md` fact 3).
3. **Target is attended and behind me:** I ask ("ASK TO SYNC"); its pilot jumps to my clock if coasting (T8),
   or I wait in real time. If the pilot is idle, T6 answers for them.
4. **Target is attended and on my clock:** link (T6), fly the phasing with warp by ready-check or "follow",
   close in; inside join range the server merges both into one bubble.
5. **I arrive ahead of an occupied station:** the station is a projected echo. I request an advance (T9).

The map draws the target's trajectory as committed patches up to its head and predicted patches after it, and
marks which is which. Closest approaches are computed against that function of time, so the planning data is
the simulation's own.

### 2.5 Warp in every situation the brief names

| Situation | What happens |
|---|---|
| Alone on my clock, coasting | Any level up to the altitude ladder and the lead cap. Nothing to ask. |
| Entering warp near a passive vessel | Allowed. Both are on rails; T10 has screened the pair; if they would touch, the clock drops to 1x 10 s before and the pass is integrated. |
| Entering warp inside a bubble shared with another pilot | A proposal (T6). The HUD names who has not agreed. |
| Entering warp while linked at a distance | A proposal; "follow" and the idle rule make the common cases instant. |
| Leaving a shared bubble by warp | Refused with the reason until 2 to 2.5 km apart or consent (T7). Warp cannot be used to step out of a collision that is seconds away. |
| Dropping out of warp near others | Nothing special: the vessel is solid for exactly the vessels at its new tick. A jump that would arrive within 200 m of a solid vessel is refused (T8). |
| During a burn or in atmosphere | Rails warp is not available. Physics warp up to 4x: the server steps four ticks per 1/120 s for that bubble. Alone: free. Shared: by consent. |
| A linked friend is burning | The others drop the link and go ahead; the burner jumps to them afterwards and arrives where their map already showed the projected echo. |
| Sphere-of-influence change | Processed per vessel at the exact crossing tick; a clock's rails advance is clamped to the earliest event of any member. A bubble changes sphere of influence as a unit on its origin's crossing, so two craft a hundred metres apart are never under two gravity models. |
| Server overload | A bubble that cannot hold 120 Hz is moved to its own clock running below 1x. It falls behind and catches up with a jump when it next coasts. No other bubble is affected. Admission control (section 7.4) is meant to keep this rare. |
| Hidden or stalled client | Nothing changes in the universe: the server keeps flying the vessel on its latched controls. The client resyncs when it returns. |

### 2.6 Logout, disconnect and resume

| Step | Rule |
|---|---|
| Socket lost | Controls stay latched for 10 s (a network blip must not ruin a burn). Then throttle goes to zero; SAS keeps its mode. |
| Reconnect within 120 s | The pilot is back in the same vessel on the same clock. |
| Leave flight (explicit), or 120 s without reconnect | The vessel is **detached**. Coasting or landed: it becomes passive at its head. Otherwise the server keeps integrating it, without pacing, until it coasts, lands or is destroyed, and commits the result. No control input is invented: stages are not fired, chutes not opened. The flight menu says what will happen before the player leaves (`frontend-ux.md` 5.16). |
| Detach inside a shared bubble | The vessel stays in the bubble as an unattended member while any other pilot is there. Leaving never removes a vessel from a collision in progress. |
| Resume | The pilot attaches at any clock whose tick is at or after the vessel's head. Default: the live clock if it has passed the head (the lead has decayed to zero and the player is back with the crowd), otherwise a private clock at the head. |
| Waiting for someone behind | A pilot who is ahead can detach and let the vessel wait, passive, until the friend's clock reaches its head, then attach on the friend's clock. Nobody goes back; one side waits or the other jumps. |

### 2.7 Pads and time

A pad is a place at a time. Two rockets on one pad at different ticks cannot touch. The design uses that fact
instead of hiding it:

- Pad state on the **live clock** runs the state machine of `fleet-docking.md` 5.3 (free, reserved, occupied,
  clearing) with wall-clock timers. This is the shared, visible launch complex.
- Twelve pads give 180 to 480 launches per hour (`fleet-docking.md`, computed). A front-page crowd of 5,000
  players launching every 20 to 30 minutes wants 10,000 to 15,000 per hour. Pads, not CPU, are the first
  thing to saturate, by a factor of 20 to 80.
- So when the queue for a live pad is longer than 60 s the menu offers a **time-shifted slot**: "LC-3 now, at
  +5 min". Slots are shared clocks that run at 1x at fixed leads of 5, 10, 15 ... minutes; each has its own
  copy of the pad state. Players in one slot are solid to each other and form their own launch cohort; other
  cohorts are echoes. After reaching orbit anyone can jump forward to anyone ahead. It is the same rule as
  the rest of the time model, not a second lobby.
- Waiting for a launch window is done by choosing the spawn tick, or by rails warp on the pad (the craft
  leaves the live clock and keeps the pad for at most the pad dwell limit in wall time).

### 2.8 Which clock decides what

| Decision | Clock |
|---|---|
| Physics, events, windows, sunlight | The vessel's universe time |
| Expiry, pad dwell, reconnect grace, ready-checks, chat rate limits | Wall clock |
| Default spawn time, menu backdrop | Live clock |

The live clock is a persisted mapping from server up-time to ticks. **It does not advance while the universe
is down.** (Luna Multiplayer's wall-clock-derived time kept running through outages and players asked for the
opposite.) After a restart every clock resumes at its checkpointed tick and the live clock crowd is still one
group. An outage longer than one hour extends every expiry deadline by its length.

### 2.9 Paradoxes and how each is excluded

| Paradox | Exclusion |
|---|---|
| Changing something's past | History before a head is immutable (T1); recorded echoes cannot be touched (T13). |
| Touching a future its pilot has not flown | Projected echoes cannot be touched. |
| Two players at different times take the same passive vessel | One directory orders the claims; the head moves once (T4). |
| Leaving a collision course by warp or by logging out | T7 inside a bubble; T10 before any encounter; the detach rule of 2.6. |
| Appearing inside another vessel | T8 arrival check. |
| A vessel twice, or gone (seen in Luna Multiplayer) | One record per vessel, held by the server; clients never hold authority. |
| Passing through a parked ship at 100,000x | T10 screening and the swept tests of section 5.4. |
| Two rockets on one pad | Pad state per clock (2.7); a spawn is refused while anything unheld is inside the pad's keep-out radius at that tick. |
| A craft launched "in the past" that should have hit a history already committed | **Not resolved, by decision.** Only interactions at heads are physical. Such a craft appears solid in later worlds at its propagated position. It needs a metre-scale coincidence and nobody can witness it. |
| Two passive vessels whose orbits cross | **Not simulated, by decision** (section 10, weakness 7). A passive vessel has no "when" in which to collide. |

### 2.10 Why this is the most fun model that works

- **Nobody can hold anybody back.** Solo players have everything single-player KSP gives, up to 10,000,000x,
  which makes Neptune a 1.6 minute cruise instead of 2.7 hours.
- **The crowd is real where crowds form.** New players spawn on the live clock next to each other; a station
  is a place with one time, and docking there means joining its time, which is what makes it a hub.
- **Meeting is one action.** Jumping forward is free for a coasting ship, the planner makes it arrive in
  phase, and "follow" removes the ready-check between friends.
- **Parked things are for everyone.** A ship or station with nobody aboard is solid at every later time, so
  persistence feels like one world and not like per-player saves.
- **The universe never depends on a client.** The server flies every vessel; a frozen tab, a slow laptop or a
  dropped connection changes nothing for anyone else and cannot rewind a ship (the open Luna Multiplayer
  issues #469, #255 and #251 are exactly that failure).
- **Its costs are stated to the player, not hidden.** A time offset next to every name, echoes that cannot be
  touched, the rule that the one who is behind has to jump, and an occasional short wait when arriving ahead
  of an occupied station. One sentence teaches it: you can touch things only at your own time, and time only
  moves forward.

The alternatives fail the brief outright: one global clock makes the Moon three real days away or lets one
player's warp wreck every burn; subspaces with client authority produce the duplicated and rewound ships the
brief forbids; timeline repair is the "divergent timelines silently merged by teleporting ships" it names.

### 2.11 Representing time

- Canonical universe time is an **integer tick count** (1/120 s) since J2000, carried in a float64. Integers
  are exact to 2^53 ticks, which is 2.4 million years (derived). Equality of times, which T2 depends on, is
  therefore exact at any lead. This replaces `World.utBase + stepsSinceBase` with one number that every
  vessel, clock, patch and message uses.
- `ut` in seconds is `tick / 120`. Its float64 spacing is 0.24 us in 2037, 0.95 us at 250 years of lead and
  15 us at 3,000 years (derived). That error is common to everything evaluated at one tick, so it moves a
  whole scene by millimetres and changes no relative position. Orbit phase uses the tick difference to the
  orbit's own epoch, which is exact.
- Rails warp and jumps land on whole ticks. An event time (a sphere-of-influence crossing, an encounter) is
  kept as a float64 second inside the tick for the hand-over, as v1 does.

---

## 3. Authority and compute split

### 3.1 Principle

The server commits every change of every vessel. The client runs the same code to predict, never to decide.
Three server compute classes do the work:

| Class | Where | Deadline | Work |
|---|---|---|---|
| Real time | Railway simulation workers | 8.3 ms per tick | Bubbles with a pilot |
| Near line | The same workers, low priority | seconds | Finishing detached vessels, fate of debris, bubble checkpoints |
| Batch | Modal, or idle workers | minutes | Warp screening refills, transfer-window grids, incident replays, load-test players, bakes |

### 3.2 Who computes what, by situation

| Situation | Server | Client | Authority |
|---|---|---|---|
| Parked, coasting or landed with nobody aboard | Nothing between events. One Kepler evaluation (0.15 us, measured) when someone asks. End of the worldline computed once. | Propagates the conic for drawing. | Server record |
| Coasting with a pilot, any warp | Advances the clock schedule; fires events (sphere of influence, encounter, target approach). No stepping. | Same schedule, same propagation; plans freely. | Server |
| On the pad, clamps held | Nothing until ignition (held and asleep). | Draws. | Server |
| Ascent, burns, entry, landing (one pilot) | Steps the bubble at 120 Hz: 5 to 14.5 us per step (measured). Sends state at 10 Hz. | Predicts the bubble with the same code, replays on correction. | Server |
| Separated stages and fragments | In the bubble while near; then the reduced tier (0.35 us per 0.5 s step, measured) or a precomputed fate. | Draws from state, then from the conic. | Server |
| Two or more pilots within join range | One bubble, one worker, contact solved there. State at 30 Hz. | Predicts every vessel in the bubble; holds other pilots' last inputs. | Server |
| Soft capture, hard dock, undock, collision damage | Decided in the bubble's step. | Shows them after the server's event. | Server only |
| Touchdown on terrain | Steps with the height authority on the worker (45 us mean, 244 us p99 per step, measured with trivial ground). | Predicts with its own streamed tiles. | Server |
| Detached under thrust or in atmosphere | Integrated without pacing until stable. | (not connected) | Server |
| Maneuver nodes, predicted patches, closest approaches, proximity plot, launch windows | Stores nodes as an opaque blob with the ship. | Computes everything (27 to 140 us per prediction, measured). | None needed |
| Navball, readouts, staging delta-v, body ephemerides, sun visibility | Nothing. | Builds `SimSnapshot` (35 to 42 us, measured). | None needed |
| Hit screening for warp, bubble formation, pad state, expiry | Directory and workers. | Receives results (own conjunction list). | Server |
| Transfer-window grids, the menu's live feed | Computed once, cached for everyone. | Displays. | Server |
| Weak client (low CPU score from calibration) | Also sends the target's closest approaches and heliocentric patch chains. | Skips those computations. | n/a |

What the server deliberately does not do: build `SimSnapshot`, predict patches for display, or compute
readouts. Those cost more per player than stepping the player's vessel (measured), are pure functions of
replicated state, and already run in the browser.

### 3.3 Fidelity and rate tiers

Simulation tiers on the server:

| Tier | Step rate | Applies to | Cost |
|---|---|---|---|
| Rails | none; events only | Coasting or landed-asleep vessels, attended or not | 0 |
| Armed | none; a swept-sphere test at 10 Hz against the other members of its bubble | A vessel inside a bubble that is itself coasting and farther than 200 m plus 2 s of closing speed from every other member | under 0.1 us per second |
| Full | 120 Hz, contact sub-steps at 480 Hz | Thrust, RCS translation, atmosphere, contact, soft capture, anything within the armed margin | 2.6 to 14.5 us per step; 45 us at touchdown |
| Reduced | 2 Hz | Unowned debris in atmosphere outside any bubble | 0.35 us per step |
| Finisher | 120 Hz of sim time, not paced to the wall clock | Detached vessels that are not yet stable | as Full, at low priority |

The Armed tier is a change from v1, where a vessel on rails or asleep inside the bubble is still stepped every
step (audit section 3.3). A coasting vessel is on a Kepler orbit whether or not something is near it; it needs
force integration only when a force acts. A parked station next to an approaching ferry costs nothing until
the last 200 m.

**The bubble frame.** A bubble's origin follows an exact Kepler orbit (its oldest member's conic at formation).
Vessel states are offsets from it; gravity enters as the difference between the acceleration at the vessel and
at the origin (Encke's method, `fleet-docking.md` 4.2). Inside a planet's sphere of influence this changes
nothing measurable. In solar orbit it is what removes the 4 mm/s to 0.12 m/s velocity noise of heliocentric
float64, so docking works at Neptune's distance from the Sun. The same origin is the reference for the wire
format, so nothing sent at high rate is planet-sized.

Send tiers (per receiving client):

| Tier | Who | What | Rate |
|---|---|---|---|
| A1. Own bubble, one pilot | Vessels in my bubble | Exact rigid-body state, applied controls, fast part state | 10 Hz |
| A2. Own bubble, shared | Same, when a second pilot or a contact is possible | Same | 30 Hz |
| B. Visible, same clock | The 8 nearest integrated bubbles within 300 km | Quantised state relative to that bubble's origin, engine and staging events | 10 Hz within 20 km, 2 Hz beyond |
| C. Census | Every object in subscribed spheres of influence | Conic elements, head, clock, owner, expiry; osculating elements at 1 Hz for vessels under thrust | on change |
| D. Directory | Everything else | Paged lists: my ships, roster, stations | on demand |

### 3.4 Server CPU per player

From the audit's per-step costs, weighted by what players do (assumed mixes; the load test replaces them):

| | Normal mix | Launch-heavy mix (front-page day) |
|---|---|---|
| Share of integrated objects: stack ascent 14.5 us / vacuum burn 8 us / proximity and coast 5 us / entry 9 us / touchdown 45 us / stage debris 3 us | 25 / 20 / 35 / 10 / 2 / 8 % | 60 / 10 / 15 / 5 / 1 / 9 % |
| Weighted cost per step | 9.0 us | 11.4 us |
| With 30 % for pair tests, bookkeeping and state capture | 11.7 us | 14.9 us |
| CPU per integrated object per second, measured core | 1.4 ms | 1.8 ms |
| On a cloud vCPU at 2.5x (assumed) | 0.0035 vCPU | 0.0045 vCPU |
| Integrated objects per connected player (as `hosting.md`) | 0.75 | 1.35 |
| Allowance for physics warp (a tenth of pilots at 2 to 4x) | x 1.15 | x 1.15 |
| Simulation per player | 0.0030 vCPU | 0.0069 vCPU |
| Socket and fan-out per player (`hosting.md`: 0.002) and directory share (0.0005) | 0.0025 vCPU | 0.0025 vCPU |
| **Total per connected player** | **0.0055 vCPU** | **0.0094 vCPU** |
| Same with the hosting research's 0.03 vCPU per integrated vessel | 0.025 vCPU | 0.043 vCPU |

Reading:

- On these figures physics is about half of the server's work per player; sockets and fan-out are the other
  half. That is EVE's finding again, and it means the "who integrates" decision moves the bill less than the
  send rates do.
- One worker thread carries about 100 to 125 integrated objects at 50 % load on the derived figure, 33 at
  100 % on the conservative one. Both are estimates until a bot fleet measures a Railway vCPU.
- The outlier is terrain contact: the first seconds of a touchdown cost 45 us per step with p99 at 244 us
  (measured, flat stand-in ground). A worker should not hold more than about 40 simultaneous touchdowns;
  the directory spreads them.

| Concurrent players | vCPU in use, derived (normal / launch-heavy) | vCPU in use, conservative |
|---|---|---|
| 20 | 0.11 / 0.19 | 0.5 / 0.9 |
| 500 | 2.8 / 4.7 | 12.5 / 21.5 |
| 5,000 | 27.7 / 47.1 | 125 / 215 |

### 3.5 Bandwidth per player

Bubble state is sent exact, not quantised: position and velocity as float64 offsets from the bubble origin,
orientation and angular rate as float32, applied controls in 8 bytes. That is 84 bytes per moving vessel
before delta coding. Exactness is chosen over bytes because the client resets its prediction to this state,
and a quantised reset would itself be a correction. Tier B is quantised (about 30 bytes per vessel).

| Player state | Share (normal / launch-heavy) | Downstream |
|---|---|---|
| Coasting, warping or landed | 50 / 15 % | 0.4 kB/s (census changes, clock, heartbeat) |
| Solo integrated flight (A1 plus a few tier-B neighbours) | 30 / 65 % | 2.1 to 2.4 kB/s |
| Shared bubble (A2, about two moving vessels) | 15 / 10 % | 6 kB/s |
| On the pad | 5 / 10 % | 0.3 kB/s |
| **Average** | | **1.75 / 2.25 kB/s** |

- Each figure includes 44 bytes of TCP/IP and WebSocket framing per send; a client gets one coalesced frame
  per send tick, never one frame per message.
- Planning value 2.5 kB/s. At Railway's $0.05 per GB that is $0.33 per player-month.
- Upstream: 30 inputs per second of about 16 bytes while flying, under 0.6 kB/s with framing; ingress is not
  billed.
- Levers if egress dominates the bill: quantise tier A (minus about 35 %), send A1 at 5 Hz (solo prediction
  runs the same code and drifts by rounding only), cap tier B at 4 neighbours.

### 3.6 Why the balance sits here and where it could move

- The measured costs make full server simulation cheap. `hosting.md` section 7 prices the alternative
  (clients integrate solo vessels, the server audits): it saves about $190 a month at 500 players and about
  $100 on a front-page day on that file's conservative figure, and a sixth to a ninth of that on the derived
  one.
- It would need bit-identical results between Chrome and Node, which do not exist today: 15 of 17
  transcendental functions differ in the last bit (measured), so a deterministic math module across about 230
  call sites would come first.
- The protocol is nevertheless "inputs up, state down" and every vessel record carries an `authority` field.
  If the load test showed that a spike cannot be carried, solo integrated flight could be moved to deferred
  verification without changing a message. This proposal does not plan for that; it leaves the door unlocked.
- Work moved **to** the server because computing it once is better than computing it per client: hit
  screening, the census, pad state, the fate of debris, transfer-window grids, the menu feed, and target
  predictions for weak clients.

---

## 4. Protocol

### 4.1 Transport and framing

- **Binary WebSocket** to a gateway on Railway. No provider among the three offers UDP, so WebTransport and
  WebRTC are out (`hosting.md` 3.1). No `permessage-deflate`; large blobs are deflated by the application.
- One WebSocket frame per send tick per client, holding one or more messages: `u8 type, varint length, body`.
  Little-endian. Ticks are float64 integers. Ids on the wire are session-local `u32` handles; the mapping to
  string ids is sent once per object.
- Every high-rate message is **idempotent and latest-wins**: it carries a tick, and a newer one replaces an
  older one. On the gateway, a snapshot still queued when the next is ready is dropped (the socket's buffered
  amount is watched) and the following one is sent as a keyframe. The same messages would survive an
  unreliable transport if a UDP-capable host is ever added.
- TCP stalls are absorbed by prediction: a 200 ms stall is a late correction, not frozen motion.

### 4.2 Session

```
client                                   gateway / directory
  Hello { build, defsHash, protocol, cpuScore }  ->
                                         <- Challenge { nonce, serverId }
  Auth { accountId, signature }          ->            ECDSA P-256 device key (frontend-ux F7)
                                         <- Welcome { session, rulesVersion, liveClock, timeSync, resume? }
  Spawn { vehicleId, site, pad, slot, name }  or  Attach { vesselId, clock? }  ->
                                         <- Spawned / Attached { vesselId, clock }   or  Refused { reason, alternative }
                                         <- ClockState, BubbleEnter, CensusFull ...
```

- `defsHash` and the sim build must match the server's; a mismatch is refused with "a new version is ready".
  A session that is already flying is kept on the old build until it leaves or the server drains.
- Menu visitors hold **no socket**. The menu's live view polls `GET /live.json` (presence, feed, up to 200
  markers of the menu region), regenerated once a second and cacheable for one second at the CDN. Railway
  lists 10,000 connections per service; 50,000 menu viewers must not use them.
- One session per account flies at a time; attaching elsewhere takes the flight over (`takenOver`).

### 4.3 Messages

Client to server:

| Message | Content | Rate |
|---|---|---|
| `Input` | `seq, applyTick, pitch, yaw, roll, translate xyz (i8 each), throttle (u8), sasHoldDir (3 x f32, only in SAS maneuver or target modes)` | 30 Hz while flying |
| `Command` | `cmdId, kind, args`: stage, abort, SAS on/off/mode, RCS, legs, lights, fine control, arm or disarm port, undock, control-from-here, helm request/grant/release, lend policy, transfer start/stop, range-safety abort | on press |
| `Time` | `setRate(index)`, `warpTo(tick)`, `jump(tick or clockId)`, `link(pilot)`, `unlink`, `follow(pilot, on)`, `reply(proposalId, accept)`, `requestAdvance(clockId)` | on press |
| `Target` | `TargetRef` (body, vessel or port) | on change |
| `Subscribe` | census spheres of influence and categories, pads, roster page, worldline of one vessel | on change |
| `Nodes` | opaque blob of the player's maneuver nodes for this ship | on edit, at most 1 Hz |
| `Chat`, `Ping` | | |

Server to client:

| Message | Content | Rate |
|---|---|---|
| `ClockState` | `clockId, tick, anchorWall, rate, untilTick, limitedBy, members, proposals` | on change |
| `BubbleEnter` | bubble id, origin conic, complete state of every vessel (the binary vessel codec, deflated) | on entering or re-forming |
| `BubbleState` | `tick, ackSeq, inputMargin`, then per vessel a field mask and the changed fields | 10 or 30 Hz |
| `BubbleOp` | a structural change at a tick, as an operation both sides execute (section 4.4) | on event |
| `BubbleSlow` | resources and temperatures of parts that changed | 2 Hz |
| `Event` | `SimEvent`s of vessels in tiers A and B, with their tick | on event |
| `FarState` | tier-B vessels: quantised pose and velocity relative to their bubble origin, throttle | 10 or 2 Hz |
| `CensusFull` / `CensusDelta` | per sphere of influence, with a sequence number | on subscribe / on change |
| `Worldline` | committed patches and arc samples of one vessel between two ticks | on request |
| `Conjunctions` | my predicted encounters and proximity warnings | on change |
| `CommandResult` | `cmdId, ok, reason, tick` | per command |
| `Pads`, `Roster`, `Assembly`, `Ships`, `Prompt`, `Feed`, `Chat`, `Notice`, `Pong` | the view models of `frontend-ux.md` section 11 | as listed there |

### 4.4 Snapshots, deltas and structural operations

`BubbleState`, per vessel:

| Field | Encoding | Bytes |
|---|---|---|
| Position and velocity relative to the bubble origin | 6 x float64 | 48 |
| Orientation, angular velocity | 4 x float32, 3 x float32 | 28 |
| Applied controls and flags (SAS mode, RCS, tier) | packed | 8 |
| Per engine: throttle actual, gimbal x and y; RCS levels | `u8`, 2 x `i8`; bit masks | only when changed |

- Delta rule: the base is the previous `BubbleState` sent on this socket. The stream is ordered and reliable,
  so no acknowledgement bookkeeping is needed. A field mask omits what did not change; a vessel in the Armed
  tier sends nothing.
- The worker encodes each bubble **once** per send tick. The gateway forwards the same bytes to every
  subscriber and prepends only the per-client header (`ackSeq`, `inputMargin`). Fan-out cost is a copy.
- Part lists, definitions and local poses are never in a snapshot. They change only through a `BubbleOp`:

| Operation | Arguments | Both sides run |
|---|---|---|
| `split` | vessel, cut joints, ids of the new vessels | `separateVessel` |
| `merge` | base vessel, other vessel, the two ports, roll step | the docking merge (section 5.2) |
| `destroy` | vessel, part keys, cause | `destroyParts` |
| `capture` / `release` | the two ports, soft-capture state | the capture constraint on or off |
| `add` / `remove` | a vessel entering or leaving the bubble, with its complete state on `add` | |
| `rebase` | new origin conic (sphere-of-influence change, long drift) | |
| `replace` | complete state of one vessel | fallback |

  Each operation carries its tick and a short checksum of the result (part count, craft list, mass to 1e-9).
  The client rolls its replica back to that tick, applies the operation with the server's ids, and replays. If
  the checksum differs it asks for `replace`. A staging event costs tens of bytes instead of 4 to 22 kB.

- Slow state (propellant per tank, part temperatures, ablator) goes at 2 Hz. The replica computes it too; the
  server's values overwrite.
- The stateful members of `Vessel.struct` (friction anchors, thermal wake factors, wet flags) move into the
  vessel state (section 8.1) and travel in `BubbleEnter`, `replace` and checkpoints. Without that, a correction
  during touchdown changes where the craft comes to rest (7 to 19 mm, measured).

### 4.5 Census and interest management

- **Census entry** (about 84 bytes): handle, kind, owner handle, body, conic `r0, v0, t0`, `validFromTick` (the
  last manoeuvre), `headTick`, clock id or none, bounding radius, expiry time, flags.
- A client subscribes per sphere of influence and category. The first sync is the relevant set only: own
  ships, the target, everything on my clock within 500 km, stations. The full list of a sphere of influence
  (10,000 objects is 840 kB) is sent when the map asks for it. After that only changes are sent: a coasting
  craft is one entry per manoeuvre.
- **Solid or echo** is decided on the client from the entry and its own clock: passive with `headTick` at or
  before my tick is solid; on my clock is solid; anything else is an echo. A recorded echo whose
  `validFromTick` is at or before my tick is drawn from the entry's conic. One that manoeuvred after my tick
  needs its worldline: fetched for the relevant set (target, hovered, own ships), shown as a count otherwise.
- **Tier B selection** is done by the directory once a second from a coarse spatial hash of attended vessels
  per clock; the gateway receives "bubbles visible to pilot P" and forwards their `FarState` frames.
- **Bubble formation** between attended vessels uses the same hash. Between an attended vessel and passive
  vessels the worker keeps a neighbour list: every 10 s of clock time it evaluates the passive vessels in the
  overlapping altitude shell and keeps those within 250 km; between refreshes it tests only that list. For
  10,000 passive objects that is 0.15 ms of CPU per second per attended vessel (derived from 0.15 us per
  evaluation). This runs only at 1x to 4x; at higher warp T10's analytic screening replaces it.
- Nothing is broadcast per frame. A parked ship costs its owner's census subscribers 84 bytes once.

### 4.6 Prediction and reconciliation

The client's replica is the bubble class itself, fed by the network instead of by the directory.

1. **Clock.** `ClockState` plus the `Ping` time sync give the client the server's tick. The replica runs
   **ahead** of it by half the round-trip time plus two control ticks (66 ms), so that an input stamped with
   the replica's tick arrives before the server steps that tick. `inputMargin` in every `BubbleState` tells
   the client how early its last input was; the client trims its lead toward a margin of one control tick.
2. **Inputs.** Controls are sampled on control ticks (every fourth step, as the v1 pilot cadence) and sent
   with `applyTick`. The server latches them at that tick; an input that arrives late is applied at the next
   control tick and `ackSeq` tells the client which tick it took effect, which triggers a replay.
3. **Correction.** The replica keeps complete vessel states for the last second (a ring of states; one copy
   costs 8 to 9 us for 38 parts, measured). On `BubbleState` for tick `T` it compares its stored state at `T`.
   Within tolerance (1 mm, 1 mm/s, 0.01 degree) nothing happens. Otherwise it restores `T`, overwrites the
   server's fields, and replays to the present with its own stored inputs and the other pilots' last known
   controls. A 100 ms replay is 12 to 20 steps per vessel: 0.1 to 0.5 ms.
4. **Why corrections are rare for a solo pilot.** Client and server run the same code on the same inputs; the
   only divergence is last-bit rounding in transcendental functions (1e-16 relative, measured) and late
   inputs. Corrections cluster where physics is chaotic (contact) and where other pilots act.
5. **Other pilots.** Their vessels are predicted forward from the server's state with the controls the
   snapshot reported. Everything the player can touch is therefore drawn at the same predicted tick, which is
   what docking and bumping need.
6. **Smoothing.** After a replay the visual pose of each vessel keeps an error offset in the bubble frame that
   decays over 150 ms. Physics state is never smoothed. A correction larger than 5 m shows "RESYNCED".
7. **Irreversible actions are not predicted.** Stage, abort, undock, port arming, helm changes and time
   requests show a pending state until `CommandResult` and the `BubbleOp` arrive. The delay is one round trip;
   an engine's spool-up or a separation motor's flash covers it.
8. **Tier B** is interpolated 100 to 150 ms in the past, on top of the analytic bubble origin, so 7.8 km/s of
   orbital motion never enters the interpolation.
9. **Rails.** Client and server evaluate the same conic at the same clock tick. `untilTick` is known in advance,
   so a client never draws a vessel past an event the server will stop at.

### 4.7 Lag in contact and docking

- **One simulation per contact.** Both vessels are in one bubble on one worker and every contact force is
  computed there in one step. There is no client whose view decides a hit, so there is nothing to
  lag-compensate.
- **What each pilot sees.** Both vessels at the same predicted tick. The error is what the other pilot did in
  the last round trip. With docking accelerations of 0.04 to 0.08 m/s^2 and 150 ms of latency that is under
  1 mm and at most 12 mm/s (derived), well inside a capture envelope of 0.2 m and 0.3 m/s.
- **Capture and dock** happen at a server tick. A client may see its ports touch up to one round trip before
  the CAPTURE lamp lights; the docking instrument's numbers come from the replica, the lamps from events.
- **High-speed collisions** are over within one tick. Clients learn the result as a `destroy` operation at
  that tick; both parties get the same event with the same numbers (`collision { otherVesselId, relSpeed,
  partsDestroyed }`).
- **Bad links.** Above 250 ms round trip or 5 % stalled sends for 3 s the HUD shows "UNSTABLE LINK". The
  replica never predicts further than 500 ms ahead; beyond that it holds, and the player sees their own
  inputs lag, never a false world. The server never waits for a client.
- **Simultaneous actions** (two pilots press undock, two craft reach one port) are ordered by arrival at the
  worker within a tick, ties by pilot id. The second gets `CommandResult { ok: false, reason }`.

### 4.8 Reconnect

- The session token allows `Resume` on any gateway. Within the 120 s grace the vessel is still attended.
- On resume the server sends `ClockState`, `BubbleEnter` (complete states) and, per subscribed sphere of
  influence, `CensusDelta` from the client's last sequence number or `CensusFull` if it is too old.
- Backoff on the client: 0.5, 1, 2, 4, 8 s, then every 15 s, with jitter so that a restart does not produce a
  synchronised storm. The gateway admits resumes before new sessions.
- A hidden tab stops the client's frame loop but not the socket. On return the replica is rebuilt from a fresh
  `BubbleEnter`, never fast-forwarded.

### 4.9 Abuse limits

Clients can send only inputs, commands and subscriptions, so forged state is impossible by construction.
What remains is rate: inputs above 60 per second, commands above 20 per second and subscription churn are
dropped at the gateway; account creation is limited per IP address; object spam is bounded by slots and
budgets (section 6.5); automation of inputs cannot be prevented and is not attempted.

---

## 5. Docking, undocking, collisions and damage, end to end

The physical model is the one in `fleet-docking.md` sections 3 and 4 (port types, capture envelope, soft
capture as a compliant constraint, momentum-conserving merge, three impact regimes). This section fixes where
each step runs, what crosses the network, and how time and control behave.

### 5.1 A docking, step by step

| Step | Server | Client | On the wire |
|---|---|---|---|
| 1. Select the target | Adds the target's closest approach to my clock's warp events; sends my conjunction list. | Plans on the map; navball target mode; all relative numbers from float64 state in the target's frame. | `Target`, `Conjunctions` |
| 2. Same time | Jump, link or advance as in 2.4. | Shows the offset and the one action that removes it. | `Time`, `ClockState` |
| 3. Inside join range (1 km + 2 s of closing speed) | The directory puts both vessels in one bubble on one worker. A passive target is claimed (T4); its part state is loaded from its record. It stays in the Armed tier. | Replica receives the target's complete state; from here both are predicted. | `BubbleEnter` or `BubbleOp add` |
| 4. Approach | Steps my vessel at 120 Hz; the target joins the Full tier inside 200 m. State at 30 Hz once a second pilot or a contact is possible. | Docking instrument from the replica (`Readouts.docking`), port camera. | `Input`, `BubbleState` |
| 5. Arm ports | Port state is vessel state. A capture needs both ports armed; arming is the owner's command and persists while the owner is away. | Pending, then shown. | `Command`, `BubbleOp` |
| 6. Faces within 0.10 m | The worker checks the envelope at that tick. Inside: soft capture begins. Outside but slower than the crash tolerance: ordinary contact, the craft bounce, the event names the limit missed. Faster: collision damage. | Predicts the bump as rigid contact. Does not predict capture. | `BubbleOp capture`, `Event dockCapture` or `captureLost` |
| 7. Soft capture | The spring-damper between the two port frames is solved in the bubble's 480 Hz sub-steps with the contact pass. It lets go if clamped for 0.5 s or after 60 s. | Runs the same constraint from the `capture` operation on. | `BubbleState` |
| 8. Hard dock | When offset, angle and relative speed have stayed under 3 mm, 0.1 degree and 3 mm/s for 0.5 s, at a tick boundary: merge. One vessel, linear and angular momentum conserved, craft records appended, a dock link between the two port parts. | Rolls back to that tick, runs the same merge with the server's ids, replays. | `BubbleOp merge`, `Event docked` |
| 9. Commit | The directory replaces two vessel records by one in a single transaction and writes a checkpoint. | "HARD DOCK" lamp; assembly panel. | `Assembly` |

### 5.2 A docked assembly: control, time and ownership

- **One helm.** Only the helm's `Input` messages steer the assembly; inputs from other pilots aboard are
  dropped at the worker and their HUD says who is flying. The helm acts through its own craft and through
  what other craft have lent (`lendAttitude` on by default, `lendEngines` and `lendPropellant` off).
- **Docked free drift.** An arriving craft's engines, thrusters and wheels are inhibited at hard dock.
- **Craft sovereignty.** Each owner's commands for their own craft are always accepted, helm or not: fire
  their own stage stack, abort, arm and release their own ports, pump out of their own tanks, change their
  lend policy. The worker checks `craft.ownerId` against the session on every command.
- **Who is helm.** At dock the base vessel's helm stays (two attended craft: the heavier craft's pilot). The
  anchor craft is the one longest in the assembly, never the heaviest. Its owner may take the helm at any
  time; others request it (`Prompt` to the helm; granted on Y, or automatically after 30 s without helm input).
  If the helm's socket drops, the helm is vacant at once and throttle goes to zero.
- **One vessel, one clock.** Every pilot aboard is a member of the assembly's clock. Warp is a proposal by
  the helm (T6); "follow" and the idle rule answer for passengers who do not care. A passenger who does not
  want to come along undocks.
- **Either side can always let go.** A port is released by the owner of the craft it belongs to.
- **Nobody aboard:** the assembly is passive, costs nothing, and is solid for every later visitor.
- **Limits:** 32 craft and 600 parts per assembly (a capture that would exceed them is refused with a
  message), 64 vessels per bubble.

### 5.3 Undocking

1. The port's owner sends `Command undock` (or a stage action does). Pending in the HUD.
2. At a tick the worker removes the link, splits the craft forest into its connected components with
   `separateVessel` (momentum exact by construction), and applies the spring impulse equal and opposite at the
   port point (600 N s for a crew port: about 5 cm/s for a ferry). Both ports enter cooldown and the pair is
   marked nascent so that their overlapping colliders do not fight (5.4).
3. `BubbleOp split` with the new vessel ids; both replicas run the same split.
4. Each piece gets its helm: the piece with the old helm's craft keeps it; every other piece gets its own
   connected owner, or none. Throttle is zero on every piece without the old helm.
5. All pieces stay in one bubble on one clock until they drift past twice the join range. From then on each
   pilot may leave the clock (T7). Pieces without a pilot become passive when the bubble dissolves.
6. The directory replaces one record by several in one transaction.

### 5.4 Collisions

Detection has to cover every pair that can exist at one time, and no others:

| Pair | Mechanism | Where |
|---|---|---|
| Two attended vessels on one clock | Coarse spatial hash per clock at 1 Hz; inside join range they share a bubble; there, swept bounding spheres every step, speculative contacts for slow pairs, conservative advancement (time of impact) for fast pairs | directory, then worker |
| Attended vessel at 1x to 4x against passive vessels | Neighbour list (4.5); a passive vessel inside join range is claimed into the bubble | worker |
| Attended vessel on rails warp or jumping, against passive vessels | Analytic screening (T10): overlap of altitude shells, minimum distance between the two conics below radii plus 10 m, then the times both are at that point. A hit becomes an encounter event that forces 1x and a bubble | directory helper threads |
| Vessels on different clocks, or an attended vessel and a passive one whose head is later | No pair: they are not at the same time (T2) | - |
| Two passive vessels | Not simulated (2.9) | - |

- At 15.6 km/s a craft moves 130 m per step. The bubble's fast-pair path finds the first time two part
  colliders touch within the step; nothing is skipped by step size, and physics warp runs more steps, never
  longer ones.
- **Born overlapping.** Vessels created by one split, and a pair that has just undocked, ignore each other
  until their colliders have first been 5 cm apart. Without this every stage separation of the existing stack
  would wreck it (the envelopes overlap for 0.01 to 0.39 s, measured in the sim-vessel hand-off).

Response, by normal closing speed at first contact (`fleet-docking.md` 4.5):

| Regime | Condition | Outcome |
|---|---|---|
| Contact | Energy below both parts' tolerance | Impulses and friction only |
| Crash | Tolerance exceeded, below about 250 m/s | Overloaded parts destroyed; joints over their g limit break; pieces separate |
| Hypervelocity | Above about 250 m/s | No rigid solve: the energy rule of the NASA standard breakup model removes mass around the impact point |

- **Damage model:** a part is intact or destroyed; a joint is intact or broken. There are no health values.
- **Authority:** the worker's step decides. Clients receive `destroy` and `split` operations and one
  `collision` event with the other vessel, the relative speed and the parts lost. Both parties see the same
  numbers. A client never shows damage first.
- **Explosions** reach other vessels in the bubble (150 N s per kg of propellant, area-weighted, capped).
- **Debris:** surviving connected pieces are ordinary vessels owned by nobody new (the craft record keeps its
  owner for attribution and budgets). At most 12 new vessels per collision; fragments under 50 kg live 60 s.
- **Range safety** near pads is a server decision shown as such (`fleet-docking.md` 5.4).
- **Crashing into parked ships is allowed.** A passive ship is solid; ramming it is a real collision with real
  damage, written to its record. Owners see it in the feed and on My Ships.

---

## 6. Persistence

### 6.1 What is stored

Postgres on Railway, reached over the private network, written only by the directory.

| Table | Key | Content |
|---|---|---|
| `account` | id | callsign, created, last seen (wall), settings blob, recovery hash |
| `credential` | account, key | kind (`deviceKey` today), public key, label. Other sign-ins are more rows later; ships belong to the account |
| `craft` | craft id | owner account or none, vehicle id, name, vessel it is part of, created, abandoned flag |
| `vessel` | vessel id | kind (`rails`, `landed`, `hot`), body, conic (7 numbers) or surface pose, head tick, end of worldline (tick, kind), bounding radius, mass, part count, clock and bubble if hot, expiry (wall), `state` (binary vessel codec, deflated: about 7 kB for the 38-part stack, estimated from the measured 22.4 kB of JSON), row version |
| `worldline` | vessel, sequence | committed patches after the live clock: body, conic, start and end tick, end reason |
| `track` | vessel, start tick | sampled integrated arcs for recorded echoes (0.2 Hz, capped at 256 kB per vessel) |
| `clock` | clock id | kind (live, slot, private, group), tick, rate, members |
| `bubble_checkpoint` | bubble id | tick, clock, origin conic, complete state of every member; the latest two are kept |
| `input_journal` | bubble, sequence | every input and command applied since the latest checkpoint, with its tick |
| `journal` | sequence | every committed directory event (spawn, hand-over to rails, claim, dock, undock, destruction, expiry, ownership or policy change): audit trail, feed source |
| `pad` | clock slot, site, pad | state, craft, until (wall) |
| `nodes` | craft | the owner's maneuver nodes, opaque |
| `rules` | version | the `UniverseRules` document and when it took effect |

- A dormant ship is one `vessel` row plus one `craft` row per craft. In the directory's memory it is about
  200 bytes (conic, head, ids, radius); the part state stays in Postgres until someone claims or attaches.
  One hundred thousand parked ships are about 20 MB of memory and under 1 GB of table.
- An assembly is one `vessel` row whose state holds `crafts[]`, parts tagged with their craft, and `links[]`.
  That is all "persistent docked assemblies" needs.
- The codec is new (section 8.1): definitions by id, non-finite numbers and negative zero preserved, the
  former `struct` state included. Coasting and asleep vessels already round-trip exactly (measured).

### 6.2 Write path

1. Every state change of the universe is a **directory event** with a sequence number. The directory applies
   it in memory and appends it to a write-behind queue.
2. Every 250 ms the queue is written in one transaction: `journal` rows plus the upserts and deletes of the
   affected `vessel`, `craft`, `worldline`, `clock` and `pad` rows. Docking and undocking replace records in
   the same transaction, so there is never a moment with a ship stored twice or not at all.
3. A worker makes its bubbles durable in two parts: a **checkpoint** (complete state) every 60 s and at every
   structural operation, and the **input journal** in between. Both ride the same 250 ms batches.
4. Why inputs are enough: within one runtime and build the sim is bit-reproducible (measured: identical
   hashes over a 200 s ascent with staging). Checkpoint plus inputs reproduces the bubble exactly. The
   journal costs about 0.25 to 0.4 kB/s per piloted bubble (derived: 0.12 kB/s of checkpoints, the rest
   inputs coded on change), against 22 kB of JSON per vessel for every naive state dump.
5. Volume: about 70 kB/s at 500 players, about 1.3 MB/s on a 5,000-player launch-heavy day. `input_journal`
   is partitioned by hour and partitions are dropped, never vacuumed.
6. Copies: Railway volume backups daily; a logical dump and a universe snapshot to the bucket every 6 h (a
   different storage system); optionally the same object to a Modal volume nightly.
7. A fallback switch turns the input journal off: checkpoints every 10 s, at most 10 s lost on a crash.

### 6.3 Restart recovery

A deploy of any simulation role is a restart, so this is the normal path, not the emergency path.

| Phase | Graceful (deploy, SIGTERM, 30 s drain) | Crash |
|---|---|---|
| Stop | `Notice restart` to clients. All clocks freeze at a tick boundary. Workers write final checkpoints. The directory flushes and exits. | Nothing. |
| Load | The directory reads rules, clocks, pads and the index columns of every vessel (seconds for 100,000 rows); rebuilds the per-body passive index. | Same. |
| Bubbles | Restored from the final checkpoints. | Restored from the latest checkpoint, then the input journal is replayed un-paced (60 s of flight is 7,200 steps: about 0.2 s of CPU per vessel, derived). |
| Clocks | Resume at the checkpointed tick. The live clock did not advance during the outage (2.8). | Same; at most 250 ms of flight is lost. |
| Pilots | Clients reconnect with jittered backoff and `Resume`; the 120 s grace starts when the universe is back. | Same. |
| Result | Nothing lost; "Universe restarting, your ships are saved, back in about 40 s". | Up to 250 ms rolled back; clients reconcile through the normal correction path. |

- The Node version of the simulation image is pinned. Replays are valid only for the build that wrote the
  journal, so a deploy that changes the build always takes the graceful path (final checkpoints, no replay).
- A single worker dying is the same recovery for its bubbles on other workers; pilots see a stall of a few
  seconds while their replicas keep predicting, then a correction.
- Simulation, gateway, API and shell are separate services with watch paths. A front-end push never restarts
  the universe.

### 6.4 What a player's ship goes through

Spawn (record created) -> attended in a bubble (checkpoint and journal) -> coasting (record with conic) ->
pilot leaves (passive record) -> claimed or resumed (state loaded) -> docked (records merged) -> expiry or
destruction (records deleted, `journal` keeps the event).

### 6.5 Expiry and cleanup

All lifetimes run on the **wall clock**, are fields of `UniverseRules`, and are visible: every census entry
carries its removal time, My Ships shows a countdown and the reason, the rules screen lists the table below.

| Object | Lifetime | What resets or protects it |
|---|---|---|
| A craft with a command part and an owner | 14 days after the owner's last session | Any session of the owner refreshes all of the owner's craft |
| Ship slots | 10 craft per account; an eleventh launch asks which to abandon | - |
| A craft in an assembly | Kept while any craft in the assembly is unexpired | Docking: the assembly lives as long as its most recently active owner. A craft whose own owner has lapsed becomes unowned; the anchor's owner may release it |
| An abandoned craft (owner chose Abandon, or lapsed and undocked) | 48 hours as unowned, then removed | Nobody can re-own it |
| Debris (no command part) in orbit | 2 hours after it leaves every bubble | Per-owner budget of 24 pieces; the oldest go first |
| Fragments under 50 kg | 60 s | - |
| Debris or detached craft on a path into atmosphere or ground | Resolved at once by a finisher and removed or left as a landed wreck (wreck: 2 hours) | - |
| A vessel on a pad | 300 s, one 120 s extension with engines running; 60 s after a disconnect | Roll-back to the hangar, not expiry |
| Anything inside a pad's keep-out radius at rest | 60 s | - |
| A vessel escaping the Sun beyond 100 AU | Removed on crossing | - |
| Per sphere of influence | At most 5,000 unowned objects; the oldest go first | - |
| A callsign with no ships and no session | 90 days | - |

- Removal deletes the vessel at every universe time at once. It is an out-of-fiction act ("recovered by the
  range") and is shown as such.
- "Activity" means a session: connecting refreshes everything the account owns. Tying it to flying each ship
  would make players tour their fleet to keep it.
- Growth bound: objects are at most accounts seen in 14 days times 10, plus the unowned caps.

---

## 7. Server topology on Railway, Modal and Netlify

### 7.1 Roles

One Node program with four roles, selected by configuration. The roles talk through one message schema; the
transport is a `MessagePort` inside one process and a length-prefixed TCP stream on Railway's private network.

| Role | Count | Does | Does not |
|---|---|---|---|
| **Gateway** | N replicas, stateless | Sockets, authentication, per-client subscriptions, forwarding bubble frames and census, input routing to the right worker, backpressure | Physics, decisions |
| **Directory** | 1 | Single writer of the universe: records, clocks, pads, claims, bubble membership and worker assignment, warp screening (helper threads), expiry, persistence, admission | Stepping |
| **Worker** | one isolate per core | Steps bubbles, runs finishers, holds the height authority and its tile cache, encodes bubble frames, journals inputs | Anything about vessels it does not hold |
| **API** | 2 replicas, stateless | HTTP: account creation and recovery, lobby list, rules, `live.json`, public status, presigned pack list | Sockets |

- A worker is one isolate because `src/sim` keeps module-level scratch state (audit 3.1). Vessels move
  between workers by value, as codec bytes, at a tick boundary: the old worker freezes the bubble, the new one
  resumes it, the gateway re-points the subscription, clients keep predicting through the 5 to 20 ms gap.
- Two bubbles that approach each other on different workers are merged by moving one of them first.
- Each simulation shard is **its own Railway service** (`sim-1` ... `sim-K`), because replicas of one service
  cannot be addressed individually and are not sticky (`hosting.md` 3.1). Gateways connect to every shard and
  to the directory by private DNS name. Clients never learn which shard holds them, so a bubble can move
  without a reconnect.

### 7.2 Deployment stages (same code)

| Stage | Railway services | Holds (conservative to derived) |
|---|---|---|
| A. Quiet and development | `universe` (gateway + directory + up to 20 worker threads in one 24-vCPU replica, billed on use), `api`, `postgres`, `edge` (pack mirror and, without Netlify, the shell), bucket | about 550 to 2,000 players |
| B. Announced launch | `gateway` x 3 replicas, `directory`, `sim-1..K` (22 worker threads each), `api` x 2, `postgres`, `edge`, bucket | per shard about 540 to 1,600 launch-heavy players; K = 4 to 10 for 5,000 |
| C. Beyond | A second gateway service (10,000 connections per service), directory helpers on their own service, a second lobby as a second copy of the stack | 10,000+ |

Railway has no autoscaler. Stage B is entered by a script against the Railway API before an announcement;
idle shards cost only their memory because CPU is billed on use. Modal can host overflow workers (they dial
out to the directory) at about three times the CPU price, with a 24 h container limit; that is a fallback for
a spike that outruns pre-scaling, not something to build first.

Other placements, as `hosting.md` recommends:

- **Shell:** Netlify Pro with auto-recharge if the user provides a team and token; otherwise a Railway static
  service. The shell sends the COOP and COEP headers.
- **Tiles, sky and assets:** packed, on a Railway bucket through presigned URLs, with the `edge` service and
  its CDN as the mirror. Workers read the height packs (9.65 GB) by range from the bucket into an LRU on
  ephemeral disk.
- **Modal:** load-test players, transfer-window grids, incident replays, bakes, the nightly off-site copy.
- **Region:** one, US East. Europe sees roughly 90 to 120 ms of round trip, Asia and Australia about 250 ms.

### 7.3 Capacity, bottlenecks and scaling path

Bottlenecks in the order they bind:

| # | Bottleneck | Limit | Scaling step |
|---|---|---|---|
| 1 | Launch pads | 180 to 480 launches per hour on 12 pads against 10,000+ wanted on a front-page day | Time-shifted slots (2.7); more pads are data |
| 2 | Worker threads per replica | 22 threads on 24 vCPU: 700 (conservative) to 2,100 (derived) integrated objects per shard | More `sim-K` services (Pro allows 100 services) |
| 3 | Sockets | 10,000 connections per service; about 250 to 500 connections per gateway vCPU | More gateway replicas, then a second gateway service; a leaner WebSocket library is the cheap lever |
| 4 | Egress | $0.33 per player-month at 2.5 kB/s | Quantise tier A, lower A1 to 5 Hz, cap tier B |
| 5 | One crowded bubble | A bubble is single-threaded; 64 vessels, 600 parts per assembly | Per-bubble time dilation; caps |
| 6 | Directory | One thread for events (about 1,000 per second at 5,000 players, a few percent of a core, estimated) plus warp screening (about 1 to 2 cores of helper threads at 5,000 players with 10,000 passive objects in one shell, estimated, not measured) | Screening index by orbital shell; helpers on their own service; a directory per planetary system |
| 7 | Terrain on workers | Touchdown at 45 us per step, first-touch tile reads up to 0.2 ms | Route landings to workers with that region warm; spread touchdowns |
| 8 | Postgres writes | 250 ms batches; 1.3 MB/s of journal on the heaviest day | Hourly partitions; checkpoint-only mode |

Admission control: the directory admits a pilot only while the fleet's measured tick time leaves headroom
(p99 step time under 6 ms of the 8.3 ms tick). Beyond that players queue in the menu and can spectate.

### 7.4 Monthly cost

List prices from `hosting.md` (Railway: $20 per vCPU-month, $10 per GB-month, $0.05 per GB egress). "Derived"
uses section 3.4; "conservative" uses the hosting research's 0.03 vCPU per integrated vessel. Both hold the
stated concurrency for the whole month.

| Line | 20 players | 500 players | 5,000 players |
|---|---|---|---|
| Simulation, gateway and directory CPU (derived / conservative) | $8 / $16 | $65 / $260 | $575 / $2,520 |
| Memory | $15 (1.5 GB) | $60 (6 GB) | $260 (26 GB) |
| Postgres, volume, backups | $8 | $46 | $120 |
| WebSocket egress at 2.5 kB/s | $6 | $162 | $1,620 |
| Bucket, `edge` mirror | $3 | $15 | $30 |
| Shell (Netlify Pro; at 5,000 a Railway static service is cheaper) | $20 | about $80 | $135 to $360 |
| Modal | $0 | $0 to $30 | $30 |
| **Total (derived / conservative)** | **about $60 / $70** | **about $430-460 / $625-655** | **about $2,800-3,000 / $4,700-5,000** |

A front-page day (5,000 concurrent for 24 hours, launch-heavy, on top of a quiet month): CPU $31 derived or
$143 conservative, memory $9, egress $49 to $65, the rest about $20: **about $105 to $140, or $215 to $255
on the conservative figure**. Tile egress is $0 on the bucket path and up to $750 if that path fails and
tiles fall back to a billed Railway service (`hosting.md`). A one-hour 5,000-bot rehearsal costs about $13 on
Modal plus about $9 on Railway.

These are estimates. The honest statement of capacity is the load-test report of section 9.5.

---

## 8. What changes in place

Nothing below is a parallel system beside v1. Each row changes an existing module so that one code path
serves single-player tests, the client replica and the server.

### 8.1 Simulation (`src/sim`)

| Module | Change |
|---|---|
| `world/sim.ts` (`World`, 2,531 lines) | Split along its real seams. **`Bubble`**: N vessels, one tick, per-vessel controls by pilot, local origin, tiers, the landed/rails/integrated state machine per vessel, contact pass. **`ClockSchedule`**: the warp ladder, event clamping and look-ahead from `orbit/warp.ts`, per clock. **`Directory`**: records, passive index, claims, pads, screening. **View builders** (readouts, navball, staging info, patches, markers, burn bookkeeping) move to `src/sim/view` and run on the client. The single `active`, `controls`, `warpIndex`, the 25 km bubble about the active vessel, `MAX_DEBRIS = 24`, mission failure and the O(n) loop over all entries go away. |
| `dynamics/integrator.ts` | `stepVessel` becomes `stepBubble`: advance a group sub-step by sub-step so that pair forces act in the same sub-step. A group of one produces the same numbers as today. Optional local origin in `VesselEnvironment` (Encke). Vessels that need no force are not stepped (Armed tier). |
| `vessel/types.ts`, `assemble.ts`, `split.ts`, `staging.ts`, `structure.ts` | `crafts[]`, `links[]`, `helm`, part keys `craftId/instanceId`, server-assigned craft ids, stage stack per craft, flow groups per craft, momentum-conserving merge, split over links (`fleet-docking.md` 2.7). The stateful members of `struct` (friction anchors, wake factors, wet flags) become vessel state. |
| `vessel/codec.ts` (new file in the existing package) | Binary, exact: definitions by id, non-finite and negative zero preserved. Used by persistence, bubble hand-over, `BubbleEnter` and the replica's rollback ring. `stateHash.ts` hashes the codec output. |
| `vessel/clearance.ts`, `dynamics/contact.ts`, `failure.ts` | Collider library with contact points and normals; bubble contact pass; capture constraint; swept tests; explosions and damage reach other vessels; born-overlapping rule. |
| `orbit/*` | Horizon per patch (the 60-day defect); vessel-against-vessel closest approach; conic-against-conic screening; warp levels 1e6 and 1e7; jump planning. |
| `bodies/*` | Sun as root attractor; small-moon sphere-of-influence rule; element rates (`solar-system.md` section 7). |
| `world/milestones.ts` | Unchanged; attached to one craft as an optional objective list. |

### 8.2 Contracts (`src/core/contracts`)

| Contract | Change |
|---|---|
| `sim.ts` `SimSnapshot` | Stays the presentation contract, now produced on the client. `activeVesselId` nullable (menu, spectate). `warp` is filled from the player's clock; a `time: TimeView` block is added (`frontend-ux.md` 7.6: relation is `synced`, `ahead` or `behind`; `syncAction` is a jump). `VesselSnapshot` gains `crafts`, `links`, `presence: 'solid' \| 'recordedEcho' \| 'projectedEcho'`, `timeOffset`. Positions are stated as relative to the frame body of the focus (same axes), not to "the root body (Earth)". `scenario`, `mission`, `milestones`, `cheatCounter` become optional. New events: `dockCapture`, `docked`, `captureLost`, `undocked`, `collision`, `controlTransferred`, `commandResult`. |
| `sim.ts` `Sim` | Replaced by two interfaces. **`SimView`** (what `src/app`, pilots and tests hold): `advance(realDt)`, `snapshot()`, `peek()`, `setControls()`, `commands`. **`UniverseHost`** (server side): spawn, attach, detach, route input, time requests. `createSim(defs, scenarioId)` remains and returns a `SimView` over an in-process universe (8.4). |
| `controls.ts` | `CommandResult` gains `pending` and an id; the outcome arrives as an event. `addNode`, `setNode`, `removeNode`, `setNavballMode` stay synchronous and local. `setTarget(TargetRef)`. `setWarpLevel` becomes a time request. `cycleActiveVessel` becomes "attach to another craft of mine in this bubble". New: port arming, undock, control-from-here, helm, lend policy, transfer, link, follow, jump. `NavballMode` gains `target`; `SasMode` gains `target`, `antiTarget`, `portAlign`. |
| `defs.ts` | `WARP_LEVELS` gains two levels; altitude limits default from the radius; `dockingPort` module, colliders, pads per site, Sun-rooted bodies; `ScenarioDef` becomes a spawn recipe plus optional objectives. |
| New `net.ts` | Message schema, `UniverseRules`, `ClockState`, census entry, the view models of `frontend-ux.md` section 10 item 15. Shared by client, server and bots. |

### 8.3 Client and server packages

| Package | Change |
|---|---|
| `src/net` (new) | Transport, framing, session, time sync, a latency and stall injector for tests. |
| `src/replica` (new) | `UniverseClient implements SimView`: bubble replica with prediction and rollback, census store, clock, echo classification, view builders. |
| `src/app` | Written once against `SimView` (it is still a shell). Menu, spectate and flight differ only in what the replica is attached to. |
| `src/map`, `src/ui`, `src/render/*`, `src/audio`, `src/camera`, `src/input` | Keep reading `SimSnapshot`. Additions as in `frontend-ux.md`: census layer, target and docking readouts, time strip, nameplates, pending states. Keys by `craftId/instanceId`. |
| `src/pilot` | The scripted pilot drives a `SimView`, so the same pilot is the mission test, the calibration run and the load-test bot. |
| `server/` (new, same repository) | Gateway, directory, worker, persistence, API. Imports `src/sim`, `src/core`, `src/terrain`, `src/net`. |
| `src/terrain` | A ranged-pack tile source beside the fs source, for workers and for the production client. |

Order that keeps rework low (extends the audit's): ids, crafts, links and the codec; Sun-rooted bodies and the
focus-body frame; `Bubble`, `ClockSchedule`, `Directory` and the in-process universe with the mission test
green again; network, replica and one remote client; contact and docking; shards.

### 8.4 Single-player-style flying in the same architecture

- **In the live game** the Earth-Moon-return flight is an ordinary session. Spawn `meridian-lunar` on a pad on
  the live clock. Ascent: the worker steps the stack, the replica predicts. Coast: private warp, the craft
  leaves the live clock. Translunar injection, lunar orbit insertion, descent: bubbles of one; the worker
  holding the landing has the Moon region's height tiles. Return, entry with heating, parachutes, splashdown:
  the same. No other player can slow, block or touch the flight unless they are at the same time and place.
  The milestone list of `lunar-direct` is attached to the craft as objectives and evaluated on the server.
- **Headless mission tests** call `createSim(defs, 'lunar-direct')`, which builds a directory, one worker and a
  replica in one process over a loopback transport with zero latency, and exposes the replica as `SimView`.
  `step()`, `advanceRails()`, `peek()` and `stateHash()` keep their meaning (the hash is the server-side
  bubble's). The golden hash is re-baselined once, after the Sun re-root and the id change, as the audit
  already requires.
- **The same mission through a real socket** (bot client, local server) is the first end-to-end multiplayer
  test and the template for load-test players.
- **Calibration benchmark and labs** use the in-process universe; nothing is sent anywhere. Debug mutators and
  `cheatCounter` exist only there.

---

## 9. Verification plan

### 9.1 Headless, deterministic (vitest)

- Codec: round trip of stepped vessels in every regime is exact, including a lander mid-touchdown (the case
  that diverges 7 to 19 mm today) and a capsule in entry (part temperatures).
- `stepBubble` with one vessel equals `stepVessel` bit for bit; the lunar mission passes through the in-process
  universe with zero incomplete terrain queries.
- Merge then undock restores every part pose and conserves linear and angular momentum to 1e-9; a ring of
  three links; staging from inside an assembly.
- Two craft closing at 15.6 km/s at every phase of the step never pass through each other; every stage
  separation of the existing stack survives with contact on; capture succeeds just inside and fails just
  outside each envelope limit; a dock at 30 AU from the Sun keeps relative speed noise under 1 mm/s.
- Time rules: each of T1 to T14 as a test, including two claims on one passive vessel from different clocks, a
  refused jump (entry in the interval, arrival too close), warp refused inside a shared bubble, the idle
  rule, a time-shifted pad slot, and a hit found by screening at 100,000x and at 10,000,000x.
- Replay: checkpoint plus input journal reproduces the bubble's hash.

### 9.2 Separate real clients, with latency

A local server (all roles) and clients behind the injector of `src/net` (fixed delay, jitter, stalls that
imitate TCP loss). Matrix: 0, 50, 150 and 300 ms round trip; 0 and 5 % stalled sends.

| Scenario | Clients | Passes when |
|---|---|---|
| Concurrent launches from six pads | 6 scripted pilots | All reach orbit; no cross-pad interference without contact; pad states cycle; a seventh is queued or offered a slot |
| Rendezvous and docking | 2 scripted pilots, one launching to the other | Hard dock within the envelope; both clients report the same port offsets to 1 mm at the event tick; momentum conserved |
| Control sharing | 2 | Hand-over prompt round trip; non-helm inputs have no effect; passenger stages its own craft; undock from each side |
| Collision | 2 | Low-speed bump, crash and hypervelocity cases; both clients show the same event numbers; no client shows damage before the event |
| Warp | 2 to 3 | Private warp leaves the others untouched; proposal, follow, refusal with reason; jump in phase to a station; advance for a visitor; echoes never collide |
| Disconnect and reconnect | 2 | Drop mid-burn (controls latched 10 s, then throttle zero), mid-docking and mid-warp; resume within grace; detach after grace with the finisher's outcome |
| Prediction quality | 1 | Count and size of corrections in ascent, entry and touchdown per latency; no visible correction in solo flight at 150 ms |

The same matrix runs in **two real Chrome windows** (Playwright, two contexts, real GPU) against the local
server for the cases a human would judge by eye: docking, collision, warp strip states, reconnect banners.
Screenshots from both clients at the same tick are compared for vessel poses.

### 9.3 Restart, recovery and expiry

- Graceful restart during an ascent, a docking approach and with a three-craft assembly parked: every vessel
  identical by hash afterwards; clients resume.
- `SIGKILL` of a worker and of the directory under the same load: recovery by replay; measured loss of at
  most 250 ms; no ship duplicated or missing (record counts and craft ids checked).
- Expiry with an injected wall clock: each row of 6.5, including an assembly kept alive by one active owner
  and released when that owner lapses; the countdown shown to the client matches the removal.

### 9.4 Whole flights

- The Earth-Moon-return mission by the scripted pilot through a real socket at 150 ms.
- An interplanetary flight into orbit: `meridian-albatross` to a Mars capture ellipse using warp up to
  100,000x, and a Neptune arrival at 10,000,000x to prove the event clamps at the top level.

### 9.5 Load test with simulated active players

- **Bots** are the real replica and the scripted pilot in headless Node on Modal (about 50 per container),
  connecting to a stage B deployment on Railway. Each bot does what a player does: spawn, fly a real ascent
  with staging, circularise, warp, a share of them rendezvous and dock with a parked station, a share
  re-enter. Idle connections and HTTP requests do not count.
- **Ramps:** 50, 200, 500, 1,000, 2,000, 5,000 concurrent, each held for 15 minutes; then a two-hour soak at
  the highest level that held; then a reconnect storm (every gateway restarted at once) and a deploy of the
  simulation under load.
- **Measured and published** (on the rules screen and in the repository): step time p50, p99 and maximum per
  worker; integrated objects per worker thread at the admission threshold; bubbles that were dilated;
  CPU per connection on the gateway; bytes per second per player by state; directory events per second and
  screening time; Postgres batch latency; correction rate seen by bots; players per shard at which admission
  control starts to queue.
- The report replaces every assumed number in sections 3.4, 3.5 and 7. If a level fails, the report says so
  and gives the limit that held.

---

## 10. Honest weaknesses

1. **Capacity is not measured.** The audit measured one fast desktop core. Cloud vCPU speed, real-terrain
   contact under load and memory per live vessel are unknown. The derived and conservative figures differ by a
   factor of 4.5; the design has to be provisioned for the conservative one until the load test says otherwise.
2. **Every attended vessel has a real-time deadline on the server.** A spike beyond provisioned shards cannot
   be absorbed by players' machines. The valves are admission queues and per-bubble time dilation, and both
   are things players notice. Railway has no autoscaler; pre-scaling is a script and a human decision.
3. **The client is not thin.** It still runs the full sim for its bubble. Server simulation removes trust in
   the client, not the client's CPU work. A weak CPU gets worse prediction, not a lighter game.
4. **Irreversible actions wait one round trip.** Staging, undocking and port arming take 50 to 150 ms to show
   in North America and Europe and about 250 ms in Asia and Australia. Throttle and attitude are predicted,
   but a late stage press under a tight burn will be felt.
5. **Client and server are not bit-identical.** Corrections are tiny in free flight but can be visible in
   chaotic contact (a touchdown on slopes, a pile-up). Replicating the friction anchors reduces it; it does
   not remove it. Touchdown is also the most expensive regime on the server.
6. **The server needs terrain.** 9.65 GB of height packs, a cache per worker, and stalls on first touch in a
   new region. Landings on bodies added later grow this.
7. **The time model has costs that cannot be designed away.** Whatever is touched at a later time is out of
   reach from earlier times until a jump. A popular station gets pulled ahead by whoever docks from far in
   the future. Two passive vessels never collide with each other. A craft launched earlier does not collide
   with histories already committed. Time-shifted launch slots split a front-page crowd into cohorts that see
   each other as echoes until they sync.
8. **Griefing surface.** Withholding warp consent inside a shared bubble (escape costs a 2 km burn), ramming
   parked ships (allowed by the brief, and will annoy), parking debris at a station. Budgets and expiry bound
   the volume, not the intent.
9. **The directory is a single writer and a single point of failure.** Its crash freezes the universe for
   the recovery time (tens of seconds). Warp screening against a crowded low-orbit shell is the least
   understood cost in the design; the 1 to 2 cores quoted are an estimate.
10. **Moving parts.** Bubbles migrate and merge across workers; replay is tied to a pinned Node build; the
    gateway tier, the journal and the shard script all have to work before a front-page day. A design in
    which clients integrate solo flight would have fewer server parts and a harder trust problem.
11. **WebSocket over TCP only.** A lost packet delays everything behind it. Prediction hides it up to 500 ms;
    beyond that the player's own controls lag.
12. **Egress is the largest steady cost** and exact 30 Hz state in shared bubbles is the generous choice. It
    may have to be quantised.
13. **Leaving mid-flight is harsh.** The server does not invent inputs: a capsule left in entry without
    parachutes armed is lost. It is honest and it will surprise people; the leave screen has to say it.
14. **One region.** Players far from US East fly with a quarter second of latency, and a second region would
    be a second universe.

---

## 11. Answers this design gives to the open questions of `frontend-ux.md` section 15

| # | Question | Answer here |
|---|---|---|
| 1 | Time model states | `synced` (on the live clock), `ahead` (lead shown), `behind` (dilated). `syncAction` is a jump to a clock. Groups are clocks; proposals exist with a 15 s ready-check, "follow" and an idle rule (2.2). |
| 2 | Docking control | One helm, hand-over on request or after 30 s idle, craft sovereignty (owners fire their own stages while docked), helm vacant at once on disconnect (5.2). |
| 3 | Expiry | Wall clock; 14 days after the owner's last session; 10 slots; docking protects through the most recently active owner; debris 2 hours (6.5). |
| 4 | Damage | Parts are intact or destroyed, joints intact or broken; no health values (5.4). |
| 5 | Spectator stream | Menu: `live.json` at 1 Hz, no socket. Live cam of one craft: a tier-B subscription over a socket opened for it (4.2, 3.3). |
| 6 | Admission | Soft cap from measured tick-time headroom; queue in the menu; queued players may spectate (7.3). |
| 7 | Nodes persisted | Yes, as an opaque blob per craft (4.3, 6.1). |
| 8 | Pads | 90 s reservation, 300 s on the pad with one 120 s extension, 20 s safing; two sites; time-shifted slots when the live queue exceeds 60 s (2.7). |
| 9 | Identity | Account record plus device-key credentials in Postgres, recovery code stored as a slow hash, per-IP creation limits at the API (6.1, 4.9). |
| 10 | Logout under thrust | Controls latched 10 s, then throttle zero; after 120 s the server finishes the flight un-paced with no invented inputs (2.6). |
| 11 | Other desktop browsers | Not decided here. |
| 12 | Sharing planned nodes | Not in this design; a docking partner sees committed trajectories and projected echoes only. |

To measure before the architecture depends on it: the per-vCPU cost of an integrated vessel on Railway
(replaces 3.4), the correction rate of the replica in contact, warp screening against 10,000 objects in one
shell, bubble hand-over between workers under load, and items 1, 4, 5 and 6 of `hosting.md` section 12.

