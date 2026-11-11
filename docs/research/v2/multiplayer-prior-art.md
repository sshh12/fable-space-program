# Multiplayer prior art, time models and compute split (v2 research)

Research input for the v2 architecture. It answers three questions:

1. How has multiplayer been solved for orbital-mechanics games and large shared simulations, and what
   transfers to this project?
2. Which time model lets every player warp privately (an interplanetary transfer is months to years of
   game time) inside ONE persistent universe where players can still rendezvous, dock and collide?
3. Where should simulation run (server, client, on-demand compute), and what does each split cost in
   CPU, latency and cheat resistance?

Design only. Nothing here changes a contract; section 8 lists the places in the v1 design that the
recommendation touches so the architect can change them in place.

How to read the evidence. Sources marked **[read]** were fetched and read in this session (primary
where possible: mod source code, wikis, issue trackers, developer blogs, provider documentation).
Sources marked **[memory]** are well-known references cited from knowledge and not re-read. Sources
marked **[secondhand]** are forum or hosting-guide summaries and should not carry a decision alone.

---

## 1. What this supports, and what a designer must not miss

### 1.1 Decisions supported

| # | Decision | Section |
|---|---|---|
| D1 | **Time model: per-vessel head time, forward only.** Every vessel has a committed history up to its own "head" time. Vessels interact only at equal times. A vessel nobody is flying is evaluated analytically at whatever time a visitor is at. A player who is behind catches up with one forward jump; nobody ever goes back. A wall-clock-anchored "live" clock is the default spawn time. | 5.6, 5.9 |
| D2 | **Warp is consensual only inside a group that shares a clock** (vessels in contact range, a docked assembly, or friends who link on purpose): the group runs at the lowest requested rate. Everywhere else warp is private and unrestricted. | 5.7, 5.9 |
| D3 | **The unit of simulation is a small world with one clock** (the existing `Sim` is exactly that). The server runs many of them, one per group of vessels that can touch each other, and stores everything else as analytic trajectories. | 6.3, 8 |
| D4 | **Compute split: the server is the only authority for anything another player can be affected by** (contact, docking, damage, persisted state). The client always runs the same deterministic sim for prediction. Solo integrated flight is the one place where the server's own simulation may be deferred or sampled; coasting costs nothing on either side; planning stays on the client. | 6 |
| D5 | **Netcode inside a contact group: client-side prediction of the whole group with rewind-and-replay against server snapshots at 20-30 Hz, positions sent relative to an analytic reference orbit.** Lockstep and peer-to-peer rollback do not fit. | 4 |
| D6 | **Transport: binary WebSocket, with messages designed so they would also survive an unreliable transport.** Railway, the only named provider that can hold long-lived sockets, has no UDP, which rules out WebTransport and WebRTC there. | 4.3 |
| D7 | **Expiry and cleanup run on the wall clock**, never on universe time. | 5.9 |

### 1.2 Facts not to miss

1. **Nobody has shipped private warp in one shared universe without giving each player their own time.**
   DarkMultiPlayer, Luna Multiplayer and the 2026 Kitten Space Agency multiplayer mod all converge on the
   same rule: warp alone, then jump forward to whoever is ahead. KSP 2 never published a design. The
   lead developer of Luna Multiplayer wrote that "ideally the physics should run on the server instead
   of in clients". (3.1-3.3)
2. **Forward-only has a price that cannot be designed away: whatever a player touches at a later time is
   out of reach for everyone at an earlier time** until they jump forward. DarkMultiPlayer shows it as
   "This vessel has been changed in the future." Any model that hides this is merging timelines, which
   the brief forbids. The mitigation is that jumping forward is free for a coasting ship. (5.5, 5.9)
3. **A long time jump destroys station-keeping.** Two ships in low Earth orbit whose semi-major axes
   differ by 1 m separate by about 9.4 m per orbit, which is about 160 km over three years. So a player
   must jump to the target's time first and fly the rendezvous afterwards, never the other way round
   for a long jump. The rendezvous planner has to drive this. (5.9, R8)
4. **The warp table is too slow for the outer planets.** At 100,000x one real hour is 11.4 years. A
   Hohmann transfer takes 259 days to Mars (3.7 minutes real), 2.7 years to Jupiter (14 minutes), 6.1
   years to Saturn (32 minutes), 16 years to Uranus (1.4 hours) and 30.6 years to Neptune (2.7 hours).
   "Players must be able to reach and orbit them" needs levels of 1,000,000x and 10,000,000x.
5. **Universe time will run centuries ahead of the live clock within days of launch, and float64
   seconds lose resolution as it does.** The spacing between representable `ut` values is 0.12 µs at
   1e9 s (32 years), 1.9 µs at 1e10 s (317 years) and 15 µs at 1e11 s (3,170 years); 15 µs is 12 cm at
   orbital speed. Either cap how far ahead a vessel may be, or change how time is stored. (5.10)
6. **Bit-identical results between a browser and the server are not guaranteed today.** `src/sim` calls
   `Math.sin`, `Math.cos`, `Math.atan2`, `Math.exp`, `Math.pow` and similar 143 times across 31 files,
   and ECMAScript leaves those functions implementation-defined. The golden-hash tests run in Node
   only. Any design that compares client and server by hash needs vendored transcendental functions
   first; otherwise compare with a tolerance. (6.4)
7. **Interpolating absolute positions fails at orbital speed.** 100 ms of interpolation delay at
   7.8 km/s is 780 m. Luna Multiplayer's jitter and docking explosions come from this plus two clients
   each simulating one of the two docking vessels. Send state relative to an analytic reference orbit
   and simulate both vessels in one place. (3.2, 4.2)
8. **Railway serves WebSocket over HTTP/1.1 only, lists 10,000 concurrent connections, and has no
   inbound UDP** (a feature request dated 2026-02-22 is "under review"). Modal treats each WebSocket as
   one function call. Netlify has no CLI or token on this machine yet. (4.3)
9. **Terrain is the heaviest thing to simulate server-side.** Server-side contact needs the height
   tiles on the server. Pads are analytic flat discs and cost nothing; a shared landing site on the
   Moon needs that region's tiles wherever the group is simulated. (6.2)
10. **v1 assumes one clock, one active vessel and one warp control** (`SimSnapshot.ut`,
    `activeVesselId`, `WarpState`, debris tiers measured from "the" active vessel, a 24-debris cap per
    sim, no vessel-to-vessel contact). These are the in-place changes; section 8 lists them.

---

## 2. Method and limits

- Read first-hand: DarkMultiPlayer source (`Common/Common.cs`, `Server/Settings.cs`,
  `Client/VesselWorker.cs`, `Client/WarpWorker.cs`), Luna Multiplayer wiki pages (Timewarp, Lock
  system, Interpolation, Parts synchronisation) and issue tracker, the KSA Multiplayer Mod listing, two
  CCP developer blogs on EVE Online plus the original time-dilation blog, the Star Citizen server
  meshing Q&A, the Space Engineers multiplayer overhaul post, Glenn Fiedler's snapshot interpolation
  article, Gabriel Gambetta's prediction article, Railway and Modal documentation.
- Not found: any published KSP 2 multiplayer time-warp design; any official Kitten Space Agency
  multiplayer design; any browser game that solves private warp in a shared universe.
