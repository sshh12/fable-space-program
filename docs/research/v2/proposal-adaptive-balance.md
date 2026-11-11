# Proposal: adaptive balance (multiplayer core, v2)

Design proposal for the multiplayer core of the expanded game. Design only: nothing here is built, no
existing file was edited, no cloud resource was created. Inputs read in full: `PROMPT.txt` (including
everything below `--- expansion ---`), `docs/research/v2/*.md` (user-decisions, codebase-audit,
multiplayer-prior-art, hosting, solar-system, fleet-docking, frontend-ux), `docs/ARCHITECTURE.md` sections
5 and 6, and the contracts `sim.ts`, `controls.ts`, `simInternal.ts`.

**Stance.** The balance between client, server and burst compute is not chosen once. It moves with the
situation: a craft alone in deep space costs the server almost nothing, craft near each other are simulated
together on the server at full rate, heavy planning runs wherever it is cheapest, and elastic compute absorbs
spikes.

**How numbers are marked.** *measured* = from `codebase-audit.md` or `frontend-ux.md` (one Ryzen 9950X3D
core, Node 24). *derived* = arithmetic on measured numbers and provider list prices. *assumed* = a planning
value that the load test of section 10 must replace. The cloud derating used throughout is **2.5x** (one
Railway vCPU taken as 0.4 of the measured desktop core); it is *assumed*, never measured.

---

## 0. The design in one page

1. **Authority never leaves the server. What moves is who on the server holds it, how far behind real time
   the server may simulate, and how often it tells anyone.** Every vessel has exactly one authority holder
   at any instant: the **ledger** (a directory of analytic worldlines), an **island** (a small simulated
   world on a shard), or a leased **burst job**. Clients predict; they never commit.
2. **One dial per vessel: commit lag `L`.** The server always simulates every powered vessel itself, step
   for step, from the pilot's time-stamped inputs. For a vessel nobody else can reach, the server is allowed
   to run that simulation up to `L` seconds behind the pilot (in batches, on whatever core is free, or on
   burst compute) and to send 2 corrections a second instead of 30. The moment another owner's vessel can be
   reached, `L` is drained to zero and the island runs in real time. The client does the same thing in both
   cases, so the hand-over is invisible to it.
3. **Six zones** (section 2): Z0 ledger (free), Z1 cruise (closed-form clock, free), Z2 solo flight
   (trailing lane), Z3 shared flight (real-time lane, 30 Hz), Z4 contact (60 Hz, server-only outcomes),
   Z5 unattended run (fast-forward or burst).
4. **Time model** (section 3): per-vessel head time, forward only; one wall-anchored **live clock** where
   everybody spawns; private warp on private clocks; shared clocks by consent; two free moves for coasting
   craft, **jump** (whoever is behind) and **hold** (whoever is ahead); interaction only on one clock or with
   a passive vessel inside its **solid window**.
5. **Why not "client simulates, server audits a sample".** Measured cost makes it pointless: verifying every
   step of 5,000 simultaneous ascents costs about 25 vCPU, about $0.70 an hour (*derived*). Sampling would
   save a few dollars on the busiest day and open a forgery window. The saving worth having is not
   CPU-seconds; it is **deadlines and send rate**: a lagged island needs no real-time headroom (85 % core
   utilisation against 50 %) and a tenth of the egress.
6. **Numbers at a glance** (*derived* from measured step costs with the 2.5x derating; section 4):

   | | Server CPU per player | Downstream per player | Sim / send rate |
   |---|---|---|---|
   | Z0 parked, logged out | 0 | 0 | none |
   | Z1 coasting, warping, landed | 0.0006 vCPU (socket only) | 0.25 kB/s | closed form / on change |
   | Z2 burn, ascent, entry, alone | 0.004-0.006 vCPU | 0.4 kB/s deep space, 1.9 kB/s at a busy pad | 120 Hz lagged / 2-5 Hz |
   | Z3 near another owner's craft | 0.006-0.02 vCPU | 3.5-6 kB/s | 120 Hz real time / 30 Hz |
   | Z4 contact, soft capture | 0.02-0.035 vCPU | 6-7 kB/s for seconds | 480 Hz sub-steps / 60 Hz |
   | Average, normal mix | 0.0042 vCPU | 1.2 kB/s | |
   | Average, launch-day mix | 0.0065 vCPU | 2.1 kB/s | |

7. **Cost** (section 8): about $60 a month at 20 concurrent players, about $400 at 500 (upper bound $700
   with the hosting research's pessimistic assumptions), about $3,400-3,700 at 5,000 held all month (upper
   bound $7,600); a one-day spike to 5,000 adds about $125 (upper bound $250).
8. **Single-player-style flying is the same code path**: an island of one in the trailing lane. The
   Earth-Moon-return proof runs against an in-process universe (`LocalSession`) with the same orchestrator
   the servers run.

---

## 1. Vocabulary

| Term | Meaning |
|---|---|
| UT | Universe time, seconds since J2000, one axis for everything. |
| Live clock | `UT_live = liveEpochUt + (wall - liveEpochWall)`. Computed, never stored, never paused. |
| Head | The latest UT at which a vessel's state is committed. History before it is immutable. Never decreases. |
| Horizon | The UT up to which a passive vessel's future is analytic: its next atmosphere entry or impact, else +infinity. |
| Lead | Head minus `UT_live`. |
| Attended | A connected player sits in the vessel. **Passive**: nobody does, and it is on rails or at rest. |
| Clock | A server object `{ ut0, wall0, rate }`. Every attended vessel is on exactly one. |
| Island | Vessels that could touch within seconds: one integrator, one clock, one frame, one step loop (the term of `fleet-docking.md`). An island of one is a vessel flying alone. |
| Party | Players who linked on purpose and share a clock at any distance. |
| Ledger | The directory of all vessels: owner, head, horizon, worldline segments, saved state, expiry. |
| Solid | Can be touched: collided with, docked to, targeted for contact. Everything else is an **echo**. |
| Recorded echo | Drawing of a vessel at the viewer's time taken from its committed history (it is ahead). |
| Projected echo | Drawing of a vessel at the viewer's time from a forecast of its coast (it is behind, or beyond its window). |
| Lane | The schedule on which the server simulates an island: real-time, trailing, or deferred. |
| Commit lag `L` | Wall-clock distance between the pilot's latest input tick and the server's latest simulated tick. |
| Quiescent | On rails or at rest, no thrust, no contact, no atmosphere: state is a pure function of time. |
| Reach time `tau` | Lower bound on the time before two same-clock vessels could touch: `(distance - 1 km) / closing` with worst-case mutual acceleration of 60 m/s^2 included. |

Three invariants carry every consistency argument below:

- **I1. One holder.** Each vessel has one authority holder, recorded in the ledger with an epoch number.
  Hand-over is serialise at a tick, receiver acknowledges, ledger flips the pointer and increments the epoch.
  Writes carrying an old epoch are rejected.
- **I2. Forward only.** Heads never decrease. Nothing committed is ever recomputed.
- **I3. One loop per interaction.** Two vessels exchange force, propellant, crew or control only inside one
  island, which means one clock and one step loop on one thread.

---

## 2. Zones, lanes and hand-overs

### 2.1 Zones

| Zone | Situation | Authority holder | Server work | Client work | Server to client |
|---|---|---|---|---|---|
| **Z0 Ledger** | Passive vessel: parked, landed, logged out, debris on a stable orbit | Ledger | None between events. One timer per scheduled event (SOI change, horizon, expiry). Conjunction screening when an orbit changes | Kepler evaluation at the viewer's time (140-180 ns, *measured*) | One segment message when the orbit changes |
| **Z1 Cruise** | Attended, quiescent, no solid vessel inside reach: coasting, rails warp at any rate, landed | Ledger, with a clock | None per tick: `ut(wall) = ut0 + rate x (wall - wall0)`, clamped at the next event. Timer per event | Kepler evaluation, own patches, map | Clock message on change; census deltas |
| **Z2 Solo flight** | Attended, integrating, and every vessel in the island belongs to one owner (the craft and its own spent stages): ascent, burns, entry, landing | Island on a shard, **trailing lane** | Every 1/120 s step from the pilot's stamped inputs, in batches, `L` up to 2 s; up to 30 s in the deferred lane | Full prediction of own island at 120 Hz | Checkpoint 2 Hz (5 Hz when neighbours are in view) |
| **Z3 Shared flight** | Island with vessels of two or more owners, attended or not (includes a claimed station) | Island on a shard, **real-time lane** | 120 Hz in real time, vessel-vessel contact pass, `L = 0` | Prediction of the whole island with rewind and replay | Snapshot 30 Hz (20 Hz above 6 vessels) |
| **Z4 Contact** | Inside Z3: any pair within 2 s of touching, in contact, or in soft capture | Same island, pair flagged | 480 Hz contact sub-steps; capture, damage and merge decided here only | Predicts forces, never outcomes | The pair at 60 Hz; events reliable |
| **Z5 Unattended run** | Not quiescent and nobody aboard: a craft whose pilot left mid-flight, debris falling at the pad | Island, trailing or deferred lane, or a burst job | Full fidelity for craft, reduced tier (0.35 us per 0.5 s step, *measured*) for debris; faster than real time unless it is on the live clock | None | 1 Hz to anyone watching |

Zone membership is decided by the server from three facts it already has: is somebody aboard, is the vessel
quiescent, and whose vessels are inside reach on the same clock. It is re-evaluated every control tick
(30 Hz) for islands and on events for the ledger.

### 2.2 Lanes: the lag dial

All three lanes run the identical step loop on the identical inputs. They differ only in when.

| Lane | When the server steps tick `k` | Core utilisation target | Used for |
|---|---|---|---|
| Real-time | At `wall(k)`, with a 2-tick input buffer | 50 % (deadline every 8.33 ms; touchdown p99 is 244 us *measured*) | Z3, Z4 |
| Trailing | Any time before `wall(k) + L`, in batches of 30-240 ticks | 85 % | Z2, Z5 on the live clock |
| Deferred | Any time before `wall(k) + 30 s`, as a batch job on the shard's idle workers or a Modal worker | whatever is free | Z5 fast-forward; Z2 with nothing solid in its whole sphere of influence, only when a shard is hot |

Rules for `L`:

- `L <= min(L_cap, tau / 20)` and `L = 0` once `tau <= 4 s`, where `tau` is the smallest reach time to any
  solid vessel on the same clock. `L_cap` is 2 s on a shard, 30 s in the deferred lane.
- The scheduler on each shard worker runs real-time islands first, then trailing islands in order of largest
  lag. Under load, lag grows first (free and invisible), then the island's clock rate is capped below 1
  (time dilation, visible, announced), then new spawns queue.
- **The input acceptance deadline does not depend on `L`.** An input stamped for tick `k` must arrive within
  250 ms plus the measured round trip of `wall(k)`, or it is re-stamped to the arrival tick. Lag therefore
  gives a modified client no rewind window, and the server never accepts a stamped tick beyond
  `clock(wall) + 0.25 s`, so it gives no speed-up either.
- Catch-up is fast: one ascent stack replays at about 230x real time on a cloud vCPU (36 us per world step,
  *derived* from 14.4 us *measured*). A 2 s lag drains in 9 ms, a 30 s lag in 130 ms.

Why the trailing lane is better than real time for a pilot alone, not merely cheaper:

