Status: open
From: the lead (owner of the pinned trajectory guard), from the audit of island-core's formation table (2026-11-24)
Owner path: src/sim/island/far.ts (island-core; its reviewer or its successor)
Blocking: yes, for the re-record of tests/mission/trajectory-guard.json (the mission stands at 35 of 37 until then)

## Problem
A piece in the Reduced tier is tested for the join distance, and admitted to the island, on a position that
is up to 59 ticks old.
- `joinInto` (far.ts 124-135) calls `sync` and then `island.reach({ r: o.vessel.r, ... })`. For the Reduced
  tier `sync` is `advanceReduced` (249-276), which steps only while `reducedTick + 60 <= tick`: `o.vessel.r` is
  the state at the piece's last 0.5 s step, compared with members that are at the current tick.
- `release` (111-117) then hands that old state to `island.add` as the state AT the tick.
The comments say "every object is brought to `tick`", and ARCHITECTURE 6.2 admits a Reduced object "when
one comes within the join distance". v1's formation read the state the same way, but against 25 km; at
the join distance of 1 km it decides: at 11 km/s a tick is 91.6 m.

## Evidence (a flight of the headless mission at HEAD 55995c5, state hash f0c0855ea40d8c59)
- THE HERON ASCENT STAGE enters the Reduced tier at the atmosphere (control tick 182271), 139.99 km up,
  2,262.8 m from the capsule and opening at about 3 m/s. For the next four control ticks its position does
  not move while the capsule moves 366.5 m each: apparent range 1,933 / 1,620 / 1,334 / 1,098 m. At control
  tick 182276 the apparent range is 947.2 m (true 2,263.3 m): it is admitted to the island with a position
  20 ticks old, displaced 1,832.9 m. It then flies its whole entry in the Full tier about 1 km from the
  capsule and breaks up there; by the design it would have stayed Reduced from the atmosphere on.
- THE LYRA-A ASCENT ENGINE (which exists as a vessel only because the stage breaks up in the Full tier):
  Reduced at 2,007 m (control tick 184626), re-admitted 12 ticks later at an apparent 1,004 m (true 2,031 m),
  displaced 1,102.8 m.
- Of the flight's 23 tier changes exactly these two are Reduced to Full. The attended craft is not
  affected in this flight (bit-identical to the pinned guard at 400 of 400 samples).
- Probes and tables: `out/lead-baseline-v2/trajectory-guard/` (`f-probe.txt`: the re-admission windows;
  `c-analysis.txt`: tier histories and the debris table).

## Requested change
Bring a Reduced object to the tick before it is tested against the join distance and before it is handed
to the island (advance it by the remaining ticks on its own model, or test and admit it at its own
`reducedTick` state propagated to the tick), so that `reach` compares states of one instant and `add`
receives the state of the tick it names. Then say so to the lead, who re-records the guard's unattended
entries from a new flight and counts the golden (it will move: the ascent stage's fate changes again and
the Lyra-A row may go).

## What the audit found clean (no change asked)
- The launch clamps differ from the recording at samples 7 to 11 by a few ulp (r up to 8, v up to 5, q up
  to 17) because a held vessel is placed on the rotating Earth by one of two expressions for the same
  rotation: inside the island `rideBody(vessel, env, dt)` (the orientation at the step's start turned by
  spin x dt), outside it `rideBody(..., 0)` with the orientation evaluated at the tick. Every sample of the
  recording and of the flight is bit for bit one of the two. The clamps now leave the island 33 s after
  lift-off, 2,114 m from the stack; in the recording they left at 27 km, after sample 11. No state leaks.
- Fairing panel 3 (511.9 m) and the Kestrel apex cover (695.8 m): the Reduced tier flies a piece's origin
  as a point mass with its attitude frozen and with drag only, and takes each of them over earlier than
  the recording did (the panel 23.7 s after jettison instead of about 55 s later, while it tumbles at 0.37
  rad/s with its centre of mass 5.6 m from its origin; the cover for its last 43 s, where the Full tier
  let it glide at 17.9 m/s across the air). Same body, same kind of end, same region.