- The Kerbal forum blocks automated fetches (HTTP 403), so forum threads are represented only through
  search summaries and are marked secondhand.
- No code was run against the repo beyond one read-only count of `Math.*` calls. CPU figures in section
  6 come from `docs/ARCHITECTURE.md` ("about 0.1 ms per step") and are estimates until measured on
  server hardware.

---

## 3. Prior art

### 3.1 DarkMultiPlayer (KSP 1) **[read: source]**

Architecture: each client runs the full game and is the authority for the vessel it controls; the
server relays and stores vessel files. There is no server physics.

Warp modes, from the `WarpMode` enum and the client's warp worker:

| Mode | Behaviour |
|---|---|
| `MCW_FORCE` | One player takes a "warp master" lock and everyone is dragged into the same warp. |
| `MCW_VOTE` | Same, after a vote (`REQUEST_VOTE` / `REPLY_VOTE` messages). |
| `MCW_LOWEST` | Everyone warps at the lowest rate any player has selected. |
| `SUBSPACE_SIMPLE` | Private warp, but only one frontier: a player behind the most advanced subspace is offered "Press '>' to warp Ns into the future" and cannot warp otherwise. |
| `SUBSPACE` (server default) | Private warp. Each warp creates a subspace; players may sync forward to any subspace ahead. |
| `NONE` | No warp. |

The causality rule is in the code, not only in the documentation:

- Incoming vessel updates carry a planet time. Updates later than the receiver's own universe time
  stay queued and are applied when the receiver's clock reaches them.
- `VesselUpdatedInFuture(id)` is true when the latest update for a vessel is later than the local
  universe time plus 3 s. Such a vessel cannot be controlled: the player becomes a spectator and sees
  "This vessel has been changed in the future." The other spectator reasons are "controlled by another
  player" and "protected by <owner>".
- A client does not report the death, recovery or termination of a vessel that "has been changed in
  the future": a player in the past cannot destroy what a later player has already used.

Locks: `control-<vesselId>` and `update-<vesselId>`. On docking the client whose vessel is active
"force[s] the control lock off any other player" for the merged vessel.

Housekeeping on the wall clock: `autoDekessler` removes debris every 30 minutes by default, `autoNuke`
clears vessels at the launch site on an interval (off by default), and `safetyBubbleDistance = 100 m`
is "the minimum distance in which vessels can interact with eachother at the launch pad and runway".

What it teaches: the future-lock rule is the minimal consistent rule; a real-time-interval debris
sweep and a pad safety zone were needed even at 20 players.

### 3.2 Luna Multiplayer (KSP 1) **[read: wiki and issues]**

Time. A player's clock is the server's wall-clock time (kept by NTP) plus the offset of their subspace.
Warping creates a subspace `{id, player time - server time}`. The wiki's example: warp 2x for 5 s and
you are in subspace `{1, 10}`. So there is a base clock tied to real time and every subspace is a
constant lead over it.

What others look like. The wiki is explicit that other vessels are sometimes "kept in place even if you
warp to the future": a vessel in a stable orbit or escaping is extrapolated to the viewer's time; a
suborbital or atmospheric vessel is left where it was, because "we cannot predict where a vessel will
be in the future as we don't know what the other players might do".