- The server applies each input at exactly the tick the client applied it, so client and server run the same
  input sequence. The only divergence left is last-bit differences in `Math.sin` and friends between Chrome
  and Node (*measured*: 1-2 ulp on 0.02-18 % of calls), which corrections at 2 Hz keep below a millimetre.
  Under real time, any input that arrives later than the buffer is applied late and costs a visible replay.
- A terrain tile that is not yet resident on the shard stalls only that island's lagged simulation; the
  pilot keeps flying on prediction. The v1 await protocol (`terrainPending`) becomes "lag grows for a moment".

### 2.3 Hand-overs

| From, to | Trigger | Mechanism | Why nothing jumps |
|---|---|---|---|
| Z0 to Z1 (attach) | A player resumes a ship | Ledger creates a clock at the attach time (section 3.6) and sends the segment | Rails state is a pure function of time on both sides |
| Z1 to Z2 | Throttle, RCS, atmosphere entry, ground contact | Ledger hands the saved state at the next tick of the clock's 1/120 s grid to a shard; an island of one is created (materialise: 0.25 ms *measured*). The client started predicting at the same grid tick | Rails and integration use the same point-mass gravity, so the switch is exact (ARCHITECTURE section 6) |
| Z2 to Z1 | Quiescent for 1 s | Island sends `toRails` with the conic through its state at tick `k`; ledger appends the segment; shard frees the vessel (375 kB of heap *measured*) | The client replaces its own conic with the server's; the difference is the accumulated prediction error, blended over 200 ms |
| Z2 to Z3 (islands merge) | Another owner's vessel on the same clock comes within `1 km + 2 s x closing speed`, or a passive vessel inside its solid window does (a claim) | Both islands are drained to the same tick of the shared grid (`L` was already 0 from `tau <= 4 s`), moved by value onto one worker, ordered by vessel id, re-anchored to one reference orbit | From `tau <= 60 s` the neighbour was already streamed at 10 Hz with its inputs and drawn extrapolated to the present, so no pose changes when prediction takes over |
| Z3 to Z4 and back | Pair within 2 s of contact, in contact, or captured | A flag; send rate for the pair doubles; friction anchors join the snapshot | Same loop, same tick |
| Z3 to Z2 (islands split) | Separation above twice the join distance and opening | Vessels are partitioned by owner into islands; lag is allowed to grow again | The client's prediction of its own vessel never stopped |
| Z1/Z2/Z3 to Z5 (detach) | Disconnect grace expired, or logout, while not quiescent | Throttle closed; the island continues without a pilot (section 3.6) | Outcome is the same simulation, only without inputs |
| Any island, shard to shard | Shard hot, deploy drain, rebalancing | Serialise at tick `k` (vessel state 22 kB JSON-equivalent *measured*; binary about 8 kB *assumed*), transfer over the private network, rebuild, ledger flips the holder. Gateways buffer the inputs in flight | The gateway holds the socket, so the client never reconnects; solo islands hide the 2-5 ms inside their lag; shared islands migrate only outside Z4 |
| Island to burst job and back | Deferred lane | A lease: `{ state, input chunk, tick range }` out, `{ state, events, hash }` back; the holder is the job until it returns or the lease times out (then the shard recomputes) | Same runtime image, so the result is bit-identical to what the shard would have computed (*measured*: identical hashes within one runtime) |

What makes these hand-overs consistent rather than merely smooth:

1. **State crosses whole.** The codec carries the complete dynamic state, including what `Vessel.struct`
   holds today (friction anchors, thermal wake factors), the `Infinity` sentinels and the sign of zero. The
   audit measured 7-19 mm of drift when that state is dropped; section 9 moves it into the vessel proper.
2. **A common tick grid per clock.** Every island on one clock steps at `clock.gridUt + n / 120`. A vessel
   leaves rails at a grid tick (exact Kepler evaluation at that instant), so two islands that merge already
   share step times.
3. **Step order is by vessel id**, not by arrival, so the result of a merged island does not depend on which
   shard built it.
4. **A group changes frame together.** An island crosses a sphere-of-influence boundary as a unit at its
   anchor's crossing tick, and integrates relative to a reference orbit when it is in the Sun's sphere of
   influence (section 6.2), so no pair is ever differenced through a heliocentric position.
5. **Irreversible events carry `(vessel, epoch, tick)`** and are idempotent. A stale holder cannot emit one.

---

## 3. The time model

Per-vessel head time with a causality rule, shared clocks by consent, and a live clock that gathers players
(models C + D + live clock of `multiplayer-prior-art.md` section 5), completed here with five additions: the
solid window, hold, the meeting time, the pad timetable, and the unattended-fate rule.

### 3.1 Rules

- **T1. One time axis, many worldlines.** There is one universe. Every vessel has a head and an immutable
  history before it (I2).
- **T2. Live clock.** Default spawn time, the time of the menu's Earth, the time of the launch-site crowd. It
  runs at one second per wall second for ever, including while servers are down.
- **T3. Clocks.** An attended vessel is on exactly one clock. Three kinds: the **live clock** (rate 1, nobody
  can change it); a **private clock** (one player's island or cruising vessel; that player sets the rate); a
  **shared clock** (an island with two or more pilots, or a party; rate by consent). A passive vessel is on
  no clock.
- **T4. Solid window.** For a viewer whose clock reads `t`, a vessel is solid when it is on the viewer's
  clock, or when it is passive and `head <= t <= min(horizon, limit)`. `limit` is +infinity for the viewer's
  own vessels, party members' vessels, unowned vessels and debris; for anyone else's vessel it is
  `max(head, UT_live) + advanceLimit`, where `advanceLimit` is the owner's setting (default 7 days for
  ships, 30 days for assemblies marked public, "unlimited" selectable). Everything else is an echo.
- **T5. Claim.** When a vessel on a clock comes within reach of a passive vessel inside its solid window, the
  server brings the passive vessel into that island; its head becomes the island's time. The ledger is the
  single place where competing claims are ordered.
- **T6. Rate.** A private clock may run at any level the existing limits allow (altitude limits per body,
  event look-ahead, 1-4x while integrating). A shared clock runs at the lowest rate any member requests or
  is limited to. A "warp to UT" on a shared clock is a proposal with a 15 s ready-check; a member who does
  not answer stops blocking after the timeout when their vessel is quiescent and outside contact range.
- **T7. Hold and jump.** A clock whose vessels are all quiescent may **jump** to any later UT (rails warp
  done at once) or **hold** (rate 0: the player stays seated while the vessel is, for every purpose,
  passive). A jump is refused if the interval contains the horizon, an encounter with a solid vessel (T11),
  or would exceed the lead cap (T16).
- **T8. Leaving a shared situation.** A vessel may leave its island's clock alone (warp, jump or hold)
  when it is not in contact or soft capture and a screening of its coast against every solid vessel in
  reach shows no approach closer than `200 m + 3 x (Ra + Rb)` in the next 120 s of UT. If another pilot is
  inside the island, a 10 s departure notice is shown to them; it cannot be vetoed, and the departure is
  cancelled if the screening stops holding. To the pilots left behind, the departed vessel becomes a
  recorded echo that continues along the coast it committed.
- **T9. Joining a clock ("sync").** A quiescent vessel may join another clock whose time is not earlier than
  its own head: it jumps to that time and subscribes. Refused while its propagated position at that time is
  within 2 km of a vessel on the target clock or closing to within 1 km in 30 s; the HUD says how long until
  the geometry clears.
- **T10. Pulling a group forward.** A player who is ahead of an occupied island may ask it to advance to
  their time. Granted when every vessel in it is quiescent, the server's screening finds no encounter in the
  interval, and every connected pilot in it accepts within 15 s. While a request is open the island accepts
  no new approaches, so the wait is bounded.
- **T11. Encounter look-ahead.** Predicted approaches to solid vessels are events in the existing warp
  look-ahead (`nextWarpEvent`). Rails warp steps down so that the clock is at 1x before the island join
  distance is reached; a jump stops there. Passing craft at orbital closing speed are therefore integrated,
  with swept tests (section 6.3).
- **T12. Sphere-of-influence changes** are processed per vessel at the exact crossing UT, as in v1. A shared
  clock clamps to the earliest event of any member. An island crosses as a unit.
- **T13. Burns** run on the vessel's own clock at 1x, or 2-4x physics warp on a private clock or by consent
  on a shared one.
- **T14. Spawn and the pad timetable.** A spawn is a pad and a UT. Each pad has one timetable in UT; a slot
  is `[t, t + dwell]` and slots never overlap. The default is `UT_live`. The menu also offers the next free
  slot, the next launch window to a chosen target ("plane crossing in 46 min"), and a friend's clock. A
  future slot must lie at least `maxPadDwell + safing` (8 minutes) after `UT_live`, so nothing that stands on
  the pad now can still be there. No rails warp on a pad.
- **T15. Launch-range rule.** Inside the controlled airspace of a site (150 km, below 100 km altitude) the
  clock cannot run faster than 1x. The launch crowd therefore stays on the live clock and stays solid to each
  other until it is clear of the range.
- **T16. Lead cap.** No head may exceed `UT_live + 100 years`. This keeps `ut` below 2^32 s, where float64
  still resolves 0.5 us (*measured* in the audit; about six real years of margin from the 2029 epoch), and inside the span the ephemeris tool validates. Reaching
  the cap refuses further warp with a plain message; hold is always available.
- **T17. Unattended fate.** A passive vessel whose horizon is finite is drawn beyond that horizon as a
  projected echo labelled "fate pending". It is resolved (integrated without a pilot, section 3.6) when its
  owner has not flown it by the time `UT_live` reaches the horizon. Debris without a command part is resolved
  at once.
- **T18. Expiry** runs on the wall clock (section 7.5). It is the only clock all vessels share.

Default values of every number above live in the `UniverseRules` document (section 7.6).

### 3.2 What players at different times see

Planets, moons, the Sun, lighting and site daylight: each client evaluates them at its own clock. Two players
at different times see different configurations, and both are right. The menu shows `UT_live`.

| The other vessel is | behind me | on my clock | ahead of me |
|---|---|---|---|
| **passive, inside its solid window** | Solid, evaluated at my time. If I reach it, it is claimed (T5) | (a passive vessel is on no clock) | Recorded echo; I can jump to its head or later |
| **passive, outside its window** (beyond horizon or `advanceLimit`) | Projected echo, "fate pending" or "not available this far ahead" | | |
| **attended** | Projected echo of its coast from now, updated when its pilot manoeuvres. Its pilot can jump to me or I can hold | Live and solid | Recorded echo. I can jump to it, or it can hold for me |

Every name on screen that is not on the viewer's clock carries its offset ("+3 h 26 m") and the one action
that would make it reachable. Echoes are dashed and never collide. The map has a read-only "view at this
vessel's time" control.

This fills the `TimeView` of `frontend-ux.md` section 7.6 directly: `relation` is `synced` (on the live
clock), `ahead`, `behind`, or `catchingUp` (an island that fell behind through dilation or a crash and is
allowed 1.1x until it is back); `syncAction` is `jump`, `hold` or `ask to advance`; `group` is the shared
clock's member list; `limitedBy` is the reason from T6, T8, T11, T15 or T16.

### 3.3 Arranging and flying a rendezvous

Three patterns cover every case. In all of them the planner works on the target's worldline as a function of
time: committed segments up to its head, coast forecast after it, with the boundary marked on the map.

1. **Target is passive** (a parked ship, an empty station). Target it. If its head is ahead of me, the target
   card offers JUMP to shortly before its head; jump first, then plan, because a 1 m difference in
   semi-major axis becomes about 160 km over three years (prior-art fact 3). Plan the intercept on the
   client, warp privately, T11 brings me to 1x before the join distance, T5 makes the target solid in my
   island, and I fly the approach in Z3.
2. **Target is another pilot: meet at a time.** Either player presses MEET on the other's target card and
   picks a UT not earlier than both heads (the planner suggests the earliest time at which phasing can be
   complete). Both get a "warp to" marker. Each flies and warps privately to that UT, which costs the server
   nothing and holds nobody back. On arrival both clocks read the same time; LINK makes one shared clock, and
   the last phasing burns and the approach are flown together.
3. **Target is another pilot: now.** Whoever is behind jumps (T9), or whoever is ahead holds (T7) or asks the
   other group to advance (T10). Then LINK. On the shared clock the chaser burns while the target coasts;
   warp between burns is a ready-check (T6). Either may unlink and go ahead; the other jumps afterwards.

Arriving ahead of a crewed station (someone back from the Moon is six to eight days ahead of the live clock):
the station is a projected echo. Choices shown: HOLD until it arrives (only sensible for a small offset),
ASK TO ADVANCE (T10: its crew accept with one key), or park and log out; a parked ship is passive, and when
its owner returns it is attached at the live clock (section 3.6), which by then has caught up.

Execution inside reach is ordinary flying: target-relative navball, the docking instrument, Z3 then Z4.

### 3.4 Entering and leaving warp

| Situation | Rule |
|---|---|
| Alone, quiescent | Any permitted rate, at once. Private clock; nobody is asked |
| Alone, burning or in atmosphere | 1-4x physics warp |
| On the live clock near the pad | 1x inside the range (T15). Above it, warping forks a private clock |
| In an island with other pilots | Rate change is a proposal (T6). Leaving alone follows T8: 10 s notice, no veto, refused only on a predicted approach inside 120 s |
| In contact or soft capture | No rate change and no departure until released |
| Docked | One vessel, one clock. The helm proposes; crew accept; an absent crew member never blocks (T6 timeout) |
| Approaching a solid vessel under warp | T11 lowers the rate ahead of the encounter; the HUD names the vessel |
| Dropping out of warp, ending a jump, joining a clock | Arrival is refused within 2 km of anything on the destination clock (T9), so nothing materialises inside another ship |
| Near a passive vessel | Nothing special: it is solid at every time in its window, so T11 applies |
| Sphere-of-influence change ahead | The clock clamps to the crossing, then continues at the requested rate if still permitted |

Nobody can be held hostage: the only things that stop a solo departure are physical contact and an imminent
approach. Nobody can dodge a collision by changing time: T8 screens the next 120 s, and T11 forces 1x before
any encounter.

### 3.5 During burns and at sphere-of-influence changes

- A burn belongs to the vessel's clock. In Z2 nobody else is affected. In a party at distance, friends who do
  not want to wait at 1x unlink and go ahead; the burner jumps to them afterwards and arrives where their map
  already showed its projected echo.