Locks. Control (who flies a vessel), Update (who sends its position and part state; taken by whoever
is within the 20 km load distance of an uncontrolled vessel), Unloaded Update, Spectator, Asteroid.
In the documented configuration position updates go out every 50 ms within load distance and every
150 ms otherwise, and are rendered with entity interpolation ("store the updates we receive and replay
them after some seconds").

Pain points, from the issue tracker:

| Issue | What happened |
|---|---|
| #469 (open) | A client that cannot keep up with its subspace clock is teleported forward along its trajectory, which cuts thrust and ruins burns, "even if you are in your own subspace". A contributor: "There is currently no solution based on the underlying mechanism." Lead developer: "Ideally the physics should run on the server instead of in clients but that would involve A LOT of work". |
| #255 (open) | "Can't rendezvous in orbit due to time sync jump": a 3.5 s clock lag triggers a resync during proximity operations. |
| #251 | "Ships being 'taken back' in time and position when players sync to most recent subspace". |
| #380 (open) | Docking with another player explodes (older versions) or kicks one player (0.28). A contributor's explanation: the docking-port magnets misbehave "when both clients are trying to sync it". |
| #543 (open) | The universe keeps advancing while the server is stopped because time derives from the wall clock; players asked for an option to pause it and wrote a launcher script that shifts the start time. |
| #265, #225 | Vessels deleted "after decoupling and warping"; craft duplication. |
| #31 | Feature request for handing control to another client after docking. |

What it teaches: (a) a wall-clock base plus per-player lead is a workable anchor; (b) client authority
is the root of the docking and duplication bugs; (c) forcing a lagging client forward is destructive,
so a lagging simulation must be allowed to fall behind; (d) decide deliberately whether the universe
advances while the server is down.

### 3.3 KSA Multiplayer Mod and KSP 2

**KSA Multiplayer Mod** (community mod for Kitten Space Agency, 2026) **[read: listing]**. Each player
"warp[s] on your own schedule"; the player list shows clock offsets; "a Sync control jumps you forward
to match someone who is ahead." The author notes that "most of the interesting bugs come from two
players being at different points in time." Docking: the initiating player controls the combined
stack, the other "keeps ownership of their craft and their camera", control returns on undock, and a
docked passenger can ask to be let off. It uses a headless dedicated server.

**KSP 2** **[secondhand]**. Multiplayer was the last roadmap milestone and never shipped; the studio
closed in 2024. Public statements found: it would be "not just cooperative", and in a March 2023 AMA
the creative director said terrain changes have "brain-bending multiplayer implications, especially
when time warp gets involved". No statement of the intended time model was found. Community proposals
on the official forum fall into the families analysed in section 5 (one real-time bubble per sphere of
influence with a journey planner instead of manual warp; warp at the slowest requested rate; subspaces).

### 3.4 EVE Online **[read: CCP developer blogs]**

- One shard. Each solar system is simulated by one process and its physics ("Destiny") ticks once per
  second, chosen "to keep bandwidth requirements low enough for massive space battles".
- Interest management: a solar system's space is "a collection of bubbles", each "a small volume of
  space within which entities can physically interact"; bubbles resize dynamically and never overlap.
  Simulation frames only carry updates for ships in the same bubble.
- Where the CPU goes: in CCP's 2010 profiling less than 10% of the tick was physics. Most was deciding
  which clients to inform and serialising the update; "the cost of a missile is somewhat proportional
  to how many observers can see it".
- Time dilation: when a node is overloaded the game clock for that load slows, in fine increments, so
  the queue of waiting work stays near zero. Things players time with a watch (reinforcement timers)
  are deliberately not dilated. The EVE University wiki gives the floor as 10% of real time
  **[secondhand]**.
- A 2025 blog measures roughly 30,000 messages per second across the whole cluster in normal play.

What it teaches: fan-out and serialisation dominate, not physics; group by "can physically interact";
and overload is best handled by slowing a local clock rather than dropping work. With per-group clocks
(section 5.9) that last mechanism comes for free.

### 3.5 Space Engineers **[read: 2018 overhaul post; secondhand for settings]**

- Dedicated servers with the server as authority; the 2018 overhaul rewrote "the prediction protocol on
  client-server". The cases listed as needing special handling read like this project's future list:
  ships, fast-moving objects, "player standing on a moving grid", "colliding grids", rotors, pistons.
- The stated target was simulation speed 1.0 with 16 players and a per-world budget of 100,000 "PCU"
  (a per-block cost figure); each server used about 3 CPU cores. The author points out that 16 players
  in wheeled vehicles means about 300 interconnected simulated bodies.
- Hosting guides describe a "sync distance" (default 3,000 m) inside which objects are streamed to a
  client, and wall-clock "trash removal" thresholds for abandoned grids **[secondhand]**.
- Lesson stated by the developer: some performance bugs appeared "only in multiplayer games with a
  specific amount of players doing specific activities"; internal testing was biased and public tests
  were needed.

What it teaches: a per-player object budget and wall-clock trash removal are standard for a persistent
physics sandbox, and the capacity claim has to come from tests with active players.

### 3.6 Elite Dangerous **[secondhand]**

Community descriptions agree on: peer-to-peer sessions ("instances") of at most about 32 players, with
central servers for matchmaking and persistent transactions; the galaxy is one shared dataset but
players only ever simulate together inside an instance. It does not transfer: peer authority fails the
"server-authoritative" requirement and is the documented source of its cheating and combat-logging
problems.

### 3.7 Star Citizen **[read: server meshing Q&A]**

- A replication layer sits between clients and game servers. It runs "no animation, no physics, just
  network code", holds the state of every networked entity and streams it to clients and to server
  nodes.
- For each entity exactly one server node "has authority"; others hold a read-only view; authority can
  move. Static meshing fixes the split in advance and "suffer[s] from congregation problems"; dynamic
  meshing re-evaluates it continuously.
- Persistence: the replication layer writes entity state to a graph database "that stores the state of
  every single network replicated entity", so a crashed game server can be replaced without losing
  state (target: under a minute for a replication node).

What it teaches: separate "who holds and fans out state" from "who simulates it", make simulation
authority a movable per-entity property, and persist from the state holder, not from the simulators.

### 3.8 Browser spaceflight sims

SpaceX's ISS docking simulator is a single-player browser docking trainer **[memory]**. A search for
browser multiplayer orbital games found small projects (a WebSocket orbital game with "real-time
multiplayer", a "persistent browser MMO built on real NASA orbital data") with no documented time
model **[secondhand]**. There is nothing to copy: no browser title was found that combines true-scale
orbits, private warp and shared persistent state.

### 3.9 What transfers

| Idea | From | Use here |
|---|---|---|
| Private warp + forward-only sync + "changed in the future" lock | DMP, LMP, KSA mod | The core of the time model (5.9), with the server as authority. |
| Wall-clock base time plus a per-player lead | LMP | The live clock and the default spawn time. |
| Server physics for anything two players touch | LMP's own wish; Space Engineers | Contact groups are server-simulated (6.3). |
| Groups of entities that can physically interact, sized dynamically | EVE bubbles | Contact groups; interest tier A (7). |
| Slow the local clock under overload | EVE time dilation | A contact group may run below 1x; nothing else is affected. |
| State holder separate from simulators; one authority per entity, movable | Star Citizen | Universe directory + many small sim worlds (6.3). |
| Per-player object budget; wall-clock trash removal; pad safety zone | Space Engineers, DMP | Expiry and pad rules (5.9, R12-R13). |
| Initiator flies the docked stack; the other keeps ownership and can leave | KSA mod, DMP | Docked control sharing (5.9, "docked assemblies"). |

---

## 4. Server-authoritative netcode: what fits

### 4.1 Techniques

| Technique | What it is | Fit |
|---|---|---|
| **Client-side prediction + server reconciliation** (Gambetta **[read]**; Valve **[secondhand]**) | The client applies each input locally at once, tags it with a sequence number and keeps it until acknowledged. Each server state says which input it includes; the client resets to that state and replays the inputs still pending. | **Use.** The sim is deterministic and shared, so the client's prediction is the same code as the server's. Needed for hand-flown burns to feel immediate. |
| **Snapshot interpolation** (Fiedler **[read]**) | The server sends state at a fixed rate; the client draws remote objects slightly in the past, between two received states. Fiedler's numbers: about 350 ms of delay at 10 Hz, 150 ms at 30 Hz, 85 ms at 60 Hz; Hermite interpolation with velocities removes the artefacts of linear interpolation at low rates. Valve's default delay is 100 ms. | **Use for vessels outside the player's contact group**, on top of a reference orbit (4.2). Not for vessels the player can touch: an object drawn 100 ms in the past cannot be docked with precisely or collided with consistently. |
| **Predicting every body in the scene and replaying on correction** (Rocket League **[memory]**) | The client simulates all physical bodies it can touch, not only its own, using the last known inputs of others; server states trigger a rewind and replay. | **Use inside a contact group.** Groups are small (2 to about 10 vessels), a 100 ms replay is 12 steps per vessel, and contact between two predicted bodies stays consistent. |
| **Delta compression** (Quake 3 **[memory]**) | Send only what changed against a state the receiver is known to have. | **Use.** Over an ordered reliable stream the previous message is always that state, so no acknowledgement tracking is needed. Part state (resources, engine state) changes slowly and compresses well. |
| **Interest management / area of interest** (EVE; Star Citizen) | Send each client only what is relevant, at a rate that falls with relevance. | **Use**, keyed on space and on time relation (7). |
| **Lag compensation** (Valve **[secondhand]**) | The server rewinds other players to what the shooter saw (up to 1 s in Source) to judge a hit. | **Not needed.** There are no instant-hit actions; docking and collisions are judged in server time from simulated contact. |
| **Deterministic lockstep** (Fiedler **[read]**) | Peers exchange only inputs and all simulate identically; a step runs when every input for it has arrived. Fiedler recommends it "for 2-4 players at most" because everyone waits for the most lagged player, and it needs bit-exact determinism across machines. | **Reject** as the network model: one stalled player stalls the group, late joiners need a full state transfer anyway, and cross-engine float determinism is not established (1.2 fact 6). The determinism is still valuable for prediction, replay audits and tests. |
| **Peer-to-peer rollback** (GGPO **[memory]**) | Each peer predicts remote inputs and rolls back on misprediction; no server. | **Reject** as the model (no authority, 2-4 peers). The client-side rewind-and-replay above is the same mechanism under a server. |
| **Time dilation** (EVE) | Slow the clock of an overloaded region. | **Use** per contact group as the overload valve. |

### 4.2 Two rules specific to orbital flight

1. **Replicate relative to an analytic reference orbit.** A contact group has an anchor trajectory (the
   conic of its heaviest or oldest member). Every state in a snapshot is an offset from that
   trajectory. The receiver evaluates the reference at its own render time in float64 and interpolates
   or predicts only the small offset. This removes the 780 m-per-100 ms problem, keeps network
   quantisation fine (a millimetre step over ±8 km fits in 24 bits per axis), and satisfies "preserve
   precision for close docking anywhere in the solar system" because nothing on the wire is
   heliocentric.
2. **One simulation per contact.** Both vessels of a docking or a collision are stepped by the same
   process in the same step. Luna Multiplayer's docking failures are what the alternative looks like.

### 4.3 Transport in browsers, November 2026

| Transport | Browser support | Server reality on the named providers | Notes |
|---|---|---|---|
| WebSocket | Universal | Railway: supported over HTTP/1.1, exempt from the duration and idle limits, "can stay open indefinitely"; 10,000 concurrent connections and about 11,000 requests per second per domain listed as limits; higher on request **[read]**. Modal: supported on ASGI and web-server functions, 2 MiB per message, no `permessage-deflate`, one function call per connection, default 200 calls per second per function **[read]**. | Ordered and reliable over TCP: one lost packet delays everything behind it until retransmission. |
| WebTransport (HTTP/3 datagrams and streams) | Chrome 97+, Edge 98+, Firefox 114+, Safari 26.4+ (March 2026) **[secondhand]** | Needs UDP. Railway documents HTTP/1.1 and HTTP/2 only and has an open request for inbound UDP. Node has no built-in server; the usable package is a third-party binding to Cloudflare's QUIC library, described as early **[secondhand]**. | Unreliable datagrams with no head-of-line blocking. |
| WebRTC data channel | Universal | Needs UDP plus a signalling path and ICE. Modal has WebRTC examples that go through its ASGI layer; raw inbound UDP was not confirmed **[secondhand]**. | Heaviest to operate. |

Recommendation: binary WebSocket. Reasons beyond availability:

- Most of this game's shared state is not a stream at all. A coasting vessel is one small trajectory
  message until it next manoeuvres.
- Inside a contact group the client predicts everything it can touch, so a 200 ms stall on packet loss
  shows up as a late correction, not as frozen motion.
- Docking is slow. Collisions at orbital speed are decided by the server whatever the transport.

Keep the door open by making every high-rate message idempotent and "latest wins" (a full or
delta-from-acknowledged snapshot with a tick number, never an increment that must not be lost), so the
same messages can ride datagrams if a UDP-capable host is added. On the server, watch the socket's
buffered amount and replace a queued snapshot with a newer one instead of queueing both.

Netlify can serve the static client and assets; it cannot hold a game socket. Using it needs the CLI
installed and a token in `.env`, neither of which exists on this machine.

---

## 5. The time problem

### 5.1 What the existing simulation already gives us

- Bodies are functions of universe time. Anyone can evaluate any planet at any time for free.
- A coasting vessel is a chain of conic patches with exact transition times. Its state at any later
  time is a pure function of one stored state, until a force acts on it. This is the property that
  makes private warp affordable: a vessel nobody is flying has no "current" state that must be kept up
  to date.
- A vessel under thrust, in atmosphere, in contact, or near another vessel needs fixed 1/120 s steps
  and a human at human speed.
- The sim is deterministic and headless, so the same code can predict on the client, decide on the
  server and replay in an audit.

### 5.2 Vocabulary used below

- **Universe time (UT)**: seconds since J2000, as in the contracts.
- **Live clock**: a server-defined UT that advances one second per wall-clock second from a fixed
  start mapping. It is computed from the wall clock, so it needs no persistence.
- **Head time** of a vessel: the latest UT at which its state is committed. History before the head is
  fixed.
- **Lead**: head time minus the live clock.
- **Active vessel**: a player is flying it, or the server is integrating it. Its head advances as it
  is simulated. **Passive vessel**: nobody is flying it and it is coasting or landed; its state at any
  UT after its head follows from propagation alone.
- **Clock group**: active vessels that share one clock and therefore one warp rate.
- **Contact group**: vessels close enough to touch (a few kilometres, or a predicted close approach).
  A contact group is always inside one clock group and is simulated as one world.
- **Echo**: a non-collidable drawing of a vessel that is not at the viewer's time. A *recorded echo*
  shows where a vessel that is ahead was at the viewer's time. A *projected echo* shows where an active
  vessel that is behind would be at the viewer's time if it coasted from now.

### 5.3 What any model has to satisfy (from `PROMPT.txt`)

- C1. Private warp must exist and be practical: no "global warp control that makes everyone else's
  flight unplayable".
- C2. One persistent universe; "no divergent timelines silently merged by teleporting ships".
- C3. Real rendezvous, docking, undocking and collisions between players, server-authoritative; "don't
  fake multiplayer with cosmetic ghost ships".
- C4. Defined behaviour for entering and leaving warp near others, burns, sphere-of-influence
  transitions, logout, cleanup.
- C5. Ships and docked assemblies persist across logout and restart; bounded growth of abandoned
  objects.
- C6. Trajectories and intercepts on the map derive "from the actual simulation and its time model".
- C7. A mega-lobby under front-page traffic: most players should be able to see each other live.

### 5.4 Model A: one universal clock

Variants: no warp at all; warp for everyone by force, vote or lowest request (the three
DarkMultiPlayer "master controlled warp" modes); a universe that always runs at a fixed multiple.

| Question | Answer |
|---|---|
| What players see of each other and the planets | Everything, at the same time. No echoes. |
| Arranging a rendezvous | As in single-player KSP, without warp unless everyone warps. |
| Entering or leaving warp near others | Warp is global. Under "lowest" any one burning player holds the whole lobby at 1x; under "force" a warping player wrecks every burn in progress. |
| Burns | Fine at 1x; impossible in a fixed-multiple universe. |
| SOI transitions | Trivial. |
| Logout | The ship keeps flying in real time. |
| Cleanup | UT and wall time coincide, so one clock serves both. |
| Stations | Trivially consistent. |
| Paradoxes | None possible. |
| Fun | Best coherence, but the Moon is three real days away and Mars eight and a half months. With thousands of players someone is always burning, so shared warp never happens. |

Verdict: fails C1. Worth keeping only as the rule *inside* a clock group.

### 5.5 Model B: per-player subspaces with forward-only sync (DMP, LMP, KSA mod)

Each player has a time offset. Warping moves the player to a new subspace ahead. A player may jump
forward to any subspace ahead and never back.

| Question | Answer |
|---|---|
| What players see | Planets at their own time. Other vessels: LMP extrapolates stable orbits to the viewer's time and freezes the rest in place; DMP holds back updates from the future until the viewer's clock reaches them. |
| Arranging a rendezvous | Both get into the same subspace by syncing to the more advanced one, then fly it. Players agree by chat who may warp. |
| Entering or leaving warp near others | Warping leaves the shared subspace; nothing prevents it, so the other player is left with a stale or frozen ship. |
| Burns | Private, fine. |
| SOI transitions | Client-side as in single-player. |
| Logout | The vessel file stays at its last update time. Later subspaces can use it; earlier ones see "changed in the future". |
| Cleanup | Wall-clock sweeps (debris removal, launch-site clearing). |
| Stations | The last player to touch one, in universe time, owns its present. |
| Paradoxes | Excluded by forward-only sync and the future lock, in principle. In practice client authority produces duplicated and deleted craft, rewound ships and docking explosions (3.2). |
| Fun | Proven with small groups of friends who talk to each other. Reported friction: time jumps during proximity operations, confusion about who is "when", vessels that cannot be used. |

Why it does not scale as it stands: every warp makes a new subspace and nothing pulls players back
together, so in a mega-lobby almost everyone is alone in theirs; the unit of time is the player, so an
abandoned ship has a time of its own that someone must reconcile; and the clients are the authority.

### 5.6 Model C: per-vessel head time with a causality rule

Statement. Every vessel has a head time. Its history up to the head is immutable. *A vessel is
authoritative at its head time and can only be affected by something that is at or after that time.*
Two vessels interact only when both are at the same UT.

The decisive refinement over model B is the passive vessel. A coasting or landed vessel with no pilot
has no clock that runs. Its head is a lower bound: for any viewer at a later UT its state is the
propagated state, exact and free, and it is fully solid. Only when someone touches it does its head
move, to the toucher's time.

That gives one table that answers "what do I see, and can I touch it":

| The other vessel is | behind me (its head is earlier than my time) | at my time, in my clock group | ahead of me (its head is later than my time) |
|---|---|---|---|
| **passive** | Solid. Evaluated at my time. If I enter contact range its head becomes my time. | (a passive vessel is never "at" a time) | Recorded echo. Not collidable. I can jump forward to its head or later. |
| **active** | Projected echo, updated as its pilot manoeuvres. Not collidable. Its pilot can jump forward to me; I cannot go back. | Live and solid. | Recorded echo. Not collidable. I can jump forward to it. |

| Question | Answer |
|---|---|
| Planets | Each client draws the bodies at its own vessel's time. Two players at different times see different planetary configurations, correctly. |
| Arranging a rendezvous | The chaser plans against the target's trajectory as a function of time: committed history up to the target's head, coasting prediction after it. The two agree on a meeting time no earlier than the later of their heads; whoever is behind jumps forward. Details in 5.9. |
| Entering or leaving warp near others | Needs an explicit rule, because unconstrained private warp next to another active vessel lets a player dodge a collision by leaving its time. This is model D. |
| Burns | Always at the vessel's own clock; no one else is affected unless they share a contact group. |
| SOI transitions | Processed at their exact UT per vessel, as today. Time is the same axis in every sphere of influence; only the frame changes. |
| Logout | A coasting or landed vessel becomes passive at its head. A vessel under thrust or in atmosphere is carried on by the server until it can coast, lands, or is destroyed. |
| Cleanup | Must use the wall clock: universe time is per vessel and can differ by centuries. |
| Stations | A station is passive whenever nobody is aboard, so it costs nothing and is at whatever time its next visitor is at, provided that is not before its head. Each visit can only move its head forward. |
| Paradoxes | Changing a committed past: impossible, echoes cannot be touched. Touching an undecided future: impossible, projected echoes cannot be touched. Two players claiming one passive vessel from different times: the server orders the claims; the loser sees an echo. |
| Fun | Unlimited solo warp; friends meet with one jump. The cost is teaching "you can only touch things at your own time" and showing echoes honestly. |

Model C is model B with three changes: time belongs to vessels, passive vessels are evaluated lazily,
and the server holds the worldlines. It still needs a rule for warp near others (model D) and
something that makes players' times coincide often enough for C7 (the live clock, 5.9).

### 5.7 Model D: negotiated warp inside a proximity bubble

Statement. Vessels within interaction range share a clock; changing its rate needs the agreement of
every player in range.

This is not a complete model. It says nothing about two regions that have agreed on different rates,
which by then are at different universe times, so it presupposes model C (or B) for everything outside
the bubble. As a rule *inside* a clock group it is exactly right, and DarkMultiPlayer's `MCW_LOWEST`
is its simplest form:

- The group's rate is the lowest rate any member requests or is limited to (burning, in atmosphere,
  near terrain, approaching an event).
- A "warp to time T" proposal (to a manoeuvre node, to a closest approach) is a ready-check.
- A member may leave by warping away only when no other member's vessel is within contact range and no
  close approach is predicted; otherwise leaving needs consent.

### 5.8 Other variants considered

| Variant | Idea | Why not |
|---|---|---|
| Real-time universe, travel while logged out | No warp; commit a coast, log out, arrive in real days. | Fails C1 in practice; no interplanetary flight can be demonstrated in a session. Its appeal (ships that arrive on Thursday) survives in the recommendation as "leads decay while you are away". |
| Vessel advances along its orbit faster than the planets move | Private fast-forward of the ship only. | Not physics: a transfer orbit meets its target only because the target moves during the transfer. |
| Timeline repair | Let the past change and re-derive everything downstream. | A ship that docked with a station at a place the station was then never at has been teleported. Forbidden by C2. |
| Hubs pinned to the live clock | Public stations exist only at the live clock; players ahead must wait for it to catch up. | A Moon returnee waits three real days to dock; a Mars returnee years. |
| Everyone spawns at the frontier (latest head in the universe) | One shared "present" at the most advanced time. | The frontier moves at up to 100,000 s per second whenever anyone warps, so players in ascent at 1x are scattered across different times and never see each other. |
| Relative-state-preserving jump | Jumping forward next to an echo keeps the offset to the target instead of propagating one's own orbit. | It is a teleport in absolute terms (fact 3 in 1.2 is exactly the error it hides). Could be offered later as an explicit "station-keeping hold" that charges propellant; not a default. |

### 5.9 Recommendation: per-vessel time, shared clocks by consent, a live clock to gather players

Model C for the universe, model D inside clock groups, plus a live clock that makes the pad a shared
place. The rules, then the walkthroughs the brief asks for.

**Rules**

- **R1. One time axis, many worldlines.** There is one universe. Every vessel has a head time and an
  immutable history before it. Heads never decrease.
- **R2. Live clock.** UT_live = fixed start UT + wall-clock seconds since the fixed wall-clock start.
  It is the default spawn time and the time shown in the menu's live Earth. It keeps running across
  restarts and downtime (decide this on purpose; see the Luna Multiplayer issue in 3.2).
- **R3. Passive vessels are lazy.** A passive vessel's state at any UT at or after its head is its
  propagated state, including its scheduled events in order (SOI changes, an atmosphere entry or
  impact that the server resolves at reduced fidelity). A vessel may only become passive on a
  trajectory the server can evaluate that way.
- **R4. Interaction needs equal time.** Contact, docking, resource transfer and control exist only
  between vessels in one clock group, or between an active vessel and a passive vessel it has claimed.
- **R5. Claim.** When an active vessel's own path brings it within contact range of a passive vessel
  whose head is not later than the active vessel's time, the server brings that passive vessel into
  the same simulated world and its head becomes the group's time. The server orders competing claims.
- **R6. Clock groups.** Active vessels in one contact group must share a clock. Players may also link
  voluntarily at any distance ("fly together"). The group's rate is the lowest requested or permitted
  rate; warp-to proposals are ready-checks; an unresponsive member stops blocking after a short
  timeout if its vessel is docked or outside contact range.
- **R7. Leaving by warp.** A vessel may warp out of a group alone only if no other active vessel is
  within contact range and no close approach is predicted; the HUD says why when it is refused. To the
  players left behind, the departed vessel becomes a recorded echo that continues along its orbit.
- **R8. Jump forward ("sync").** A coasting or landed active vessel may advance its head to any later
  UT; this is ordinary rails warp done at once. It is refused if an atmosphere entry or impact lies
  inside the interval, or if it would arrive within a safe distance of a solid vessel at the
  destination time. For a long jump toward a target, the planner jumps first to shortly before the
  target's head and plans the rendezvous from there (fact 3).
- **R9. Close-approach look-ahead.** Predicted close approaches to solid vessels (passive, or in the
  same clock group) are events in the existing warp look-ahead, so warp steps down to 1x seconds
  before any encounter and the encounter is integrated with contact physics. Contact at orbital
  closing speeds (up to about 15 km/s, 125 m per step) needs swept tests so that craft cannot tunnel.
- **R10. Advancing a group for a visitor from the future.** A contact group that is behind an arriving
  vessel can be advanced to it: every vessel in the group coasts forward by the difference. Allowed
  when no member is thrusting, the server's check finds no close approach inside the interval, and the
  group's online pilots agree. While an arrival is waiting, the group admits no new approaches, so the
  wait is bounded by one approach timeout.
- **R11. Echoes.** A vessel that is not at the viewer's time is drawn as an echo: visibly distinct,
  never collidable, labelled with its time offset and the action that would make it reachable ("jump
  +3 d 4 h", or "ask to sync"). Echoes are information about real worldlines, not stand-ins for
  multiplayer: every interaction the brief requires happens between solid vessels.
- **R12. Spawn.** A spawn is a pad plus a UT at or after the live clock. The default is the live
  clock; the menu also offers "a friend's time" and "a target's time". A pad is free at that UT only
  if no committed history occupies it then and no active vessel that is behind still stands on it.
  Rails warp while standing on a pad is limited to a short interval; waiting for a window is done by
  choosing the spawn UT. Vessels left on a pad are returned to the hangar after a wall-clock timeout.
- **R13. Expiry.** Lifetimes are wall-clock durations since the owner's last activity. Docking to an
  assembly makes the whole assembly expire with its most recently active owner. Debris without a
  command part has a short lifetime once no active vessel is near it. Per-player and global object
  caps bound growth. Removing a vessel removes its whole worldline. Every vessel's remaining lifetime
  is visible in the map.

**What players at different times see**

- Planets: each at their own time.
- Fresh spawns at the live clock see each other live. This is the pad crowd, and the reason for R2.
- A player who has warped sees: the people in their clock group, live; every passive vessel whose head
  is not after their time, solid and exact; everyone else as echoes with a time offset.
- The map has a read-only control to view the universe at another vessel's time, so "where is my
  friend now, in their now" has a truthful answer.

**Arranging and executing a rendezvous**

- *Target is passive* (a parked ship, an empty station). Target it. If its head is ahead, jump to
  shortly before its head. Plan against its trajectory, warp, arrive. On entering contact range it is
  claimed into your world. No one's consent is involved.
- *Target is another active player.* Whoever is behind jumps to the other's time (the planner picks
  the jump so the phasing completes close to the target's present). The two link into one clock group.
  The target coasts while the chaser burns; warp between burns is by ready-check. Inside contact range
  the server simulates both in one world.
- *Arriving ahead of an occupied station* (the usual case for someone back from the Moon). The station
  is drawn as a projected echo. The arrival requests an advance; R10 applies.
- *Two players, neither willing to jump.* The one behind must; there is no other consistent option.
  The UI should say so plainly.
- The map draws a target's trajectory as committed patches up to its head and predicted patches after
  it, marks which part is which, and computes intercepts and closest approaches against that function
  of time. This is the existing `Patch` chain per target, so C6 holds without a second mechanism.

**Entering and leaving warp near others**

- Entering: free when alone; a ready-check inside a clock group; refused (with the reason) when
  another active vessel is within contact range or a close approach is predicted.
- Leaving warp near a passive vessel: R9 has already dropped warp before the approach, and R5 makes
  the vessel solid in your world.
- Jumping into an occupied group: allowed only at a safe separation (R8), so nobody can materialise
  inside another ship.

**During burns.** A burning vessel runs at its own clock at 1x, or up to 4x physics warp when alone or
by consent. Linked friends outside contact range may drop the link and go ahead; the burner jumps
forward to them afterwards, and arrives where their map already showed its projected echo.

**At SOI transitions.** Handled per vessel at the exact crossing time, as in v1. A clock group slows
across any member's transition. A contact group changes sphere of influence as a unit, on its anchor's
crossing, so that two ships a hundred metres apart are never under two gravity models.

**On logout or disconnect.** The vessel stays active under server control for a reconnect grace
period, with throttle closed after a few seconds. Then: if it is coasting or landed it becomes passive
at its head; otherwise the server integrates it until it can coast, lands, or is destroyed, and
commits the outcome. A player who returns resumes at the later of the vessel's head and the live
clock, so leads shrink naturally while a player is away. Disconnecting never removes a vessel from a
contact group mid-collision.

**On cleanup and expiry.** R13. The clock is the wall clock because it is the only one all vessels
share.

**Persistent stations and docked assemblies.** A station is an ordinary vessel: passive and free when
empty, one clock group when occupied. Its head only moves forward, so after a visitor from far ahead
docks, earlier players reach it by jumping forward (one action for a coasting ship). Access is an
owner setting (public, friends, owner only). Control of a docked assembly: one pilot at a time holds
the helm (by default the player who initiated the docking), with explicit hand-over on request; every
player keeps ownership of their own part of the assembly and may undock it at any time; warp of the
assembly follows R6.

**Paradoxes and how each is excluded**

| Paradox | Exclusion |
|---|---|
| Changing something's past | History before a head is immutable; recorded echoes cannot be touched (R1, R11). |
| Touching a future that its pilot has not flown yet | Projected echoes cannot be touched (R11). |
| Two players at different times take the same passive vessel | Claims are ordered by the single server; the vessel's head moves once (R5). |
| Leaving a collision course by changing time | Refused by R7; R9 forces 1x before any encounter. |
| Appearing inside another vessel after a jump | Refused by R8. |
| A vessel existing twice or vanishing (seen in LMP) | One record per vessel on the server; clients never own vessel state. |
| A pad used by two rockets at overlapping times | Pad reservation in R12. |
| An object launched "in the past" that should have hit something in a history already committed | Not resolved: only interactions at head times are physical. Such an object simply appears, solid, in later worlds at its propagated position. This is the one accepted inconsistency; it requires a metre-scale coincidence in a volume of space and nobody can witness it. |

**How fun it is in practice.** Solo players get everything single-player KSP gives, including
100,000x and beyond, with no one able to hold them back. Friends stay together with a link and a
ready-check, which is how KSP multiplayer groups already play by convention. Joining anyone ahead is
one action. New players spawn into a visibly shared launch site. The costs are honest ones: a time
offset next to every name, echoes that cannot be touched, an occasional short wait when arriving ahead
of a busy station, and the fact that a player who is ahead cannot come back to a friend who is behind.

### 5.10 Open knobs and risks

- **How far ahead a vessel may be.** With no limit the frontier reaches centuries in days (fact 5).
  Either cap the lead (for example a few hundred years past the live clock), or store time so that
  resolution does not depend on magnitude (an integer step count, or an integer epoch plus an offset).
  Body ephemerides must remain well-behaved for every UT that can be reached.
- **Stations pulled far ahead.** Not a paradox, but a way to annoy: a player warps decades ahead and
  docks with a public station. The damage is small because jumping forward is free, but it empties the
  station for the launch crowd until they jump. Options: per-station access; a limit on how far one
  docking may advance a public station; server-owned hubs with their own policy. Needs playtesting.
- **Echo history.** A recorded echo needs the vessel's past trajectory. Conic patches are tiny and can
  be kept for the vessel's lifetime. Integrated arcs (ascent, landing, proximity operations) need
  sampled states; keep them for a short wall-clock window and draw nothing, or a coarse arc, after
  that.
- **Contact range and timing.** A few kilometres works for orbital rendezvous, but two crossing orbits
  close a 2.5 km gap in 0.17 s. Contact groups must be formed from predicted close approaches in time,
  not from current distance.
- **Night at the pad.** With the live clock tied to real time, any one site is in darkness half the
  time. Several sites spread in longitude ("multiple Earth launch pads") give daylight somewhere, and
  the spawn-time choice in R12 covers the rest.
- **Teaching it.** The model has one sentence players must learn: you can only touch things at your
  own time, and you can only move forward. The HUD should carry the offset and the available action
  wherever another vessel is named.

---

## 6. Where the computation runs

### 6.1 What costs what

| Activity | Cost | Who can do it |
|---|---|---|
| Passive vessel on rails or landed | Nothing until someone asks; one propagation per query | Anyone, identically |
| Trajectory prediction, intercept and closest-approach search over patched conics | Kepler and Lambert solves; a 100 x 100 departure/arrival grid is about 10,000 solves, well under a second in a worker | Client |
| Solo integrated flight (ascent, burns, landing, entry) | 120 steps per second. `ARCHITECTURE.md` gives about 0.1 ms per step on the development machine, so about 1.2% of one fast core per vessel at 1x, more with separated stages; perhaps 2-3 times that on a cloud vCPU. Unmeasured on server hardware. | Client (already), server, or both |
| Contact group (2 or more vessels that can touch) | The same per vessel, plus contact, in one process | Must be the server |
| Terrain contact | Needs height tiles and the collision cache where the simulation runs | Client has them; server needs them per region |
| Fan-out and serialisation | In EVE this, not physics, was most of the tick | Server |

Order of magnitude: if the server integrates every active vessel in real time, 1,000 players under
thrust or in atmosphere at once is roughly 12 fast cores, or 25-35 cloud vCPUs, spread over many
single-threaded Node processes. That is affordable but it is the capacity bottleneck, and it has to be
measured, not assumed.

### 6.2 The spectrum

| Split | How it works | Authority | Server CPU | Latency feel | Main risk |
|---|---|---|---|---|---|
| **S1. Server simulates everything** | Clients send inputs; the server steps every active vessel at 120 Hz; clients predict and reconcile. | Strongest. | Linear in active vessels; needs terrain for every landing region in use. | Good with prediction. | Capacity and cost at a traffic spike; real-time deadlines on every vessel. |
| **S2. Client simulates its own vessel, server verifies** | The client runs the sim and sends inputs plus periodic state checkpoints; the server replays the inputs with the same code, or checks invariants, before accepting. | Strong if every segment is replayed; weaker if sampled. | Full replay costs the same CPU-seconds as S1 but has no real-time deadline, can be batched, can run faster than real time and on burst compute. Invariant checks cost almost nothing. | Best: no round trip for solo flight. | Depends on client/server agreement (fact 6). A cheat is found after the fact. |
| **S3. Server simulates contact groups; solo flight is client-run and audited; rails are analytic** | S1 inside contact groups and at shared infrastructure; S2 elsewhere. | Server for everything another player can be affected by. | Proportional to the number of vessels in contact groups, plus audits. | Best solo, good in groups. | Two execution schedules to keep correct; hand-over when a solo vessel enters a group. |
| **S4. Analytic state shared as data** | Coasting vessels are trajectory messages; nobody steps them. | Server computes the patches from committed state. | None. | n/a | None; this is free and part of every option. |
| **S5. Heavy planning on the server or on demand** | Intercept search and prediction run remotely. | n/a | Extra. | Worse than local for interactive node editing. | Solves a problem the patched-conic planner does not have. |

Notes on each:

- S1 is the simplest to make correct, and the contact-group path needs it anyway.
- S2's saving is not CPU-seconds unless audits are sampled; it is scheduling freedom. Its natural
  safety property is that a solo vessel has, by definition, nobody within reach, so the server only
  needs to have verified it **before it next interacts or is persisted**.
- The pad is the busiest place and everything there is within reach of something else, so pad and
  early ascent are contact-group work under any split. Vessels interact only pairwise at short range,
  so the pad complex splits into many small independent groups (one per pad and its neighbours), which
  is what lets it spread across processes.
- S5: planning is light and benefits from zero latency. On-demand compute (Modal) fits batch work
  instead: audit replays, load-test bots that fly real ascents, periodic close-approach screening of
  the passive population.

### 6.3 Recommendation

Authority and effort are separate decisions.

- **Authority.** The server alone commits state: every trajectory message, every claim, every contact
  outcome, every persisted record. Clients never own a vessel.
- **Structure.** A universe directory holds every vessel's record (owner, head time, trajectory
  patches, part state, expiry). Around it run many small simulation worlds, each with one clock and
  the vessels of one contact group, each an instance of the existing deterministic `Sim`. Vessels move
  between the directory and a world, and between worlds, as whole serialised states. This is the Star
  Citizen separation of state holder from simulators, at the size this project needs, and it is why
  the per-vessel time model costs so little to adopt: a world with one clock is what the code already
  is.
- **Client.** Always runs the same sim for its own clock group, for prediction, and draws everything
  else from trajectory messages.
- **Solo integrated flight.** Design the session protocol as *timestamped inputs up, checkpoints and
  commits down* so that the server's simulation of a solo vessel can run on either schedule without a
  protocol change: in real time (S1), or deferred from the input log before the next commit (S2).
  Start with real time, because it is the simplest thing that is certainly correct. Use the load test
  to decide whether deferred or sampled verification is needed, and enable it for solo flight only.
- **Overload.** A contact group that cannot hold 120 Hz runs slower than 1x. Its members fall behind
  the live clock and catch up later with a jump. No other group is affected.
- **Planning.** Client, in a worker.
- **Burst compute.** Audit replays, load-test players, screening jobs.

### 6.4 Anti-cheat by split

| Concern | S1 server simulates | S2/S3 client-run solo flight with audit |
|---|---|---|
| Forged state (fuel, position, speed) | Impossible: clients send only inputs. | Possible until audited. Verify before interaction or persistence. Cheap invariants catch the gross cases: continuity between checkpoints, delta-v spent against propellant by the rocket equation, thrust within engine limits. Full replay catches the rest. |
| Running the local sim faster than allowed | Impossible. | The server bounds integrated sim time per checkpoint by wall time times the permitted physics-warp factor. |
| Forged trajectories | The server derives patches itself. | Same: never accept conics from a client. |
| Contact outcomes | Server. | Server; contact groups are never client-run. |
| Leaving a collision by warp or disconnect | Rules R7, R9 and the logout rule. | Same. |
| Hidden-information cheats | None exist: all state is public. | Same. |
| Input automation (autopilots) | Cannot be prevented by either split. | Same. |
| Object spam, pad squatting, pulling stations ahead | Object caps and wall-clock expiry (R13), pad timeout (R12), station access and advance limits (5.10). | Same. |
| False accusations | None. | A replay that differs only by floating-point noise must not flag a player: compare with a tolerance and let the server's result stand, or vendor the transcendental functions so that results are bit-identical. |

---

## 7. Interest management for this game

Relevance has two axes here: distance, and time relation.

| Tier | Who | What is sent | Rate |
|---|---|---|---|
| A. Contact group | Vessels in the viewer's simulated world | Full rigid-body state relative to the group's reference orbit, inputs, part state deltas, events | 20-30 Hz, predicted on the client |
| B. Visible, same clock | Same time, close enough to resolve or to see a plume | Trajectory message when coasting; a low-rate state stream while thrusting; staging and ignition events | 2-5 Hz or on change |
| C. Same sphere of influence, map | Solid vessels and echoes around the same body | Trajectory messages on change; osculating elements for vessels under thrust | On change; 0.2-1 Hz while thrusting |
| D. Elsewhere, or far in time | Everything else | Directory entries: id, owner, body, head time, coarse orbit, expiry | On demand, paged |

- A coasting vessel is sent once per manoeuvre, at about a hundred bytes per patch. Ten thousand
  passive objects are about a megabyte at join if sent naively; page them by sphere of influence and
  send counts for the rest.
- A tier-A snapshot is about 32 bytes per vessel before delta compression; ten vessels at 30 Hz is
  about 10 kB/s per client.
- Cost follows observers (the EVE finding), so a crowded pad complex is the stress case for fan-out
  as well as for physics. Load tests should put simulated players there, flying.

---

## 8. Where the recommendation touches the v1 design

For the architect; nothing here has been edited.

| v1 assumption | Where | Change implied |
|---|---|---|
| One clock for the world | `SimSnapshot.ut`, `simUt`, `Sim.advance` | Unchanged per world. The universe becomes many worlds plus a directory; the client presents one world and draws echoes from trajectory messages. |
| One warp control | `WarpState`, `PlayerCommands` warp level | Warp requests go to the clock group; the result carries who or what limits it. Add jump-forward and link/unlink commands. Add levels above 100,000x. |
| One active vessel | `activeVesselId`, debris tiers measured from it, vessel cycling within 25 km | Several controlled vessels per world, one per player; fidelity tiers measured from the nearest controlled vessel. |
| Vessel-to-vessel contact not simulated | `ARCHITECTURE.md` section 1 row 27; `mustIntegrate` rule 6 (200 m) | Contact, docking ports, assemblies, swept tests; contact groups formed from predicted close approaches. |
| Vessel state enters a sim only through the scenario or a cheat API | `createSim(defs, scenarioId)`, `SimDebug.setVesselState` | First-class export and import of a complete vessel state, so vessels can move between the directory and worlds. |
| Debris cap of 24 per sim; `vesselRemoved` reason `limit` | sim-world | Per-player and global budgets with wall-clock expiry. |
| Scenario start time fixed by a search tool | `ScenarioDef.start` | Spawn at a pad and a chosen UT; the live clock as default. |
| Close approach only against a target body | `Marker` kind `closestApproach`, `Readouts.targetClosestApproach` | Targets may be vessels with a trajectory that is part committed, part predicted; markers carry which. |
| `ut` as float64 seconds | contracts | Decide the lead cap or the time representation (5.10). |
| Determinism proven in Node only | golden-hash tests; `Math.*` in `src/sim` | If client/server hashes are to be compared, vendor the transcendental functions and add a browser-versus-Node golden test. |
| Terrain through `TerrainProvider` with an fs source in Node | `src/terrain` | Already server-capable; the open question is which regions' tiles each simulation host carries. |

---

## 9. Sources

Read in this session:

- DarkMultiPlayer source, `godarklight/DarkMultiPlayer` (master): `Common/Common.cs` (`WarpMode`,
  `WarpMessageType`), `Server/Settings.cs`, `Client/VesselWorker.cs`, `Client/WarpWorker.cs` -
  https://github.com/godarklight/DarkMultiPlayer
- Luna Multiplayer wiki: Timewarp, Lock system, Interpolation, Parts syncronization -
  https://github.com/LunaMultiplayer/LunaMultiplayer/wiki
- Luna Multiplayer issues #31, #225, #251, #255, #265, #380, #469, #543 -
  https://github.com/LunaMultiplayer/LunaMultiplayer/issues
- KSA Multiplayer Mod listing - https://spacedock.info/mod/4068/KSA-Multiplayer-Mod
- CCP, "Introducing Time Dilation (TiDi)" - https://www.eveonline.com/news/view/introducing-time-dilation-tidi
- CCP, "Fixing Lag: Drakes of Destiny (Part 1)" - https://www.eveonline.com/news/view/fixing-lag-drakes-of-destiny-part-1-1
- CCP, "Server Deep Dive - The Power of Pretty" - https://www.eveonline.com/news/view/paint-your-ship-red-and-make-it-faster
- Marek Rosa, "Space Engineers: Multiplayer Overhaul" - https://blog.marekrosa.org/2018/07/space-engineers-multiplayer-overhaul/
- Cloud Imperium Games, "Server Meshing and Persistent Streaming Q&A" (wiki mirror) - https://star-citizen.wiki/Comm-Link:18397/en
- Glenn Fiedler, "Snapshot Interpolation" - https://gafferongames.com/post/snapshot_interpolation/
- Gabriel Gambetta, "Client-Side Prediction and Server Reconciliation" - https://www.gabrielgambetta.com/client-side-prediction-server-reconciliation.html
- Railway, "Specs & Limits" - https://docs.railway.com/networking/public-networking/specs-and-limits
- Railway feedback, "Adding Inbound UDP" (2026-02-22, under review) - https://station.railway.com/feedback/adding-inbound-udp-fad19847
- Modal, "Web endpoints" and "Request timeouts" - https://modal.com/docs/guide/webhooks , https://modal.com/docs/guide/webhook-timeouts

Secondhand (search summaries, forums, hosting guides):

- Kerbal forum threads on multiplayer time warp and KSP 2 multiplayer (fetch blocked) -
  https://forum.kerbalspaceprogram.com/topic/75753-multiplayer-time-warp-theory ,
  https://forum.kerbalspaceprogram.com/topic/187358-ksp-2-multiplayer-discussion-thread/
- PC Gamer coverage of KSP 2 multiplayer - https://www.pcgamer.com/kerbal-space-program-2-is-going-to-let-you-have-competitive-multiplayer-space-races
- EVE University wiki, Time Dilation - https://wiki.eveuniversity.org/Time_Dilation
- Valve Developer Community, Source Multiplayer Networking and Lag Compensation -
  https://developer.valvesoftware.com/wiki/Source_Multiplayer_Networking ,
  https://developer.valvesoftware.com/wiki/Lag_Compensation
- Frontier forums on Elite Dangerous instancing - https://forums.frontier.co.uk/threads/how-do-instances-work.107002
- Space Engineers server guides (sync distance, trash removal) - https://low.ms/knowledgebase/space-engineers-server-configuration-guide
- WebTransport status: MDN - https://developer.mozilla.org/docs/Web/API/WebTransport ; WebRTC.ventures,
  "WebTransport is now Baseline" - https://webrtc.ventures/2026/04/webtransport-is-now-baseline-what-it-means-for-real-time-media/ ;
  Socket.IO on the Node WebTransport package - https://socket.io/get-started/webtransport

From memory, not re-read:

- Psyonix, "It IS Rocket Science! The Physics of Rocket League Detailed" (GDC 2018) - https://www.gdcvault.com/play/1024972/
- id Software's Quake 3 snapshot delta compression; GGPO rollback networking; SpaceX ISS docking simulator.