- A long nuclear burn (the cruiser's departure is about 20 minutes) is flown at up to 4x on a private clock.
- Events are exact per vessel. An island (Z3) uses its anchor's crossing tick for all members, so two craft
  100 m apart are never under two gravity models and never converted to a new frame at different instants.

### 3.6 Attach, logout and disconnect

- **Attach time.** A player resuming a passive vessel is attached at `max(head, UT_live)` when the vessel can
  be jumped there (no horizon in between), else at its head. Other choices offered: a party's clock, or a
  target's head. Leads therefore shrink by themselves while a player is away.
- **Disconnect.** Solo and on rails: the clock holds at once; nothing is lost. Integrating: the last inputs
  stay latched for 5 s, then the throttle closes and SAS keeps its mode; the vessel keeps flying at 1x for a
  60 s grace period so a dropped connection costs nothing more. In an island with other pilots it simply
  stays in the island.
- **After the grace period, or on an explicit logout.** Quiescent: the vessel becomes passive at its head
  (Z0). Otherwise Z5 takes it to rest: a private-clock vessel is simulated without a pilot as fast as compute
  allows until it is on a stable orbit, at rest, or destroyed, and that history is committed; a live-clock
  vessel does the same in real time, because the launch crowd may meet it. The flight menu's "if you leave
  now" line is computed from exactly this rule.
- A disconnect never removes a vessel from an island during contact.

### 3.7 Persistence and the clocks used for cleanup

A vessel's persistent identity is its ledger record (section 7). Time enters persistence in exactly two
places: the head and segments (UT), and the expiry stamps (wall clock). No other clock exists, and universe
time is never used to decide lifetime, because two vessels can differ by a century.

### 3.8 Paradoxes and how each is excluded

| Paradox | Exclusion |
|---|---|
| Changing something's past | History before a head is immutable (T1); recorded echoes are not solid (T4) |
| Touching a future its pilot has not flown | Attended-and-behind vessels are projected echoes (T4) |
| Foreclosing an absent owner's options far ahead | `advanceLimit` in the solid window (T4): a stranger a year ahead cannot drag a ship there |
| Two players at different times take the same passive vessel | Claims are ordered by the ledger; the head moves once; the loser sees an echo (T5) |
| Leaving a collision course by changing time | T8 screening and T11 look-ahead |
| Appearing inside another vessel | T9 arrival separation |
| A vessel existing twice or vanishing | One ledger record, one holder, fenced by epoch (I1); clients never own state |
| A pad used by two rockets | One timetable per pad in UT (T14) |
| A lagged solo island missing an interaction | `L <= tau / 20` and `L = 0` at `tau <= 4 s`: both islands are at the same tick before the join distance (2 s of closing) can be crossed |
| A decaying parked ship seen "already crashed" by someone ahead, then saved by its owner | Beyond the horizon it is a projected echo, never history, until T17 resolves it |
| Time running backwards after a crash | Recovery replays the journal to the last durable tick and resumes there; the island is then behind and catches up (section 7.4). Nothing after that tick was ever committed to another holder, because every hand-over is a synchronous ledger write |
| An object launched "in the past" that should have hit a history already committed | **Not excluded.** Only interactions at head times are physical. It needs a metre-scale coincidence in space and nobody can witness it |

### 3.9 Why this is the most fun workable model

- A solo player keeps everything single-player KSP gives: instant warp to 10,000,000x, no waiting on anyone,
  and (in Z2) no input latency at all.
- The launch site is a shared place by construction: everyone spawns on the live clock and the range rule
  keeps them on it while they can see each other.
- Meeting someone is one of two free actions (jump or hold), and the meet-at-a-time pattern lets both players
  travel at their own pace and still arrive in the same present.
- Nobody else's warp can touch a burn in progress, and nobody can be pinned at 1x by a stranger.
- The alternatives fail the brief: one clock makes Mars eight months away; unconstrained subspaces leave
  stale ships and docking explosions; hubs pinned to the live clock make a Moon returnee wait six days;
  timeline repair teleports ships.
- The price is honest and small: an offset next to each name, echoes that cannot be touched, and one sentence
  to learn: *you can only touch what is at your time, and you can only move forward.*

---

## 4. Authority and compute split, per situation, with numbers

### 4.1 Authority

The server alone commits: every worldline segment, every claim, every contact outcome, every structural
change, every persisted byte. Three server components can hold a vessel (I1): the ledger, an island, a burst
job. A client holds nothing. What a client sends is limited to stamped control inputs, discrete commands, and
clock requests; it never sends state, a conic, or a result.

The per-vessel `authority` hook that `fleet-docking.md` section 4.9 asks for is the ledger's `holder` field.
A value meaning "client-simulated, sampled audit" is deliberately not defined: section 4.5 gives the numbers.

### 4.2 Measured step costs and the planning figures derived from them

| Regime (*measured*, us per vessel-step, desktop core) | desktop | cloud vCPU (x2.5, *assumed*) | CPU per vessel-second at 120 Hz |
|---|---|---|---|
| Pad ascent, full stack, world step including clamps | 14.4 | 36 | 4.3 ms = 0.43 % vCPU |
| Vacuum burn | 4.9 (+4 orchestration) | 22 | 2.7 ms = 0.27 % |
| Coasting but integrated, proximity operations | 2.6-2.9 (+4) | 17 | 2.0 ms = 0.20 % |
| Capsule entry | 3.2 (+4) | 18 | 2.2 ms = 0.22 % |
| Touchdown, first 3 s | 45, p99 244 | 112, p99 610 | 13 ms = 1.3 % |
| Vessel-vessel narrow phase, two 9-part craft | 14-24 per pair | 35-60 | 4-7 ms = 0.4-0.7 % per close pair at 120 Hz |
| Contact pass at arm's length, two 40-part craft (*estimate* of `fleet-docking.md` 4.7) | under 100 | under 250 | up to 30 ms = 3 % per pair, only inside 0.5 m |
| On rails | 0.15 per evaluation | 0.4 | 0 between events |
| Reduced-tier debris | 0.35 per 0.5 s step | 0.9 | 0.0002 % |

Planning figures (*derived*; the "+4 us" is the measured 3-5 us of orchestrator overhead per world step):

- Solo ascent with its spent stages: **0.005 vCPU**. Other solo powered flight: **0.003 vCPU**.
- A vessel in a shared island: **0.004 vCPU** flying apart, **0.02-0.035 vCPU** during final approach and
  contact.
- Encoding a compact island snapshot: 3-5 us per vessel per send on the desktop (*assumed*; the 35-42 us
  *measured* for a full `SimSnapshot` is not paid on the server, see 4.4), about 0.0004 vCPU per vessel at
  30 Hz.
- Gateway: **0.002 vCPU** per connection at 30 messages a second each way (*assumed*, from `hosting.md`),
  0.0005 for a cruising player.
- Ledger: about 0.2 operations per player per second at 50-100 us each: 0.00005 vCPU.

`hosting.md` planned with 0.03 vCPU per integrated vessel, taken from the "about 0.1 ms per step" line of
ARCHITECTURE. The audit's measurement is 6 to 12 times lower. Both figures are carried in section 8: the
measured-and-derated one as the expectation, the older one as the upper bound, until the load test decides.

### 4.3 Per situation: who computes what, at what rate, for how much

| Situation | Server simulates | Server sends | Client simulates | Server CPU per player | Down per player |
|---|---|---|---|---|---|
| Logged out, ship parked (Z0) | nothing | nothing | - | 0 | 0 |
| Menu, not yet playing | nothing; one cached public snapshot for everyone | HTTP, cached 1 s, no socket | census replica | 0 | about 0.3 kB/s from the cache, not from a shard |
| Coasting, warping at any rate, landed (Z1) | nothing per tick; event timers; conjunction screening when the orbit changes (10-20 ms once, *derived*) | clock on change; census deltas | Kepler, own patches | 0.0006 vCPU | 0.25 kB/s |
| Burning or ascending alone in deep space or far from others (Z2) | every step, lagged up to 2 s, batched | 2 Hz checkpoint (about 135 B framed) | own island at 120 Hz | 0.003-0.005 | 0.4 kB/s |
| Ascending from a busy launch site (Z2, neighbours in view) | every step, lag held under 0.25 s | 5 Hz frame: own checkpoint plus up to 8 neighbours | own island; neighbours extrapolated | 0.005-0.006 | 1.9 kB/s |
| Rendezvous, proximity operations, docked flight with another owner's craft (Z3) | every step in real time; contact pass | 30 Hz island snapshot, delta against a 1 s keyframe | whole island with replay | 0.006-0.02 | 3.5 kB/s (2 vessels) to 6 kB/s (10 vessels at 20 Hz) |
| Contact, soft capture, collision (Z4) | 480 Hz sub-steps; outcomes | the pair at 60 Hz; events | forces only | 0.02-0.035 | 6-7 kB/s for the seconds it lasts |
| Pilot left mid-flight (Z5) | to rest, faster than real time, any free core or burst | 1 Hz to watchers | - | a one-off 0.1-0.4 CPU-seconds | 0 |
| Flying to the Moon and back alone (the v1 mission) | Z2 for about 25 minutes of powered and atmospheric flight, Z1 for the rest | as above | as v1 | under 8 CPU-seconds for the whole mission (*derived*) | about 1 MB for the whole mission |

Weighted averages (*assumed* mixes: normal = 55 % Z1, 30 % Z2, 12 % Z3, 3 % Z4; launch day = 15 % Z1, 70 %
Z2 at the pad, 13 % Z3, 2 % Z4):

| Mix | Server CPU per player | Down per player | Up per player |
|---|---|---|---|
| Normal | 0.0042 vCPU | 1.2 kB/s | 0.3 kB/s |
| Launch day | 0.0065 vCPU | 2.1 kB/s | 0.5 kB/s |

Bandwidth is dominated by message count, not payload. Each WebSocket message carries roughly 40-70 bytes of
framing, TLS and TCP/IP overhead (*assumed*; what Railway meters is one of the things to measure), so a 30 Hz
stream costs about 2 kB/s before any payload. That is why the send rate, 2 Hz against 30 Hz, is the lever the
lag dial pulls. At $0.05 per GB, 1 kB/s per player is $0.13 per player-month.

### 4.4 Work that never runs on the server

`SimSnapshot` stays the presentation contract and is built on the client from replicated vessel state:
bodies (functions of UT), readouts, navball, staging delta-v, predicted patches, maneuver nodes, burn
bookkeeping, closest approaches to one target, the proximity plot. The audit measured these at 35-42 us per
snapshot and 27-140 us per patch prediction, which is more than stepping the vessel; all are pure functions
that already run in the browser. Planning commands (`addNode`, `setNode`, `removeNode`, `setTarget`,
`setNavballMode`) become client-local; the only authoritative trace of a node is the SAS hold direction, which
travels with the inputs as a plain vector, as the world already passes it to the vessel.

### 4.5 Why not client-simulated solo flight with sampled audits

| | Trailing lane (this proposal) | Client simulates, server audits a sample |
|---|---|---|
| Server CPU, 5,000 simultaneous ascents | 25 vCPU, $0.70 an hour (*derived*) | 2.5-6 vCPU at 10-25 % sampling |
| Saving on a launch day | - | under $15 |
| Forgery | Impossible: only inputs are accepted | Possible until a sample lands on it; needs a tolerance, because Chrome and Node differ in the last bit (*measured*) and a bit-exact check would accuse honest players |
| State before interaction | Already the server's own | Must be re-verified before every claim, dock or save |
| Mechanisms to build | One step loop, three schedules | A second trust path, a tolerance model, a penalty model |

The lag dial keeps what was attractive in the audited-client idea (no round trip for solo flight, no
real-time deadline, burst-friendly) and drops its risk.

### 4.6 Planning work: wherever it is cheapest

| Work | Cost (*measured* unless marked) | Placement rule | Runs on |
|---|---|---|---|
| Own trajectory, node dragging | 27-140 us per prediction | Always local: it must follow the mouse | Client main thread |
| Heliocentric prediction with planet encounters | 5-20 ms (*estimate* of `solar-system.md`) | Local, off the main thread, on change only | Client worker |
| Closest approaches to one target, proximity plot | 0.7 ms and under 0.3 ms | Local at up to 30 Hz | Client worker |
| The same, on a weak client (CPU score from calibration below threshold) | 2 ms and more | Server returns them with the conjunction list | `plan` service |
| Icons for 10,000 objects | 1.4-2.6 ms per frame on the CPU | GPU compute above 500 objects | Client GPU |
| Conjunction screening, all against all in one sphere of influence | 10-20 ms per orbit change (*derived*) | Server: it is needed for authority anyway; clients subscribe to their own list | Ledger worker threads |
| Transfer-window grid (100 x 100 Lambert solves) | under 1 s | Same answer for everyone at a UT: compute once, cache at the edge | `plan` service, cached |
| Multi-revolution or moon-tour intercept search, seconds of CPU | (*assumed*) | Batch, no deadline | Modal |
| Deferred-lane batches, crash-recovery replays, nightly replay audits, bot fleets | 0.1-0.3 CPU-seconds per vessel-minute | Deterministic and retry-safe, so preemptible burst compute is the cheapest place: $0.0000066 per vCPU-second on Modal against $0.0000077 on Railway, and it scales to zero | Modal |

The chooser is a table lookup, not an optimiser: local when the estimate is under 50 ms or the link is down,
cache when the key exists, service otherwise.

### 4.7 Overload: the order in which things give way

1. Trailing islands' lag grows toward `L_cap`. Invisible.
2. The hot shard stops receiving new islands; solo islands migrate to cooler workers and shards (2-5 ms each).
3. Deferred-lane work (Z5, deep-space Z2) is leased to Modal workers.
4. A script raises the replica and shard count through the Railway API (no autoscaler exists; this takes a
   minute or two, which steps 1-3 cover).
5. Time dilation: the clocks of the affected islands are capped below 1x, solo islands first. Affected
   players fall behind the live clock, see `catchingUp`, and are allowed 1.1x afterwards.
6. Admission: new spawns queue; the menu keeps working without sockets.

Real-time islands are the last thing touched, and only by step 5.

---

## 5. Protocol

### 5.1 Transport and session

- **Binary WebSocket** to a gateway. Railway offers nothing else (no UDP, no WebTransport). Every high-rate
  message is idempotent and latest-wins, so the same messages could ride datagrams later.
- No `permessage-deflate`; payloads are already compact and deltas are bit-packed.
- One WebSocket message is a batch: `varint count`, then `{ u8 type, varint length, payload }` each.
  Little-endian. One hand-written codec module shared by client, gateway and shard (`src/net/codec`).
- Sessions: `hello { build, defsHash, protocol, cpuScore, resume? }`; the server answers with a nonce; the
  client signs it with the device key of `frontend-ux.md` F7; `welcome { sessionId, accountId, rulesVersion }`.
  A mismatched `defsHash` or sim build is refused before anything else (client prediction must run the same
  code as the server).
- Time sync: `timeSync` round trips with a minimum-round-trip filter give the client the server's wall clock
  to a few milliseconds. Clock messages are expressed in that time base.
- The menu holds no socket. It polls one public snapshot (census of the menu region, presence counts, feed)
  that the API serves with a one-second cache lifetime, so 50,000 visitors cost one computation a second.

### 5.2 Message types

Client to server:

| Message | Content | Notes |
|---|---|---|
| `input` | Changes of `ControlInputs`, each stamped with a 120 Hz tick of the island's clock, plus the SAS hold vector when it changed. Sent at 30 Hz; each message repeats the changes of the last 250 ms | Latest-wins; about 12-30 B of payload |
| `cmd` | `{ seq, tick, kind, args }`: stage, abort, SAS mode, RCS, legs, lights, arm or disarm a port, undock, control point, helm request or grant, lend policy, transfer, cross-feed, rename, renew, abandon | Reliable; acknowledged |
| `clock` | `{ seq, kind }`: set rate, warp to UT, hold, jump, sync to a clock, link, unlink, propose, vote, meet-at, ask to advance | Reliable; acknowledged with the reason when refused |
| `spawn`, `attach`, `detach` | Vehicle, pad, name, slot UT; or vessel id and attach choice | |
| `sub`, `target` | Census scopes (sphere of influence, categories); the current target, so the server streams it at a higher tier and sends its conjunction list | |
| `planSave` | Maneuver nodes and target, to be stored with the ship | Opaque to the simulation |
| `chat`, `quick`, `ping`, `timeSync` | | |

Server to client:

| Message | Content | Rate |
|---|---|---|
| `clock` | `{ clockId, ut0, wall0, rate, maxRate, limitedBy, members, proposals, relation, gridUt }` | On change |
| `islandKey` | Keyframe: island id, tick, reference orbit, structure version, full state of every vessel (structure, craft list, links, part state, pose). About 2-3 kB for a 42-part stack against 17 kB for its JSON snapshot (*measured*) | On join, on structural change, every 1 s |
| `islandDelta` | Tick, keyframe tick, last own input tick applied, groups per vessel (5.3) | Z3 30 Hz; Z4 60 Hz for the pair; Z2 2-5 Hz |
| `event` | A `SimEvent` with its tick, vessel and epoch | Reliable |
| `cmdAck` | `{ seq, ok, appliedTick, reason }` | Reliable |
| `toRails`, `segment` | A worldline segment: body, `r0`, `v0`, `t0`, start and end UT, kind (conic, at rest, sampled arc) | On change |
| `near` | Tier-B vessels: pose relative to their own osculating conic, throttle, thrust direction | 5 Hz; 10 Hz with inputs from `tau <= 60 s` |
| `censusKey`, `censusDelta` | Elements per object in the subscribed spheres of influence, valid for the viewer's clock (about 64 B each) | On change; 1 Hz for thrusting craft |
| `conj` | The viewer's conjunction list: partner, UT, miss distance, relative speed | On change |
| `pads`, `ships`, `presence`, `prompt`, `feed`, `chat`, `rules`, `notice` | View-model data of `frontend-ux.md` section 11 | On change or 1 Hz |

### 5.3 Snapshot and delta formats

All island state is relative to the island's **reference orbit**: a conic in the frame of the current
sphere-of-influence body through the anchor vessel's state at a reference tick. The receiver evaluates the
conic in float64 at the tick and adds the offset, so nothing on the wire is heliocentric and 100 ms of delay
is not 780 m of error. The reference is replaced (with a keyframe) when any offset passes 30 km, when the
anchor finishes a burn, or at a sphere-of-influence change.

| Group | Fields | Raw | Typical after delta coding |
|---|---|---|---|
| POSE | position 3 x i32 in 1/64 mm (range 33 km; a coarse flag gives 1 mm and 2,100 km); velocity 3 x i32 in um/s (coarse flag x16); attitude as the three smallest quaternion components, 3 x i32; angular velocity 3 x i32 in urad/s | 48 B | 16-22 B |
| CONTROL | throttle, applied pitch/yaw/roll/translation as i8, SAS mode, RCS and fine flags | 9 B | on change |
| PART-FAST | engine ignition and flame-out bits, gimbal, leg and chute state | 1-2 B per active part | on change |
| PART-SLOW | resource levels (u16 fraction per tank), part temperatures (u8) | 2-3 B per part | round-robin at 1 Hz |
| CONTACT (Z4 only) | per probe: friction anchor, contact flag; port state and capture progress | about 100 B | while flagged |
| STRUCT | part list, craft list, links, stage stacks, ids | 1-3 kB | keyframes only |

- A delta is always against the last **keyframe** (one a second), never against the previous delta, so the
  gateway may drop a queued delta when a newer one is ready (it watches the socket's buffered amount).
- The comparison tolerance on the client (0.2 mm, 0.2 mm/s, 2e-5 rad) is far above the quantisation
  (16 um, 1 um/s, 5e-10), so quantisation never triggers a correction and never enters the simulation unless
  a real correction happens.
- Typical sizes with framing: Z2 checkpoint 135 B; Z3 delta for two vessels about 120 B, for four about
  160 B, for ten about 290 B.

### 5.4 Interest management

Relevance has two axes, space and clock relation. The server never broadcasts an object every frame.

| Tier | Who | What | Rate |
|---|---|---|---|
| A | Vessels in my island | Full state, others' inputs, events | 30 Hz (60 Hz in Z4) |
| B | Same clock, within 200 km or with a visible plume; from `tau <= 60 s` "warm" | `near` states on their own conic; warm: with inputs | 5 Hz; warm 10 Hz |
| C | Solid for me in the subscribed spheres of influence (same clock, or passive in window) | Worldline segments; elements of thrusting craft | On change; 1 Hz |
| C-echo | Echoes of my target, my party, my own ships | The segment that covers my time, or the forecast, flagged | On change |
| D | Everything else, all other echoes | Directory rows: id, owner, body, head, coarse orbit, expiry | On demand, paged, counts otherwise |

- The census is parameterised by the viewer's clock. For a recorded echo the server can send the next segment
  boundary ahead of time, because committed history cannot change.
- Integrated arcs in a worldline (ascents, burns) are stored as 1 Hz samples for 24 wall hours and reduced
  to their end points afterwards; an old echo of a burn is drawn as a coarse arc.
- Fan-out is done by gateways: a shard encodes each island keyframe and delta once; the gateway forwards the
  bytes to the island's subscribers and assembles tier B to D per client from shard and ledger feeds.
- At very high warp (above 10,000x) census refresh is capped at 2 Hz and proximity logic is event-driven
  only; rails states are exact at any step.

### 5.5 Prediction and reconciliation

- The client runs its island with the same `src/sim` code at `clock(serverWall + lead)`, where `lead` is
  half the round trip plus a jitter margin plus two ticks, adapted from the server's "input arrived this
  early or late" feedback and capped at 250 ms. It keeps a ring of its inputs and of the island's dynamic
  state per tick (about 8 kB per vessel per tick, 0.5 s deep).
- Own inputs are applied locally at once. Other pilots' inputs in the island arrive with the snapshots and
  are assumed to persist (controls latch), so the client simulates every vessel it can touch.
- On each server state for tick `k`: if it matches the stored prediction within tolerance, nothing happens.
  Otherwise the client resets the island to the server state at `k` and replays its stored inputs to the
  present: at 150 ms round trip that is about 24 ticks, 0.4 ms for two vessels and 2 ms for ten (*derived*
  from 9 us per step). The visual error is removed over 100-200 ms in the vessel's own frame.
- What a misprediction of someone else's input costs: `a x dt^2 / 2`. For RCS translation (0.039 m/s^2) over
  150 ms that is 0.4 mm; for a main engine at 5 m/s^2 it is 6 cm. Docking happens with engines off.
- **Irreversible things.** In a shared island the client never shows destruction, joint breaks, explosions,
  capture, hard dock, undock or another craft's staging before the server's event; it rewinds to the event's
  tick, applies it and replays. It does predict contact forces and the soft-capture spring, which are
  reversible. In a solo island the client shows what its own simulation produces (staging, overheating,
  touchdown) at once, marked pending internally: the server runs the same inputs, so a disagreement needs a
  last-bit difference to straddle a threshold; if it ever happens the client resynchronises with a notice.
  This is the one deliberate departure from "always wait for the acknowledgement" in `frontend-ux.md` fact
  16, limited to a player's own craft flying alone. Spawned vessel ids are deterministic
  (`<craftId>~<root part>`), so predicted pieces keep their identity.
- Client and server never compare hashes; they compare state with a tolerance. Server against server (shard,
  burst job, replay audit) compares hashes, on one pinned Node build and one CPU architecture.

### 5.6 Lag handling for contact and docking

- Both craft of a contact are in one island on one thread (I3). Luna Multiplayer's docking failures came from
  two authorities; here there is one.
- Inputs take effect at the tick the pilot stamped. A pilot with a 250 ms round trip simply runs further
  ahead of the server than one with 40 ms; neither is disadvantaged at docking speeds.
- A late input (network stall, which over TCP can be 200 ms or more) is applied on arrival; the server tells
  the client the applied tick; the client replays. During the stall the server keeps the latched inputs,
  which is what the client assumed too.
- No lag compensation in the shooter sense exists or is needed: there are no instant-hit actions. Contact is
  judged in server time from simulated geometry, with continuous detection (section 6.3).
- Capture and hard dock are slow by design (0.5 s of residuals below threshold before hard dock; the capture
  envelope is two to three times wider than the real standard), so one round trip of event delay is hidden
  inside the latch animation and the lamp sequence.
- A shared island that cannot hold 120 Hz slows its clock for everyone in it rather than dropping steps.
- Above a 400 ms round trip the HUD warns that docking will be imprecise; nothing is disabled.

### 5.7 Reconnects

- The gateway owns the socket; the island never notices a reconnect shorter than the grace period.
- `hello { resume }` to any gateway replica: the ledger maps the account to its attended vessel and holder;
  the client receives a clock message and a keyframe at the current tick and rebuilds its prediction.
- While the link is down the client keeps predicting (rails exact, integrated dead-reckoned) with inputs
  disabled and a banner; the server follows section 3.6. On return, a correction above 5 m shows "RESYNCED".
- A second session on the same account takes the seat; the first is told (`takenOver`).
- After a shard crash the client's socket survives on the gateway; it receives `notice { recovering }`, then
  a keyframe at the recovered tick (section 7.4).
- Hidden tabs: animation frames stop but messages still arrive. The client stops predicting, the server sees
  no inputs and applies the disconnect rule after the same grace period; returning to the tab is a resync.

---

## 6. Docking, undocking, collisions and damage between players

The mechanics follow `fleet-docking.md` sections 2.7, 3 and 4 and are adopted without change unless stated.
This section places them in the zones and gives the end-to-end sequence.

### 6.1 The vessel model they need (in place)

- `Vessel.crafts[]` (per-craft: id, vehicle, owner, name, stage stack, pending actions, lend policy),
  `PartRuntime.craft`, `Vessel.links[]` for docked joints, `Vessel.helm`. A vessel that never docked has one
  craft and no links and behaves exactly as today.
- Parts are addressed as `craftId/instanceId` everywhere outside the vessel. Vessel and craft ids are issued
  by the ledger and are universe-unique.
- A craft's tree is never re-rooted on docking; links are separate edges, so decouplers keep cutting the same
  joint and rings are expressible.
- Propellant flow groups are `(craft, stageGroup)`; crew state is per command part.

### 6.2 Frames and precision

- Inside any planet's or moon's sphere of influence an island integrates in that body's inertial frame, as
  today (grid 15 um even at the edge of Neptune's, *measured*).
- In the Sun's sphere of influence an island integrates offsets from its reference orbit, with gravity as the
  difference between the acceleration at the vessel and at the origin (Encke with Battin's `f(q)`), through
  an optional origin in `VesselEnvironment`. Without it, heliocentric float64 gives 4 mm/s of velocity noise
  at 1 AU and 0.12 m/s at Neptune (*computed* in `fleet-docking.md`) against a 3 mm/s hard-dock threshold.
- The wire always uses the reference orbit (5.3), and presentation receives positions centred on the
  viewer's focus, never on the Sun.

### 6.3 Nothing tunnels: three broad phases, one per zone boundary

| Pair | Mechanism | Where it runs |
|---|---|---|
| Ledger against ledger (both on rails) | Conjunction screening per sphere of influence when an orbit changes: shell overlap, minimum orbit distance, closest approach in time. A predicted miss below the two bounding radii plus 10 m schedules an encounter event; both are promoted into an island shortly before it | Ledger worker threads |
| Island against ledger | Per body and clock, rails objects are refreshed into a 64 km spatial hash once a second (5,000 objects under 2 ms); anything within the join distance of an island is claimed into it | Shard, from a ledger feed |
| Island against island on one clock | Reach time `tau` on bounding spheres; merge at `1 km + 2 s x closing speed`; part at twice that | Shard |
| Inside an island | Sphere sweep per pair per step; speculative contacts below about 10 m/s; conservative advancement (time of impact) above | Island step loop |

Unattended rails-against-rails collisions are kept (they are what makes "nothing tunnels" true for parked
ships and cost only the screening). Such an encounter is a Z5 run with no pilot.

### 6.4 Docking, end to end

1. **Rendezvous** (section 3.3) puts both craft on one clock. At the join distance the islands merge into Z3;
   both clients receive a keyframe and start predicting both craft.
2. **Approach.** Target-relative navball, range and rate, the docking instrument. All numbers come from the
   island's float64 state in the target port's frame.
3. **Final 2 s before the faces can touch**: Z4. The pair is sent at 60 Hz with contact state.
4. **Contact.** The server measures the capture envelope between the two port frames (axial gap, lateral
   offset, misalignment, roll to the nearest step, closing and lateral speed, relative rate). Both ports must
   be armed. Inside the envelope: `dockCapture` event and soft capture, a compliant six-axis constraint
   solved in the island's contact pass, the two vessels still separate bodies. Outside it but below crash
   tolerance: the ports are colliders, the craft bounce, and the event names the limit that was missed.
   Above crash tolerance: section 6.6.
5. **Hard dock** at a step boundary once offset, angle and relative speed have been below 3 mm, 0.1 degree
   and 3 mm/s for 0.5 s. The server merges: the arriving vessel's parts are re-expressed in the base's frame
   with their own tree, a link joins the ports, mass properties are recomputed, and linear and angular
   momentum are conserved by construction (the present `mergeVessels` discards the second vessel's momentum
   and is replaced). `docked` event with the merged vessel id; a keyframe follows.
6. **Ledger write.** The merge is a structural transition: the ledger records one vessel with several
   crafts before the event is acknowledged (section 7.3). From here the assembly persists as one object.
7. **Afterwards.** The assembly is one vessel on one clock. If every pilot leaves and it is quiescent it
   becomes passive (Z0) and costs nothing.

### 6.5 Control sharing in a docked assembly

One helm with explicit hand-over, plus craft sovereignty (option A of `fleet-docking.md` 3.7):

- **One helm or none.** The helm's inputs steer the vessel through its own craft and through actuators other
  craft have lent. The arriving craft goes to docked free drift: its engines, thrusters and wheels are
  inhibited until its owner's lend policy (`lendAttitude` default on, `lendEngines` and `lendPropellant`
  default off) admits them.
- **Who is helm.** At dock the base vessel's helm stays. The anchor (the most senior craft, never the
  heaviest) decides by policy: `owner`, `crew` (default: any docked pilot when the helm is vacant) or a list.
  A request is a prompt to the helm; it is granted on acceptance, or automatically after 30 s without helm
  input. The anchor's owner may always take it.
- **Sovereignty.** Each owner always keeps their own stage stack, abort sequence, action groups, port arming
  and release, pumping out of their own tanks, and lend policy. Staging while docked is allowed; the pieces
  separate physically.
- **Either side can always let go.** A port is released by the owner of the craft it belongs to.
- **Protocol.** Inputs from a pilot who is not helm are ignored by the island (the client shows "VEGA IS
  FLYING"). `helmRequest`, `helmGrant`, `lendPolicy`, `armPort`, `undock`, `transfer` are `cmd` messages
  acknowledged by the island and mirrored to every pilot aboard.
- **Time.** One vessel, one clock. The helm proposes warp; crew accept; a disconnected or silent crew member
  never blocks (T6). A crew member who wants to leave undocks first (always possible).
- **Disconnect of the helm.** The helm becomes vacant at once, throttle goes to zero, SAS keeps its mode; the
  next pilot may take it under the policy.

### 6.6 Collisions and damage

- **Colliders** are the convex pieces `clearance.ts` already builds from part data, with authored shapes only
  where the bounds cylinder is badly wrong. A contact manifold (closest points and normal) is added; the
  existing distance function is the broad and mid phase.
- **Born overlapping.** Vessels created by one split, and a pair that has just undocked, ignore each other
  until their colliders have first been 5 cm apart. Without this, every stage separation of the existing
  stack fails (envelopes overlap for 0.01-0.39 s).
- **Response** runs per island after the per-vessel step, in the 480 Hz sub-steps: sequential impulses,
  8 iterations, order by vessel id then part index, restitution 0.2 above 0.3 m/s, friction 0.5. The
  integrator is restructured to advance an island sub-step by sub-step so both bodies of a contact get equal
  and opposite forces in the same sub-step.
- **Three regimes** by normal closing speed: contact (impulses only), crash (energy share against each
  part's `crashTolerance`; joints break through the existing g-limit rule; pieces separate through
  `separateVessel`), hypervelocity above about 250 m/s (no rigid solve; mass removed by the energy rule of
  the NASA breakup model). Propellant explosions push other vessels in the island.
- **Damage is binary per part** (intact or destroyed), plus broken joints. There is no health value; this
  answers question 4 of `frontend-ux.md` section 15.
- **Agreement.** Every outcome is an event from the one island both players are in, with the same numbers
  for both (`collision { otherVesselId, relSpeed, partsDestroyed }`). Neither client shows it earlier. The
  motion before and after is predicted by both and corrected by the same snapshots.
- **Growth is bounded.** Destroyed parts vanish into effects; survivors are connected components. At most
  twelve new vessels per collision, fragments under 50 kg live 60 s, and the owner's debris budget applies.
- **Pads.** Pad surfaces are analytic discs, so pad accidents need no terrain data. Range safety destroys a
  vehicle below 5 km whose instantaneous impact point enters another pad's keep-out radius; it is a server
  event shown as such.

### 6.7 Undocking

1. The owner of either port sends `undock` (or a stage action does). The HUD shows "UNDOCKING" until the
   event.
2. At the next step boundary the island removes the link and splits the forest into connected components
   (`separateVessel` over tree edges and links). Each piece keeps the rigid-body velocity of its own origin
   and the common angular velocity, so momentum is conserved by construction (tested to 1e-6 and 1e-9 today).
3. The spring impulse acts equal and opposite at the port, giving both a push and, for a side port, a turn.
4. Both ports go to cooldown; the pair is nascent (no contact until 5 cm apart).
5. Craft records go with their parts. The piece with the helm's craft keeps the helm; every other piece gets
   its own connected owner as helm at zero throttle, or none.
6. The ledger records the split before the `undocked` event is acknowledged. The pieces stay in one island
   until they part at twice the join distance; each owner's island then drops back to the trailing lane.

---

## 7. Persistence

### 7.1 What is durable

| Class | Content | Guarantee |
|---|---|---|
| 1. Ledger | Vessels, crafts, worldlines, ownership, pad timetable, accounts, rules | Written in one Postgres transaction **before** the transition is acknowledged or the hand-over completes. Never lost |
| 2. Islands in flight | Checkpoint of each island every 30 s and at every structural event; an input journal chunk every second | At most about 1.25 s of flight lost in a crash (1 s chunk plus a 250 ms batch) |
| 3. Derivable | Patches, readouts, census, clocks' current values, prediction | Never stored |

Clocks are stored as `(ut0, wall0, rate)` only when they change, plus a ledger heartbeat every 5 s. After a
crash a cruising vessel resumes at the later of its last committed head and its clock evaluated at the last
heartbeat; the lost interval is pure coasting with no interaction in it, because every interaction is a
class-1 write.

### 7.2 Schema (Postgres on Railway, private network)

```
account     (id uuid pk, callsign citext unique, created_at, last_seen_at, settings jsonb, flags)
credential  (id, account_id fk, kind text, public_key bytea, label, added_at, revoked_at)   -- 'deviceKey' today;
                                                                                            -- other sign-ins are rows
recovery    (account_id pk, code_hash, rotated_at)

vessel      (id text pk,                       -- universe-unique, issued by the ledger
             lobby_id, state smallint,         -- passive | cruise | island | burst | tombstone
             holder text, epoch bigint,        -- authority fence (I1)
             body_id text, head_ut float8, horizon_ut float8,
             seg_kind smallint, seg_r0 float8[3], seg_v0 float8[3], seg_t0 float8,   -- or body-fixed rest pose
             mass real, bounding_radius real, situation smallint,
             anchor_craft text, helm_account uuid null, advance_limit_s float8, access smallint,
             struct_version int,
             dyn bytea,                        -- complete dynamic state, binary codec, definitions by id
             expires_at timestamptz null, updated_at timestamptz)
craft       (id text pk, vessel_id fk, owner_account uuid null, vehicle_id text, design jsonb null,
             name, joined_ut float8, last_flown_at timestamptz, expires_at timestamptz, policy jsonb)
worldline   (vessel_id, seq int, ut_start float8, ut_end float8, kind smallint, body_id text, data bytea,
             primary key (vessel_id, seq))     -- conic | at rest | sampled arc
plan        (vessel_id, account_id, nodes jsonb, target jsonb)        -- maneuver nodes saved with the ship
pad_slot    (site_id, pad_id, ut_from float8, ut_to float8, vessel_id, account_id, state smallint)
island_ckpt (island_id, shard text, tick bigint, clock jsonb, state bytea, created_at)   -- newest two kept
island_jrnl (island_id, chunk bigint, tick_from bigint, tick_to bigint, data bytea)      -- pruned at next ckpt
rules       (version int pk, doc jsonb, activated_at)
feed        (id bigserial, at timestamptz, ut float8, kind text, data jsonb)
report      (id, at, reporter, subject, kind, context jsonb)
```

- `design` on `craft` is empty today and is where a ship-builder design (a `VehicleDef` document) will live;
  `vehicle_id` then names a design instead of a shipped vehicle. Nothing else changes for the builder.
- `dyn` is written by a real codec, not JSON: tagged non-finite numbers, signed zero preserved, definitions
  by id, and the state that `Vessel.struct` holds today included. About 8 kB for the 38-part stack
  (*assumed*; 22.4 kB as JSON *measured*). A parked ship is never kept as a live `Vessel` (375 kB of heap
  each); the ledger holds about 0.5 kB of metadata per vessel in memory and loads `dyn` on claim or attach.
- An assembly is one `vessel` row with several `craft` rows; its links and per-craft stage stacks are inside
  `dyn`. Persisting a docked assembly needs nothing beyond persisting a vessel.

### 7.3 Write path

- **The ledger process is the single writer** of `vessel`, `craft`, `worldline`, `pad_slot`. A transition
  (spawn, attach, to-rails, claim, dock, undock, split, destroy, ownership or policy change, expiry) is
  applied in memory, written in one transaction (1-3 ms on the private network, group-committed, *assumed*),
  and only then acknowledged to the holder and to clients.
- **Shards write** `island_ckpt` and `island_jrnl` in batches every 250 ms. A journal chunk holds everything
  needed to replay: tick range, every pilot's input changes, commands, clock rate changes, and which terrain
  data level was resident. Replay on the same runtime image is bit-exact (*measured*: identical hashes within
  one runtime).
- **Volumes** (*derived*): at 500 players about 0.1-0.3 MB/s of checkpoints and journals; at 5,000 about
  2-4 MB/s. Checkpoint rows are overwritten in place; journal rows live for at most a minute.
- **Second copy.** A logical dump of the ledger tables every hour and the newest checkpoints every 5 minutes
  go to a Railway bucket (a different storage system); Railway publishes no durability figure for volumes.
  One sampled journal in a hundred is archived for the replay audit (section 10.5).

### 7.4 Restart recovery

**Planned (every deploy is a restart).** The shard receives SIGTERM with a 30 s drain
(`RAILWAY_DEPLOYMENT_DRAINING_SECONDS`). It stops accepting islands and migrates each one to another shard
(2-5 ms each; sockets stay on the gateways). With a single shard, it checkpoints every island at a common
tick, flushes, and clients see "Universe restarting, your ships are saved, back in about 30 s"; clocks stop
while it is away. Gateways and the API are stateless and roll one replica at a time. The ledger restarts in
seconds from Postgres; islands keep flying meanwhile, and only spawns, claims and to-rails transitions wait.
The simulation services have their own watch paths, so a front-end push never restarts them.

**Unplanned (a shard dies).**

1. The ledger notices the missing heartbeat (2 s) and marks the shard's islands `recovering`; gateways tell
   the affected clients.
2. A replacement (another shard, or the restarted one) loads each island's newest checkpoint and replays its
   journal to the last durable chunk. Cost: at most 30 s of flight per vessel at about 230x real time,
   0.13 CPU-seconds each. For 5,000 integrating vessels that is 650 CPU-seconds: 14 s on 48 worker threads,
   or fanned out to Modal in parallel.
3. Islands resume at the recovered tick. Their clocks are now behind where they were: live-clock islands show
   `catchingUp` and run at up to 1.1x until they are back; private clocks simply continue.
4. Clients receive a keyframe; anything they predicted past the recovered tick is discarded ("RESYNCED").
5. Pilots who do not return within the grace period are detached under section 3.6.

Docked assemblies survive both paths without a special case: a passive assembly is a ledger row (class 1);
an attended one is in a checkpoint with its links.

### 7.5 Expiry and cleanup (wall clock)

| Object | Kept for | Reset or protected by | Then |
|---|---|---|---|
| A ship: a craft with a command part and an owner | 14 days after its owner last flew it | Flying it (as helm or crew); RENEW in My Ships | Becomes unowned |
| A craft docked in an assembly | Its own 14 days, as above | The same. Docking by itself does not reset the clock | Becomes unowned but stays attached; the anchor's owner may release it |
| An assembly | As long as any craft in it has an unexpired owner, plus 48 h | Any member's activity | Removed whole |
| Ship slots | 10 owned craft per account | Abandon one to free a slot | Launch refused with the reason |
| Unowned craft, spent stages, large debris | 24 h after the last time an attended vessel was within 50 km | - | Removed |
| Fragments under 50 kg | 60 s of simulation (the existing rule) | - | Removed |
| Debris budget | 24 objects per account, 5,000 per sphere of influence | - | Oldest removed first |
| A vehicle on a pad | 300 s, one 120 s extension with engines running; 60 s after a disconnect | - | Rolled back to the hangar, no debris |
| A vessel beyond 100 AU on an escape trajectory | - | - | Removed with reason `lost` |
| Sampled arcs in worldlines | 24 h | - | Reduced to end points |
| An account with no ships | 90 days without a visit | Any visit | Deleted |

- **The clock is the wall clock**, measured on the ledger host. "Activity" is being aboard a vessel that
  contains the craft, or pressing RENEW. A visit to the menu alone does not renew ships.
- **Docking and expiry.** Docking protects hardware, not ownership: a station stays whole while anyone who
  owns a part of it is active, and a lapsed module cannot be reclaimed by its former owner once someone else
  has released it. My Ships shows "kept, docked with an active assembly" for such a craft.
- **Only passive vessels expire.** The sweep (every 60 s) never removes a vessel that is attended or inside an
  island. Removing a vessel removes its whole worldline, so no echo of it survives.
- Removal is a ledger transition with an event (`vesselRemoved`, reasons `expired`, `limit`, `rolledBack`,
  `recovered`, `lost`), so clients and the feed show why.

### 7.6 Rules are data

One versioned `UniverseRules` document holds every number in sections 3, 6 and 7.5 (lead cap, range radius,
departure notice, arrival separation, `advanceLimit` defaults, capture envelopes, crash thresholds, pad
timers, lifetimes, slot and debris caps, admission cap) and is served to clients, which render the "How this
universe works" screen and every countdown from it. The staging environment runs the same code with
lifetimes of minutes to demonstrate expiry.

---

## 8. Server topology, capacity and cost

### 8.1 Topology

One codebase, one Node image, roles selected by environment. At small scale one service runs every role.

```
browser -- HTTPS --> web      shell (Netlify, or a Railway static service): HTML, JS, CSS, COOP/COEP headers
        -- HTTPS --> api      identity, lobby, rules, ships, presigned pack URLs, public menu snapshot (1 s cache)
        -- WSS ----> gate     stateless WebSocket gateways (replicas): auth, fan-out, drop-superseded, routing
        -- Range --> bucket   tile, sky and asset packs (Railway bucket; mirror service with CDN as fallback)

Railway private network (US East):
  gate ----> sim-1 .. sim-N   shards: one service each (addressable by name), 1 main thread + W worker
                              threads, one isolate per worker; islands live in workers; height packs read
                              by range from the bucket into a local LRU
  gate ----> dir              the ledger: one process, worker threads for conjunction screening;
                              clocks, claims, pad timetable, island placement, expiry sweep
  sim-k <--> dir              hand-overs, heartbeats, rails feed for the spatial hash
  api, dir, sim-k --> postgres (volume, scheduled backups)   dumps and checkpoints --> bucket
  plan                        planner replicas: window grids, weak-client predictions

Modal (own environment, prefixed apps; existing apps untouched):
  fsp-burst   deferred-lane batches and crash-recovery replays (leases from shards)
  fsp-audit   nightly replay of archived journals against committed checkpoints
  fsp-bots    load-test pilots       fsp-bake   data bakes
```

Why this shape:

- **Gateways own sockets, shards own islands.** Railway distributes connections randomly among replicas and
  has no sticky routing, and replicas are not addressable from outside. With gateways that does not matter,
  and an island can move between shards without the client reconnecting, which is what makes the hand-overs
  of section 2.3 seamless.
- **Shards are services, not replicas**, so the ledger and gateways can address `sim-k.railway.internal`.
  Whether replicas are individually addressable on the private network is untested; this layout does not
  depend on it. Usage billing makes an idle pre-created shard cost only its memory (about $1.50 a month).
- **One ledger** is what "the server orders competing claims" means. It does event-driven work only.
- **One region.** A second region cannot share islands; it would be a second lobby.

What the user has to provide: Railway Pro and approval for a new project; for the Netlify shell, a Pro team
with auto-recharge on, the CLI installed and `NETLIFY_AUTH_TOKEN` plus a site id (none exist on this machine;
a Railway static service is a complete substitute and needs nothing); a dedicated Modal environment.

### 8.2 Capacity estimates (to be replaced by the load test)

| Component | Expected capacity (*derived*) | With the pessimistic 0.03 vCPU per vessel | What binds |
|---|---|---|---|
| One shard worker thread | 170 solo ascents at 85 %; or 280 other solo powered craft; or 25-30 docking pairs in final approach at 50 % | 28 ascents | One thread per isolate |
| One shard (24 vCPU, 22 workers) | About 3,700 simultaneous solo ascents, or 600 docking pairs; about 3,000 connected players at the launch-day mix | About 400-900 players | The 24 vCPU replica on Pro |
| One gateway replica (8 vCPU) | 4,000 connections | - | 10,000 connections per service |
| Ledger | 10,000 transitions a second; 100,000 vessels in 50 MB | - | One thread; Postgres commit latency |
| Postgres | Ledger writes of a few hundred rows a second; 2-4 MB/s of checkpoints and journals at 5,000 players | - | 3,000 IOPS volume |
| Pads | 12 pads over two sites: 180-480 launches per UT-hour | - | Game rule, not hardware |

Bottlenecks in the order they bind:

1. **Pads.** A front-page crowd wants thousands of launches an hour; twelve pads give a few hundred. More
   pads are data. The pad timetable (T14) lets a queued player take a future slot at once, at the price of
   starting ahead of the live clock.
2. **Real-time islands on single threads.** Tail latency of contact steps, not average CPU.
3. **Egress.** The largest sustained line on the bill; the send-rate tiers are the control.
4. **10,000 connections per gateway service**, lifted by a second gateway service and a request to Railway.
5. **The ledger thread and Postgres commits**, long after the others.
6. **No autoscaler.** A script on the Railway API changes shard and replica counts; pre-scale before an
   announced launch.

### 8.3 Monthly cost

List prices: $20 per vCPU-month, $10 per GB-month, $0.05 per GB of service egress, bucket egress free.
"Expected" uses section 4's figures; "upper" uses `hosting.md`'s assumptions (0.03 vCPU per integrated
vessel, 3 kB/s per player). Concurrency is held all month. The shell is priced on Netlify; a Railway static
shell is $20 to $300 a month cheaper as load grows.

| Line | 20 players | 500 players | 5,000 players |
|---|---|---|---|
| Simulation CPU (expected / upper) | $6 / $15 | $63 / $245 | $975 / $4,250 |
| Gateways, ledger, planner, API CPU | (in the above) | $36 | $290 |
| RAM (processes, terrain caches) | $17 | $70 | $360 |
| Postgres, volume, backups | $8 | $48 | $210 |
| WebSocket egress (expected / upper) | $3 / $8 | $78 / $194 | $1,360 / $1,940 |
| Buckets and tile mirror | $3 | $15 | $30 |
| Shell on Netlify Pro | $20 | $80 | $420 |
| Modal (audits, weekly rehearsal, burst) | $0 (inside the $30 credit) | $15 | $75 |
| **Total, expected** | **about $60** | **about $400** | **about $3,700** |
| **Total, upper** | **about $75** | **about $700** | **about $7,600** |

A one-day spike to 5,000 concurrent players on top of a quiet month (the front-page day): simulation $33
(upper $141), gateways $7, RAM $12, egress $45 (upper $65), Postgres $5, shell $20, tiles $0 on the bucket
path. **About $125 expected, $250 upper**; plus up to $750 if the free tile path fails and tiles fall back to
billed egress (`hosting.md`). Rehearsals before launch: about $150 once.

Budget to ask the user for: $100 a month standing, a $300 spike reserve, $150 for rehearsals, and the
understanding that 5,000 sustained players is a $4,000-8,000 a month service.

### 8.4 Scaling path

1. One `core` service with every role: to about 300 concurrent players.
2. Split roles: `gate` replicas, `dir`, `sim-1`, `plan`, `api`.
3. More shards. The ledger places islands by clock and sphere of influence so likely merges are local.
4. Raise `L_cap` use: deferred lane on Modal for Z5 and deep-space Z2, if the load test shows it helps.
5. A second gateway service at 8,000 connections; ask Railway for higher limits.
6. Partition the ledger by sphere of influence (each partition orders its own claims; crossing a boundary is
   a hand-over) if its thread saturates.
7. Postgres: connection pooling, then the HA cluster, then journals on a separate instance.
8. More lobbies: a second ledger and shard set behind the same gateways. The lobby is already the unit in the
   brief.

---

## 9. What changes in place, and where single-player flying lives

### 9.1 The refactor, by module

| Module | Change |
|---|---|
| `src/sim/orbit`, `frames`, `bodies`, `nav` | Kept. Fix the prediction horizon (per patch, scaled to the sphere of influence). Add vessel-against-vessel closest approach and conjunction screening, warp levels 1e6 and 1e7, the Sun as root attractor, target-relative navigation. Numerics unchanged |
| `src/sim/vessel` | Data model restructured, algorithms kept: `crafts[]`, `links[]`, `helm`, universe-unique ids, vessel-owned stage stacks, flow groups by craft, crew per command part, momentum-conserving merge, the stateful members of `struct` moved into the vessel, and a binary codec beside `stateHash` |
| `src/sim/dynamics` | Force models kept. The step loop is restructured to advance an **island** sub-step by sub-step with a vessel-vessel contact pass, swept tests and the optional local origin. An island of one with no origin takes exactly today's path |
| `src/sim/world/sim.ts` (`World`, 2,531 lines) | **Split, not wrapped.** Its per-vessel state machine, rails advance with exact events, sphere-of-influence hand-over and reduced tier become `src/sim/island` (one clock, a set of vessels, no player). Its snapshot building, readouts, navball, patches, nodes, burn bookkeeping and presentation interpolation become the **client view** (`src/client/view`). Its single `active`, `controls`, warp index, bubble radius, mission failure and debris cap are deleted |
| New `src/universe` | Ledger (records, worldlines, solid windows, claims), clocks and the rules of section 3, island lifecycle and lanes, zone decisions, pad timetable, expiry. Pure TypeScript with no timers or I/O, like `src/sim`: time and storage are injected. The servers, the in-process universe and the tests all run this one module |
| New `src/net` | Codec, session client, prediction and reconciliation, census replica |
| New `src/server` | The roles: gateway, ledger host, shard host with worker threads, planner, API. Thin: sockets, threads, Postgres, bucket |
| `contracts/sim.ts` | `SimSnapshot` stays the presentation contract. `activeVesselId` becomes nullable (menu, spectating). Added: `time: TimeView`; `crafts`, `links`, owner and `solid`/echo flags on `VesselSnapshot`; `craftId` on parts; target and docking readouts; new events (`dockCapture`, `docked`, `undocked`, `collision`, `helmChanged`, clock events); a documented viewer-centred frame origin in place of "ROOT is centred on Earth". `scenario`, `milestones`, `mission` and `cheatCounter` become an optional objective block. `warp` stays, derived from `time`, so HUD and audio code is untouched |
| `contracts/sim.ts`, the `Sim` interface | Becomes `FlightSession`: the same `advance`, `snapshot`, `peek`, `setControls`, `commands` that the app loop and the pilot call today, with two implementations (9.2). `step`, `advanceRails`, `stateHash` and `debug` remain on the local one only |
| `contracts/controls.ts` | `PlayerCommands` keeps its shape. State-changing commands return at once and are confirmed by a later `cmdAck` event (a `pending` flag on `CommandResult`). Planning commands stay synchronous because they are local. `setWarpLevel` becomes a clock request with the refusal reason. Added: target as body, vessel or port; port arming, undock, control point, helm, lend policy, transfer; hold, jump, sync, link, meet. `cycleActiveVessel` means "take a seat in another craft I may control in my island" |
| `contracts/simInternal.ts` | `VesselEnvironment` gains the optional origin state and the island's other vessels for the contact pass; "describes the start of the step" stays |
| `contracts/defs.ts` | Docking-port module, optional colliders, pads per site, Sun-rooted bodies, the warp table. `ScenarioDef` is demoted to a spawn recipe plus an optional objective list |
| `src/app` | Still an unwired shell, so it is written once against `FlightSession` |
| `src/ui`, `map`, `camera`, `audio`, `render/*` | Keep reading the same snapshot fields (about 190 read sites stay valid). Additions only: time strip, target and docking instruments, echoes, census layer, part keys by `craftId/instanceId`, a relevance cut for many vessels |
| `src/pilot` | Unchanged interface. The scripted pilot drives a `FlightSession`, so the same pilot is the mission proof, the calibration flight and a load-test bot |
| `src/core/fakes/fakeSim.ts` | Follows `FlightSession` |

Order that minimises rework: ids, crafts and the codec first; then the island and the universe module with
the local session and the mission proof green; then the network session and servers; then contact, docking
and control sharing; then the lanes beyond real time.

### 9.2 Single-player-style flying inside the same architecture

- **It is zone Z1 and Z2.** A player who launches alone, warps to the Moon, lands, returns and splashes down
  never leaves an island of one. Inputs are applied on their own machine at once; the server confirms a
  moment later; warp is private and instant. Nothing about that flight waits for anyone.
- **`LocalSession`** runs the `src/universe` module in process (a ledger, one island, no sockets, no lag) and
  implements `FlightSession`. `createSim(defs, scenarioId, { terrain })` remains and returns it, so the
  headless mission tests, the labs, the benchmark flight of the capability gate and the scripted pilot keep
  working through the same call. **`NetSession`** is the same interface over the gateway with prediction.
- **The Earth-Moon-return proof** stays a `tests/mission` run: the scenario fixes the universe epoch and the
  spawn, the generic milestone evaluator is attached to the craft as its objective list, the pilot flies it,
  and the golden hash is checked. The hash is re-baselined once, after the id change and the Sun re-root,
  behind a test showing that the single-craft trajectory is bit-identical before and after the vessel-model
  change (only ids enter the hash differently).
- **The same mission online.** Spawn slot at the next plane crossing (T14), ascent in Z2 on the live clock,
  private warp to the Moon in Z1, landing in Z2 with the shard reading the Moon's height packs (the lag dial
  absorbs the fetch), return, entry, splashdown. The network test tier flies exactly this with the scripted
  pilot as a client (section 10.3).
- **Offline play** is `LocalSession` in the browser. It is not a second game mode to maintain; it is the
  test harness shipped.

---

## 10. Verification plan

### 10.1 Headless, every commit (vitest)

- Codec: round trip of stepped vessels in every regime (ascent, touchdown with live friction anchors,
  entry with hot parts, docked assembly) gives an equal state hash and an identical continuation for 6,000
  steps.
- **Lane equivalence.** One recorded input log through the real-time lane, the trailing lane in batches of
  30 and 240 ticks, a mid-flight shard-to-shard migration, and a burst-job lease: identical state hashes.
- Island merge and split: result independent of arrival order; momentum conserved to 1e-9 through
  dock then undock; every stage separation of the existing stack survives with contact on; two craft closing
  at 15.6 km/s never pass through each other at any step phase; a dock at 30 AU holds relative speed noise
  under 1 mm/s.
- **Time-model fuzzing.** A model of the ledger driven by thousands of random sequences of spawn, warp,
  jump, hold, link, claim, dock, undock, logout, crash and expiry, checking after every operation: heads
  never decrease, one holder per vessel, no interaction between vessels on different clocks, no claim outside
  a solid window, no arrival inside 2 km, pad slots never overlap.
- The Earth-Moon mission through `LocalSession`, golden hash, zero incomplete terrain queries.
- Prediction tolerance: the same input log in Node and in Chrome (Playwright); divergence after a 600 s
  ascent and after a touchdown stays under the stated bounds.

### 10.2 Separate processes with latency injection (local)

A harness starts ledger, shard and gateway processes, a WebSocket proxy that injects delay, jitter and
TCP-style stalls per client, and two to four headless clients that are real `NetSession`s driven by scripted
pilots. Cases, each at 40 ms, 150 ms and 300 ms round trip with 2 % stalls of 200 ms:

- Two pilots launch from neighbouring pads at once; both reach orbit; pad contention refuses a third spawn.
- Meet at a time, link, rendezvous, dock, fly the assembly with a helm hand-over, undock; both clients' final
  states equal the server's within tolerance and momentum is conserved.
- Deliberate collision at 2 m/s, 20 m/s and 1 km/s: both clients receive the same event with the same
  numbers; neither shows it before the event.
- Warp rules: refused departure on a predicted approach; departure notice; jump refused inside 2 km; hold
  then sync; ask-to-advance accepted and refused; sphere-of-influence change during a shared warp.
- Disconnect during a burn, on rails, in soft capture, as helm; reconnect inside and after the grace period.

### 10.3 Real browsers

Two Chrome instances with real GPUs (Playwright, separate profiles) against the local stack: fly, rendezvous,
dock, undock, collide, warp, disconnect and reconnect, with screenshots from both views of the same server
tick and an assertion that the docking instrument numbers mirror each other. The scripted pilot flies the full
Earth-Moon return as a network client. An interplanetary flight (the cruiser to a Mars capture ellipse) is
flown by the pilot under private warp and ends with a bound orbit about Mars.

### 10.4 Restart recovery and expiry

- Kill a shard with SIGKILL during a soft capture, during an ascent, and with a docked assembly attended:
  islands resume from the journal within the stated time, clients resynchronise, the assembly is intact, and
  at most 1.25 s of flight is lost.
- Kill the ledger during a claim and during a dock: the transition is either fully applied or absent.
- A deploy drain with islands migrating while their pilots fly: no reconnect, no correction above tolerance.
- Stop everything, restore Postgres from the bucket dump, start: every passive ship and assembly is where
  its worldline says.
- Expiry on a staging rule set with lifetimes of minutes and an injected wall clock: ships, docked craft,
  assemblies, debris and pad roll-back each expire as section 7.5 says, with the right reason shown.

### 10.5 Load test with simulated active players (deployed staging, Modal bot fleet)

- Bots are headless `NetSession` clients. Nine in ten replay recorded input logs of real flights with
  jitter (cheap, realistic traffic); one in ten runs full prediction and checks every correction.
- Scenarios: pad storm (everyone launching), cruise-heavy, 20 % of players in docking pairs, mass warp,
  reconnect storm after a deploy, and the launch-day mix. Steps of 50, 500, 2,000 and 5,000 bots.
- Measured per run: step time p50 and p99 per worker, lag distribution per lane, dilation events, bytes per
  second per player per zone as billed, gateway CPU per connection, ledger transition latency, Postgres
  write latency, recovery time after a forced shard kill at load.
- The limit reported is the player count at which a service level breaks: more than 1 % of real-time ticks
  over 8.33 ms, solo lag above 2 s, or correction rate above one per player-minute.
- Nightly: the audit job replays archived journals on Modal and compares hashes with the committed
  checkpoints; a mismatch is a server determinism bug.
- Results go into one report that replaces every *assumed* and *derived* number in sections 4 and 8.

---

## 11. Honest weaknesses

1. **More moving parts than "the server simulates everything in real time".** Six zones, three lanes and
   nine hand-overs are more states to get right. The mitigation is structural (one step loop; lanes differ
   only in scheduling; the lane-equivalence test), and the design degrades to the simple one by setting
   `L_cap = 0`. It should ship that way first and enable lag once the equivalence tests pass.
2. **Every capacity and cost figure is derived, not measured on the target.** The 2.5x derating, the
   per-connection gateway cost, snapshot encoding cost and what Railway meters as egress are assumptions.
   The expected and upper totals differ by a factor of two for that reason.
3. **The lag dial may turn out to be unnecessary.** If the measured step cost holds, a launch-day crowd fits
   in two or three shards in real time. Then the trailing lane's remaining value is the lower send rate, the
   absence of input misprediction for solo pilots and tolerance of terrain stalls, and the deferred lane on
   Modal may never be switched on. It is designed to be built last.
4. **Solo prediction relies on the client and server agreeing to within last-bit noise.** A threshold event
   (a part at its temperature limit, a leg at its crash tolerance) can fall on different sides; the client
   then shows something the server does not confirm and must resynchronise visibly. Touchdown is the most
   sensitive regime; it needs checkpoints at 10 Hz and its own tolerance tests.
5. **The time model fragments the lobby.** After any private warp a player is alone in their time until
   someone jumps, holds or arranges a meeting. The launch site is shared by construction; orbit is shared
   mostly by arrangement. A mega-lobby under this model is a crowded pad and a census of echoes, not a busy
   sky.
6. **Forward-only has victims.** A parked ship that someone ahead (within `advanceLimit`) docks with, moves
   or destroys is, for its owner in the present, already changed in the future. `advanceLimit` bounds how far
   but cannot remove it. Ramming parked ships is possible, as it is at equal times.
7. **Echo semantics have odd corners.** A ship outside its solid window is drawn but cannot be touched, so a
   player can fly through it. A decaying ship beyond its horizon is "fate pending". These are consistent and
   must be explained; they will still surprise people.
8. **One accepted inconsistency**: an object launched at an earlier time is not collided against histories
   already committed.
9. **Pads are the real capacity limit**, and the future-slot valve trades queueing for starting ahead of the
   live clock, which feeds weakness 5.
10. **The ledger is a single process.** It is the ordering point for claims and the single writer. While it
    restarts, flying continues but spawns, claims and to-rails transitions wait. Partitioning it is on the
    scaling path, not in the first build.
11. **Crash recovery is not lossless.** Up to about 1.25 s of flight is replayed away, and the recovered
    islands are behind the live clock until they catch up. Railway volumes have no published durability;
    the hourly dump bounds a volume loss to an hour of ledger transitions.
12. **Server-side terrain.** Shards need the 9.65 GB of height packs within reach. A first landing in a
    region stalls the lagged simulation while ranges load; in a shared island it becomes a dilation.
    Throughput of the bucket under concurrent ranged reads is unproven.
13. **WebSocket over TCP in one region.** A lost packet stalls a stream for 200 ms or more; players in Asia
    and Australia have about a quarter second of round trip. Docking tolerates it by design; it will not
    feel as tight as a regional server.
14. **Railway has no autoscaler, no sticky routing and a restart on every deploy.** The pre-created shard
    services, the scaling script and the drain-and-migrate path are things this design must build and keep
    correct.
15. **Determinism is tied to one V8 build and one CPU architecture.** Shards, burst workers and audits must
    run the same image; a Node upgrade is a re-baseline and cannot be rolled out gradually across shards.
16. **Cheating that survives**: input automation (an autopilot client) cannot be prevented, and all state is
    public by nature.
17. **The refactor is large and lands on a moving tree.** Splitting `World`, changing the vessel model and
    re-baselining the golden mission while wave 2 is finishing is the main schedule risk.
18. **Not flown.** No rule in section 3 has been play-tested. The numbers most likely to move are the
    departure screening window, the arrival separation, `advanceLimit` defaults, and the range radius.

---

## 12. Decisions this proposal asks for

| # | Decision | Recommendation |
|---|---|---|
| 1 | Ship with lag enabled, or real-time everywhere first | Real-time first (`L_cap = 0`), trailing lane after the equivalence tests, deferred lane only if the load test asks for it |
| 2 | Live clock during downtime | Keeps running (wall-anchored); slipped islands catch up at 1.1x |
| 3 | Lead cap | 100 years |
| 4 | `advanceLimit` defaults | 7 days for ships, 30 days for public assemblies, owner-adjustable |
| 5 | Future pad slots | Offered when every pad is busy, up to 24 h ahead |
| 6 | Unattended rails-against-rails collisions | Kept |
| 7 | Shell hosting | Netlify if the user provides a Pro team and token; otherwise a Railway static service |
| 8 | Budget | $100 a month standing, $300 spike reserve, $150 rehearsals |
