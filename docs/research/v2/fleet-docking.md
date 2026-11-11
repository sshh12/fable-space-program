# Fleet, docking, collisions and the launch complex (research for architecture v2)

Scope: the vehicle fleet and the physical interaction between craft for the expanded brief (`PROMPT.txt`
below `--- expansion ---`). Design only: nothing here is implemented, and no existing file was changed.

Sources read: `docs/handoff/sim-vessel.md`, `src/sim/vessel/**`, `src/core/contracts/defs.ts`, `sim.ts`,
`controls.ts`, `simInternal.ts`, `data/defs/parts/*`, `data/defs/vehicles/meridian-lunar.json`,
`data/defs/sites/*`, `docs/research/sim-design.md`, `docs/ARCHITECTURE.md`, and the vehicle-pad and vfx
briefs in `docs/WORK_PACKAGES.json`.

Status of the numbers: **measured** = quoted from a wave-1 hand-off; **computed** = arithmetic done for
this document (rocket equation, Hohmann transfers, float64 spacing; the script is not in the repository);
**proposed** = a design value to be tuned in play. Nothing below has been flown.

Words used throughout:

- **Craft**: what one player launched: one instance of a `VehicleDef`, with a server-assigned id that never
  changes. It keeps its identity through docking, undocking and staging.
- **Vessel** (or **assembly** when it holds several craft): one rigid body, as today. A vessel holds the parts
  of one or more craft.
- **Island**: a set of integrated vessels close enough to touch within the next seconds, stepped together.
- **Helm**: the one player whose control inputs steer a vessel.

---

## 0. Decisions this supports, and facts not to miss

### Recommended decisions

| # | Topic | Recommendation |
|---|---|---|
| 1 | Fleet | Seven vehicles plus one optional depot flight, built from three launchers (Azimuth light, Solstice medium, Meridian heavy) and six spacecraft, all from one part library of about 55 parts (25 exist). Section 2. |
| 2 | Part reuse | Solstice's upper stage **is** the existing Meridian M-3 stage and its first stage flies two existing Atlas-9M; the ferry, station core, tanker and lunar ferry use the existing Lyra engines; Egret reuses the Heron legs. Four new engines are needed: two for the light launcher, a probe kick engine and the nuclear thermal engine. |
| 3 | Vehicle file format | `VehicleDef` stays the flat part graph it is. Add optional sub-assembly includes resolved by the loader, node kinds, surface attachment, symmetry tags and a pure `validateVehicle()`. A ship builder later writes the same file. Section 2.6. |
| 4 | Runtime model | Move the per-vehicle fields of `Vessel` into `Vessel.crafts[]`, tag every part with its craft, and add `Vessel.links[]` for docked joints. A vessel becomes a forest of craft trees joined by links; a single-craft vessel is exactly today's vessel. Section 2.7. |
| 5 | Docking | Docking ports are parts with a `dockingPort` module. Two port types (crew `C`, heavy `H`), androgynous. Soft capture is a compliant two-body constraint; hard dock merges into one rigid body with momentum conserved; undock splits it again. Section 3. |
| 6 | Control of a docked assembly | One helm with explicit hand-over, plus craft sovereignty: every owner keeps their own craft's stage stack, ports and lend policy, and either side of a port can always release it. Arriving craft go to "docked free drift". Section 3.7. |
| 7 | Collisions | Convex colliders derived from part data, three broad-phase mechanisms (rails-rails conjunction screening, a coarse hash for integrated-rails, islands for integrated-integrated), conservative advancement for fast pairs, and three impact regimes by closing speed (contact, crash, hypervelocity). Section 4. |
| 8 | Authority | The whole contact pipeline is deterministic code shared by client and server, but only the server's result counts for anything irreversible: destruction, joint breaks, capture, hard dock, undock, spawned ids. Section 4.8. |
| 9 | Compute placement | Run every attended vessel at full fidelity on the server; clients predict their own vessel with the same code. The island is the unit of sharding. Section 4.9. |
| 10 | Launch complex | Sites carry a list of pads. Ka Lae gets six pads; a second site about 147 deg of longitude away gives a daylit pad at almost any hour. Pad dwell is limited and visible; a range-safety rule protects other pads. Section 5. |

### Facts a designer must not miss

1. **Stage separation would destroy the stack on the first day of vessel-vessel contact.** The hand-off
   shows the separated envelopes overlap for 0.01 to 0.39 s after every stage event (engine bells sit
   inside the interstage cylinder, the capsule inside the boost cover). A "born overlapping" exemption is
   mandatory (4.4).
2. **`instanceId` is unique only within one `VehicleDef`.** Two ferries of the same type docked together
   both have a part `capsule`. Renderer, events, stage actions and persistence need the key
   `craftId/instanceId` (2.7).
3. **`Vessel` assumes one `VehicleDef`** (`vehicle`, `nextStage`, `pending`, `stageLockout`). A docked
   assembly has several stage stacks, abort sequences and cockpits. This is the main in-place refactor.
4. **Do not re-root a craft's part tree when it docks.** `decouple` cuts "the joint to the PARENT"; reversing
   parent links along the path to the port would silently change which face a decoupler opens.
5. **Rigid-body impulses are meaningless at orbital closing speeds.** At 15.6 km/s a craft moves 130 m per
   1/120 s step (computed). Above about 250 m/s the outcome has to be an energy rule, not a contact solve.
6. **float64 is not enough for docking in heliocentric space.** Position spacing is 3e-5 m at 1 AU and 1e-3 m
   at Neptune's distance, which appears as 4 mm/s and 0.12 m/s of velocity noise at 120 Hz (computed). Inside
   any planet's sphere of influence it is fine. Islands must integrate relative to a local origin (4.2).
7. **One universe clock means Ka Lae is dark half the time.** A second site far away in longitude is a
   playability feature, not decoration (5.1).
8. **Pads are the capacity bottleneck of the mega-lobby**, not CPU: 12 pads give roughly 180 to 480 launches
   per hour depending on dwell (computed, 5.3).
9. **The sim is cheap enough to run everyone on the server**: 23 to 29 microseconds per step for the 38-part
   stack (measured, `sim-vessel.md`), so about 300 full-fidelity vessels per core at 1x (computed).
10. **Only the Kestrel has a cockpit interior.** Each additional crewed command part is an interior to
    build. The fleet is arranged so that one interior serves every crewed vehicle (2.2).
11. **Outer-planet Hohmann transfers take 2.7 to 30.7 years** (computed). The cruiser's reach is a
    delta-v statement; whether anyone waits for it is the warp model's problem.
12. **Pad surfaces are analytic.** A pad is a `flattenDisc` at a fixed elevation, so the server can
    adjudicate everything on a pad without terrain tiles. It does need tiles wherever else it decides ground
    contact (lunar landings).
13. **`Math.sin` and friends are not guaranteed bit-identical between Node 24 and the player's Chrome.**
    Client prediction must tolerate last-digit differences; the server snapshot always wins.
14. **The lunar mission's golden hash must not move.** Every change below is a no-op for a vessel with one
    craft and no links, and `meridian-lunar.json` is not edited.

---

## 1. What exists and what it assumes

| Today (wave 1) | Where | Consequence for v2 |
|---|---|---|
| A vessel is a tree of parts; parents precede children; `parts[0]` is the root and the VES origin | `src/sim/vessel/types.ts`, `assemble.ts` | Keep. A docked assembly is several such trees. |
| One `VehicleDef` per vessel, with one stage stack | `Vessel.vehicle`, `nextStage`, `pending`, `stageLockout`, `sinceStaging` | Move into `crafts[]`. |
| Splitting conserves momentum by construction | `split.ts` `separateVessel` | Reuse for undocking; teach it about links. |
| `mergeVessels(base, other)` already joins two vessels rigidly (launch clamps) | `split.ts` | Generalise into the docking merge. |
| Propellant flows inside a stage group only, by label equality | `structure.ts` `tanksFor` | Key by craft and group; add explicit transfer and cross-feed. |
| Vessels do not collide; `vesselClearance(a, b)` measures the gap between convex part envelopes | `clearance.ts`, ARCHITECTURE section 1 row 27 | The envelopes become the default colliders. |
| Ground contact: penalty probes at 480 Hz with stick-slip friction | `dynamics/contact.ts` | Unchanged; vessel-vessel contact is a separate pass. |
| One physics bubble of 25 km about the one active vessel; at most 24 debris | `world/sim.ts` `BUBBLE_RADIUS`, `MAX_DEBRIS` | Islands per cluster; debris budgets per collision and per owner. |
| Destruction, explosion impulse, joint over-stress by g-load | `dynamics/failure.ts` | Extend to other vessels in the island. |
| Spawned ids `<vessel id>~<root part instance id>` | `split.ts` | Keep the scheme with the craft id as base. |
| One site with one pad | `LaunchSiteDef.pad` | A list of pads. |
| `setTarget(bodyId)`; navball already has `target` / `antiTarget` markers | `controls.ts`, `sim.ts` | Targets become bodies, vessels or ports. |

---

## 2. The fleet

### 2.1 Design rules

- Three launchers by size. A launcher is a sub-assembly; a selectable vehicle is launcher plus payload.
- Naming follows what is there: launchers are sky-geometry words (Meridian, Solstice, Azimuth), engines are
  stars and constellations (Atlas, Vela, Lyra, Wren, Canopus), spacecraft are birds (Kestrel, Heron, Egret,
  Pelican, Albatross). The station module is Atoll. All fictional.
- Propellants stay within `resources.json`: LOX/CH4, LOX/LH2, RCSProp, SolidProp, Ablator. The nuclear
  thermal engine burns LH2 alone, so no new resource is needed.
- No low-thrust propulsion. Ion engines need months of thrust, which patched conics, maneuver nodes and
  rails warp cannot express. The high-Isp stage is nuclear thermal (900 s), which burns for minutes.
- Uncrewed craft need command authority without crew: a `command` module flagged `remote`.

### 2.2 The vehicles

Masses in kg. "Ideal dv to orbit" is the rocket-equation sum with the first stage at the mean of its
sea-level and vacuum Isp; the existing stack needs about 9 250 to 9 450 m/s hand-flown (`sim-design.md`
13.2). All values computed.

| # | Vehicle id | Stack | Lift-off mass | Lift-off TWR | Ideal dv to orbit | What it is for | Flight profile | Cockpit |
|---|---|---|---|---|---|---|---|---|
| 1 | `azimuth-pathfinder` | Azimuth 1 (2 stages) + Pathfinder probe | 60 500 | 1.35 | 10 180 | Smallest, quickest launch; a probe that can orbit the Moon, Venus or Mars | Launch, deploy, long coast, one capture burn | none (uncrewed) |
| 2 | `solstice-kestrel` | Solstice (2 stages) + Kestrel LF crew ferry | 600 950 | 1.32 | 11 420 | Crew ferry for low-orbit rendezvous and docking; capsule returns under parachutes | Launch, phasing, proximity operations, docking, entry | `kestrel` |
| 3 | `solstice-atoll` | Solstice + Atoll station core | 609 700 | 1.31 | 10 000 | First module of a station: six ports, own bus | Launch, circularise, wait for visitors | none |
| 4 | `solstice-pelican` | Solstice + Pelican tug/tanker | 610 500 | 1.30 | 9 910 | Pushes modules, refuels craft, acts as a small depot | Rendezvous, dock, push or pump | none |
| 5 | `meridian-lunar` | Meridian (3 stages) + Heron lander + Kestrel (exists) | 2 756 100 | 1.30 | as flown | Direct-ascent lunar landing and return | Unchanged | `kestrel` |
| 6 | `meridian-egret` | Meridian (3 stages) + Egret lunar ferry | 2 750 500 | 1.30 | M-3 has 3 650 for TLI | Reusable single-stage lander shuttling between lunar orbit and surface | TLI, LOI, landing, ascent, rendezvous in lunar orbit, refuel | `kestrel` (shared cabin, see below) |
| 7 | `meridian-albatross` | Meridian M-1 + M-2 + Albatross cruiser | 2 744 200 | 1.30 | M-2 has 6 280 (existing stack: 6 197) | Interplanetary cruiser with 10.9 km/s from low Earth orbit | Long nuclear burns, interplanetary transfer, capture | none (remote), crew arrive by ferry |
| 8 | `meridian-pelican-heavy` (optional) | Meridian + Pelican Heavy depot | about 2 750 000 | 1.30 | - | Depot: 37 t of methalox in lunar orbit, or 104 t of LH2 in Earth orbit. No new parts | Launch, park, be docked to | none |

**One interior for every crewed vehicle.** The Egret's cabin should be the Kestrel pressure cabin without
heat shield and parachutes: same `CapsuleMouldLineDef`, same windows, same seats, so the finished cockpit
interior is reused unchanged and only the exterior generator differs. The Albatross flies under remote
command; its crew arrive in a Kestrel LF that docks to the nose port. If a second interior is wanted later
it is one more cockpit layout and nothing else changes.

### 2.3 Vehicle sheets

Dry masses include engines. Delta-v is vacuum, full tanks, computed.

**Azimuth 1** (light launcher, 2.2 m diameter, about 27 m tall)

| Element | Dry | Propellant | Engines | Thrust | Isp SL / vac | Burn | Size |
|---|---|---|---|---|---|---|---|
| Stage 1 | 3 600 | 44 000 LOX/CH4 | 5 x Wren-1 | 800 kN SL / 880 kN vac | 300 / 330 | 162 s | 2.2 x 17 m |
| Stage 2 | 950 | 10 500 LOX/CH4 | 1 x Wren-1V (restartable) | 110 kN | - / 355 | 332 s | 2.2 x 5 m |
| Fairing (2 panels) | 250 | - | - | - | - | - | 2.2 x 4.5 m |
| Pathfinder probe | 250 (bus 160, kick stage 90) | 950 LOX/CH4 | 1 x Lyra-K (pressure-fed, restartable) | 4 kN | - / 325 | 757 s | 1.6 x 2.2 m |

Stage 1 gives 3 822 (SL Isp) to 4 205 m/s (vac), stage 2 6 170 m/s at TWR 0.89. The probe has 4 999 m/s
from low orbit: lunar orbit costs about 3 980, a loose Venus orbit 3 910, a loose Mars orbit 4 340.

**Solstice** (medium launcher, 6.6 m diameter, about 23 t to low orbit)

| Element | Dry | Propellant | Engines | Thrust | Isp SL / vac | Burn | Size |
|---|---|---|---|---|---|---|---|
| Stage 1 (new) | 33 000 | 452 000 LOX/CH4 | 2 x Atlas-9M (exists) | 7.80 MN SL / 8.35 MN vac | 327 / 350 | 186 s | 6.6 x 22 m |
| Interstage (new, stays with stage 1) | 2 000 | - | - | - | - | - | 6.6 x 3 m |
| Stage 2 = `meridian-m3` + `vela-2v` + 2 x `meridian-m3-rcs-pod` (all exist) | 11 800 | 85 000 LOX/LH2 | 1 x Vela-2V | 1.00 MN | - / 452 | 377 s | 6.6 x 11 m |
| Payload adapter (`meridian-payload-adapter` exists for 6 m payloads; the ferry has its own) | 500 | - | - | - | - | - | - |

With a 23 t payload: stage 1 about 4 480 m/s, stage 2 5 435 m/s, total 9 910. With 25 t the total is
9 710, which is the practical limit. Stage 1 burnout is 5.3 to 5.7 g at full throttle; `meridian-m3`'s joint
limit is 6 g, so the pilot throttles back (Atlas-9M goes down to 50 %) or the limit is raised for this stack.
With the 11 t ferry the upper stage reaches orbit with about 2 km/s to spare.

**Kestrel LF** (crew ferry, payload of vehicle 2; 11 150 kg in orbit)

| Element | Mass | Notes |
|---|---|---|
| `kestrel-capsule` + `kestrel-apex-cover` (exist) | 5 000 | Entry configuration identical to the validated one |
| `dock-port-c` | 350 | Sits on the apex cover; carries a `decoupler` so it is jettisoned before entry |
| Plover service module | 1 900 dry + 3 500 LOX/CH4 + 400 RCSProp | `lyra-a` (60 kN, exists), four RCS quads of 4 x 220 N |
| `kestrel-les` (exists) + service-module fairing | 4 000 + 1 500 | Jettisoned in ascent; the tower stands on the port's docking face, so the port reads "occupied" until then |

Main engine 1 312 m/s, RCS about 210 m/s. Translation with two 220 N jets: 0.039 m/s^2.

**Atoll core** (station module, payload of vehicle 3; 22 200 kg; 4.4 x 11 m)

Dry 19 000 including an avionics ring (remote command, wheels), 2 600 LOX/CH4 with a `lyra-a` (434 m/s),
600 RCSProp with four quads of 4 x 440 N (0.079 m/s^2). Ports: one `H` at each end, four `C` around the
forward node. Crew capacity 6, launched empty.

**Pelican** (tug and tanker, payload of vehicle 4; 23 000 kg; 4.0 x 7.5 m)

Dry 3 900, RCSProp 500, 18 600 LOX/CH4 that both feed its `lyra-d` (200 kN, exists) and can be pumped out.
One `C` port on the nose, one on the side. Alone 5 839 m/s; pushing the Atoll core 1 872 m/s; pushing a
9.65 t ferry 2 977 m/s; about 16 700 kg deliverable after 300 m/s of its own manoeuvres. It cannot carry a
useful load to lunar orbit by itself (2 900 kg left), which is what the optional heavy depot is for.

**Egret** (lunar ferry, payload of vehicle 6; 54 200 kg; 6.0 m across, about 8 m tall)

Dry 8 600, RCSProp 600, 45 000 LOX/CH4, one `lyra-d`, `heron-landing-legs` (exist), cabin for four, one `C`
port on the roof. Launched under a new closed 6.6 m fairing (7 000 kg). Total 6 261 m/s. From the Meridian's
TLI: lunar orbit insertion 900, descent 2 150, ascent 1 900 leaves 4 100 kg and 1 311 m/s. Lunar TWR 2.9
after insertion; hover throttle 18.5 % at touchdown (Lyra-D idles at 10 %). Each later round trip between
low lunar orbit and the surface (4 150 m/s) needs 20 600 kg of propellant from a depot. It has no heat
shield: the crew go home in a Kestrel.

**Albatross** (interplanetary cruiser, payload of vehicle 7; 146 600 kg; 9.0 x 42 m)

| Element | Mass |
|---|---|
| Habitat (crew capacity 4, remote command, control moment gyros) | 9 000 |
| Bus: truss, radiators, power, RCS quads | 5 000 + 1 500 RCSProp |
| 2 x LH2 tank, 9 m x 12.5 m, 52 000 kg each | 13 000 dry |
| Cryocoolers and insulation | 2 000 |
| 3 x Canopus-N nuclear thermal engine, 250 kN, 900 s | 9 900 |
| Thrust structure, one `C` port (nose), one `H` port (side) | 2 200 |
| **Dry / LH2 / wet** | **41 100 / 104 000 / 146 600** |

10 908 m/s; first-burn acceleration 5.1 m/s^2; 85 kg/s; 1 224 s to empty. It rides the Meridian's first
two stages in place of the third (the M-2 has 6 280 m/s with it, against 6 197 with the existing stack).

### 2.4 Where the fleet can go

Hohmann transfers from a 200 km Earth orbit between circular coplanar planet orbits (computed; real windows
vary by a few hundred m/s). "Loose capture" is a burn at 1.2 planet radii into an orbit reaching 200 radii.

| Destination | Departure dv | Loose capture | Total one way | Transfer time | Albatross margin (of 10 908) |
|---|---|---|---|---|---|
| Moon (low orbit) | 3 130 | 850 to 900 | 4 000 | 3 to 4.5 d | - (Egret, Heron, Pathfinder) |
| Venus | 3 505 | 408 | 3 913 | 0.40 y | 6 995 |
| Mars | 3 613 | 723 | 4 336 | 0.71 y | 6 572 |
| Mercury | 5 556 | 6 497 | 12 053 | 0.29 y | out of reach without refuelling |
| Jupiter | 6 306 | 455 | 6 761 | 2.73 y | 4 147 |
| Saturn | 7 290 | 550 | 7 840 | 6.09 y | 3 068 |
| Uranus | 7 979 | 608 | 8 587 | 16.07 y | 2 321 |
| Neptune | 8 248 | 443 | 8 691 | 30.67 y | 2 217 |

The Albatross reaches and orbits all four outer planets one way with more than 2 km/s left for gravity
losses (its 20-minute departure burn is long for a low orbit; splitting it over two perigee passes helps)
and for flying faster than Hohmann. A Jupiter round trip with a loose capture back at Earth needs 10 416:
possible with 490 to spare. Mars and back needs 5 560. A refill from the LH2 depot restores the full
10.9 km/s. Circularising low around a giant planet costs 6 to 16 km/s and is not on offer.

Dependency: flying to another planet needs the Sun as an attractor and a heliocentric frame; today the Sun
is `gravityRole: 'lightOnly'` and Earth is the root body. That belongs to the solar-system research.

### 2.5 The part library

Twenty-five parts exist. About thirty are added; every one is data plus a visual generator entry.

| Group | New parts | Notes |
|---|---|---|
| Engines (4) | `wren-1` (176 kN vac, 300/330 s, 190 kg, gimbal 6 deg, 3 ignitions), `wren-1v` (110 kN, 355 s, 160 kg, restartable), `lyra-k` (4 kN, 325 s, 18 kg, pressure-fed), `canopus-n` (250 kN, 900 s, 3 300 kg with shadow shield, LH2 only, slow spool: about 20 s up, 30 s down) | `canopus-n` needs a plume look (`plume.ntr-hydrogen`) and a sound profile: data entries |
| Tanks and stages (7) | `azimuth-s1`, `azimuth-s2`, `solstice-s1`, `plover-sm`, `pelican-tank`, `egret-tank`, `tank-lh2-9m` | Same shape of data as `meridian-m3` |
| Command (4) | `pathfinder-bus` (remote), `avionics-ring-4` (remote; Pelican and Atoll), `egret-cabin` (crew 4, Kestrel mould line), `albatross-hab` (crew 4, remote) | |
| Station (1) | `atoll-core` | Six port mounts |
| Docking (3) | `dock-port-c`, `dock-port-h`, `dock-adapter-h-c` | Section 3.1 |
| Structure and aero (8) | `azimuth-interstage`, `azimuth-fairing`, `solstice-interstage`, `fairing-6m6-ogive` (closed), `kestrel-sm-adapter`, `kestrel-sm-fairing`, `truss-9m`, `nose-cap-9m` | `meridian-interstage-1` and `meridian-payload-adapter` are reused as they are |
| Utility (3) | `rcs-quad-220`, `rcs-quad-440`, `launch-clamp-s` | New craft carry RCS as separate radial parts so a builder can place them; the existing stages keep their embedded `rcs` modules. `meridian-launch-clamp` serves Solstice too |

### 2.6 How the schemas change in place

All additions are optional fields or new union members, so every existing file still loads.

**`PartDef`** (`src/core/contracts/defs.ts`)

```ts
attachNodes: {
  id: string; pos: Vec3Tuple; dir: Vec3Tuple;
  size: number;                              // unchanged: interface diameter, m
  kind?: 'stack' | 'mount' | 'dock';         // NEW, default 'stack'. 'mount' = engine or utility mount inside
                                             // a parent; 'dock' = the mating face of a docking port
  rollStepDeg?: number;                      // NEW, builder snapping; 0 or absent = free
}[];
surfaceAttach?: {                            // NEW: radial attachment, the other half of "stack or radial"
  attachable: boolean;                       // this part may sit on another part's skin
  pos: Vec3Tuple; dir: Vec3Tuple;            // the point and outward direction of THIS part that touches the skin
  accepts: boolean;                          // other parts may sit on this part's skin
};
symmetry?: { maxRadial: number; mirror: boolean };   // NEW, builder hint only
collision?: CollisionShapeDef[];             // NEW, section 4.1; absent = derived from `bounds` as clearance.ts does
crossfeed?: boolean;                         // NEW, default true; false on decouplers and docking ports
crashTolerance?: number;                     // NEW, m/s; absent = the lowest crashTolerance of its contact points, else 6
category: ... | 'dock' | 'habitat';          // two new members
resources?: { ...; transferable?: boolean }[];   // NEW, default true; false for Ablator and SolidProp
```

**`ModuleDef`**: one new member and one new field.

```ts
| { type: 'dockingPort';
    node: string;                            // id of the attach node (kind 'dock') that is the mating face
    portType: string;                        // 'c' | 'h' today; ports mate only with the same type
    gender: 'androgynous' | 'active' | 'passive';
    capture: { range: number; maxLateral: number; maxAngleDeg: number; maxRollDeg: number; rollStepDeg: number;
               minClosing: number; maxClosing: number; maxLateralSpeed: number; maxRateDegPerS: number };
    soft:    { frequencyHz: number; damping: number; maxForce: number; maxTorque: number; retractRate: number; timeout: number };
    hard:    { maxForce: number; maxTorque: number };          // strength of the docked joint
    undockImpulse: number;                   // N s
    transfer: { crew: boolean; resources: ResourceId[]; maxRate: number } }   // kg/s
// command module: add
    remote?: boolean;                        // command authority with no crew aboard
```

`ModuleState` gains `{ type: 'dockingPort'; state: 'disabled' | 'ready' | 'occupied' | 'soft' | 'hard' |
'cooldown'; armed: boolean; peer: { vesselId: string; partKey: string } | null; progress: number }`.
`StageAction` gains `{ kind: 'undock'; part: string }` so a pre-mated pair can be released from a stage
stack. `SimEvent` gains `dockCapture`, `docked`, `captureLost`, `undocked`, `collision`, and the cause
`'collision'` on `partDestroyed`.

**`VehicleDef`**

```ts
parts: VehiclePartPlacement[];               // unchanged: the flat part graph, the only thing the sim reads
uses?: {                                     // NEW: sub-assemblies, flattened into `parts` / `stages` by the loader
  assembly: string;                          // id of data/defs/assemblies/<id>.json
  prefix: string;                            // instance ids become '<prefix>-<id>'
  parent: string | null; parentNode?: string; node?: string;   // where its root part attaches
  resources?: Record<string, Record<ResourceId, number>>;      // per-part load overrides (off-loaded tanks)
}[];
padInterface?: {                             // NEW: what a pad needs to know (5.2)
  class: 'light' | 'medium' | 'heavy';
  umbilicals: { y: number; radius: number }[]; crewArm?: { y: number; reach: number };
};
cameras: { cockpit?: {...}; chase: {...} };  // cockpit becomes optional (uncrewed vehicles)
// VehiclePartPlacement gains
symmetry?: { group: string; index: number; count: number; mode: 'radial' | 'mirror' };   // builder metadata only
```

- An assembly file (`AssemblyDef`: `id`, `name`, `parts`, `stageGroups`, `stages`, `abort`, `actionGroups`)
  has the same fields as a vehicle. The loader concatenates stage stacks in the order of `uses` (launcher
  first), prefixes ids, checks uniqueness and hands the sim an ordinary flat `VehicleDef`. `assembleVessel`
  does not change. `meridian-lunar.json` stays flat and untouched.
- Symmetry is stored, not interpreted: each instance is listed with its own pose, as `atlas-1..9` and
  `clamp-1..4` already are. The builder uses the tag to move a group together.
- Two docking ports may be mated in the file (`node` and `parentNode` both of kind `dock`). The assembler
  records that joint as a dock link, so the craft can undock it in flight. This is how a stack launches
  pre-docked.
- A docking port whose face carries a stacked part (the escape tower on the ferry's port) is `occupied`.
- Menu text, capability tags and difficulty belong in a presentation section
  (`visuals/vehicles/<id>.json`), not in `VehicleDef`.

**`validateVehicle(defs, vehicle): Issue[]`** - one pure function in `src/core/defs`, used by the loader, by
the server on any craft it is asked to spawn, and later by the builder: one root; every part reachable; at
most one child per attach node; mated node sizes within tolerance or joined by an adapter; no two part
colliders overlapping beyond their mated faces; every stage action names an existing part with the needed
module; at least one `command` part; clamps present for a pad start; part count, mass and diameter within the
pad class. A builder is then a UI that edits a `VehicleDef` and calls this function. Stage groups, which are
authored today, can be derived by the builder as the connected regions between decouplers; the sim keeps
reading the stored label.

### 2.7 How the runtime model changes in place

```ts
interface CraftRuntime {                     // NEW (src/sim/vessel/types.ts)
  craftId: string;                           // server-assigned, globally unique, never changes
  vehicleId: string; vehicle: VehicleDef;
  ownerId: string | null;                    // player account; null = nobody (debris, expired)
  name: string;
  joinedUt: number;                          // when it became part of this vessel (seniority, 3.7)
  nextStage: number; stageLockout: number; pending: PendingAction[]; sinceStaging: number;   // moved from Vessel
  policy: { lendAttitude: boolean; lendEngines: boolean; lendPropellant: boolean };
}
interface DockLink { a: number; b: number; roll: number }      // part indices of the two port parts

interface Vessel {
  crafts: CraftRuntime[];                    // NEW; length 1 for anything that never docked
  links: DockLink[];                         // NEW; empty for anything that never docked
  helm: { playerId: string | null; craft: number; controlPart: number };   // NEW
  // vehicleId, vehicle, nextStage, stageLockout, pending, sinceStaging: removed (read through crafts[])
  ...
}
interface PartRuntime { craft: number; ... } // NEW: index into Vessel.crafts
```

- **Forest plus links.** Each craft keeps its own tree with its own root (`parent = -1`). Docked joints are
  `links`, never parent pointers. Decoupler semantics, joint strengths and "parents precede children" are
  untouched. Station rings (A to B to C to A) are just one more link. `separateVessel` computes connected
  components over tree edges and links instead of tree edges alone; that is its only structural change.
- **VES frame** stays the frame of `parts[0]`, the root of the base craft.
- **Control frame.** `helm.controlPart` says which part's axes the control inputs and the navball refer to
  ("control from here": the pilot's command part or a selected docking port). Today that is implicitly
  `parts[0]`.
- **Keys.** A part is addressed as `craftId/instanceId` everywhere outside the vessel (events, snapshot,
  renderer wear state, persistence). `PartSnapshot` gains `craftId`; `VesselSnapshot` gains `crafts`
  (id, vehicle, owner, name, stage info) and `links`.
- **Ids.** A single-craft vessel has `id = craftId`. Pieces split from it keep today's scheme,
  `<craftId>~<root instance id>`. An assembly keeps the id of its base vessel; a craft that undocks whole
  gets `craftId` back.
- **Stage stacks.** `fireNextStage` acts on one craft's stack and only on that craft's parts. Debris from a
  craft carries a copy of its craft record (owner kept for attribution and expiry).
- **Persistence** stores exactly this: vessel state, `crafts[]`, parts with their craft index, `links[]`.

### 2.8 Resource containers and flow rules

1. A flow group is `(craft, stageGroup)`. Engines and thrusters draw from tanks of their own flow group, as
   now. Docking never pools propellant by itself.
2. **Transfer**: a commanded pump between two flow groups that are connected through docked ports whose
   `transfer.resources` include the resource, limited by the smaller `maxRate`. An owner may always pump
   **out of** their own tanks; pumping out of someone else's needs that craft's `lendPropellant`. A transfer
   is a pure state process (mass moves, the centre of mass follows), so it continues on rails in closed form.
3. **Cross-feed**: an owner may open a docked port so that the two flow groups on either side count as one
   for engine draw (drop tanks, a depot feeding a cruiser's burn). Both owners must agree.
4. Parts with `crossfeed: false` (decouplers, closed ports) bound a flow region for the builder's derivation
   of stage groups.
5. Ablator and SolidProp are not transferable.

---

## 3. Docking

### 3.1 Port types and compatibility

| | Type C "crew" | Type H "heavy" |
|---|---|---|
| Use | Capsules, ferries, tankers, landers | Station modules, depots, the cruiser's refuelling port |
| Ring / passage diameter | 1.55 m / 0.8 m | 2.9 m / 2.0 m |
| Mass | 350 kg | 900 kg |
| Roll alignment | any of three positions, 120 deg apart (three guide petals) | any of four, 90 deg apart |
| Transfers | crew, LOX, CH4, RCSProp at 50 kg/s | everything including LH2 at 300 kg/s |
| Joint strength (`hard`) | 300 kN, 150 kN m | 2 MN, 1.5 MN m |
| Undock impulse | 600 N s | 2 000 N s |
| Crash tolerance | 2.5 m/s | 2.5 m/s |

Two ports can mate when they have the same `portType`, compatible gender (all are androgynous now; the field
is there for probe-and-drogue designs), both are `ready` (armed, not shielded by a fairing, face not
occupied, not already engaged) and neither is in cooldown. Different types meet through `dock-adapter-h-c`,
an ordinary part with one port of each kind.

### 3.2 Capture envelope

Measured between the two port frames at the moment the faces come within `capture.range`. Each port frame has
an outward axis `n` and a roll reference `u`. With `d` the vector from port A to port B and `vRel` the
velocity of B's port point relative to A's:

- axial gap `d . nA`; lateral offset `|d - (d . nA) nA|`
- angular misalignment `acos(-nA . nB)` (pitch and yaw together)
- roll: angle between `uA` and `uB` about `nA`, taken to the nearest allowed step
- closing speed `-vRel . nA`; lateral speed `|vRel - (vRel . nA) nA|`; relative angular rate `|wB - wA|`

| Limit | Type C | Type H | Real docking standard, for comparison (IDSS, from memory - verify) |
|---|---|---|---|
| Capture range (gap) | 0.10 m | 0.10 m | - |
| Lateral offset | 0.20 m | 0.30 m | 0.10 m |
| Angular misalignment | 6 deg | 5 deg | 4 deg |
| Roll error to the nearest step | 6 deg | 5 deg | 4 deg |
| Closing speed | 0.03 to 0.30 m/s | 0.01 to 0.15 m/s | 0.05 to 0.10 m/s |
| Lateral speed | 0.08 m/s | 0.05 m/s | 0.04 m/s |
| Relative angular rate | 0.6 deg/s | 0.3 deg/s | 0.2 deg/s |

The proposed values are two to three times wider than the real standard: keyboard flying under network delay
needs the room, and the ferry's 0.039 m/s^2 of translation still makes the corridor a matter of skill. They
live in the port part's data.

Outcomes at the faces:

- Inside the envelope: soft capture.
- Outside it but slower than the crash tolerance: the ports are ordinary colliders, the craft bounce, and
  the readout names the limit that was missed ("lateral 0.31 m, limit 0.20").
- Faster than the crash tolerance: collision damage (section 4.5).

### 3.3 Soft capture, then hard dock

```
ready --(faces within range, envelope met, both armed)--> soft --(residuals small for 0.5 s)--> hard
  ^                                                         |                                     |
  +----- cooldown (10 s, or until 1 m apart) <--------------+-- force/torque limit or timeout     +-- undock
```

**Soft capture** is a compliant six-degree-of-freedom constraint between the two port frames. The two
vessels stay separate rigid bodies in one island.

- Force `F = -k x - c v`, torque likewise on the angular error, applied equal and opposite at the two port
  points, evaluated in the 480 Hz sub-steps.
- Stiffness is scaled to the pair: `k = mu wn^2`, `c = 2 zeta mu wn`, with `mu` the reduced mass
  `m1 m2 / (m1 + m2)`, `wn = 2 pi x 0.2 Hz`, `zeta = 1`. For a ferry on a 400 t station that is 17 kN/m and
  27 kN s/m: 3.4 kN at the full 0.2 m offset, 8 kN at 0.3 m/s (computed). The angular terms use the reduced
  inertia the same way.
- Force and torque are clamped at `soft.maxForce` / `maxTorque` (15 kN and 10 kN m for C, 40 kN and 30 kN m
  for H). If the clamp is reached for more than 0.5 s (someone thrusts away), or `soft.timeout` (60 s)
  passes, the latches let go: `captureLost`, both ports to cooldown.
- The target gap retracts to zero at `retractRate` (0.02 m/s).
- The two port colliders ignore each other while the pair is in soft capture.

**Hard dock** happens at a step boundary once offset < 3 mm, angle < 0.1 deg and relative speed < 3 mm/s
have held for 0.5 s.

### 3.4 What happens on merge

The heavier vessel is the base (equal mass: the lower id). The merge is `mergeVessels` generalised:

1. The other vessel's parts are re-expressed in the base's VES, keeping their own tree and root. The residual
   offset (millimetres) is removed by snapping the two port frames together.
2. A `DockLink` joins the two port parts, with the roll step that was captured.
3. **Mass properties** are recomputed by the existing `computeMassProps` over all parts.
4. **Momentum**: linear momentum `m1 v1 + m2 v2` fixes the velocity of the new centre of mass; angular
   momentum about it, `sum (I_i w_i + m_i (c_i - c) x (v_i - v))`, fixes the new angular velocity through
   the merged inertia tensor. The kinetic energy that disappears is that of millimetres per second.
5. **Crafts**: the other vessel's craft records are appended with `joinedUt = now`. Each keeps its stage
   stack, abort sequence, action groups, pending timed actions and owner.
6. **Resources**: nothing pools (2.8).
7. **Control authority**: the base's helm stays. The arriving craft's actuators go to docked free drift
   (3.7). The structure cache is rebuilt, so the actuator allocation sees every lent wheel and thruster with
   its true lever arm about the new centre of mass.
8. **One SAS** per vessel, the helm's.

Limits (configurable): at most 600 parts and 32 craft in one assembly; a capture that would exceed them is
refused with a message. The measured step is 27 microseconds for 38 parts; if the cost grows in proportion to
the part count (not measured), a 300-part station under thrust costs about 25 ms of CPU per second. On rails
it costs nothing.

**Strength of a docked joint.** The assembly is rigid; internal loads are not solved. As with the existing
`maxAccelG` check, the link breaks when the force needed to accelerate the lighter side,
`m_side x |proper acceleration|`, exceeds `hard.maxForce`, or the torque needed for its angular acceleration
exceeds `hard.maxTorque`, for 0.2 s. A Pelican pushing the Atoll core puts 98 kN through a C port (limit
300); a 1 MN upper stage pushing a 100 t station through one puts 510 kN and tears it off. The rule the
player learns: do not burn hard through a docking port.

### 3.5 Undock

1. The owner of either port commands the release (or a stage action does).
2. The link is removed; `separateVessel` splits the forest into its connected components. Each piece keeps
   the rigid-body velocity of its own origin and the common angular velocity, so momentum is conserved by
   construction (this is the existing, tested behaviour).
3. The spring impulse `undockImpulse` acts equal and opposite along the port axis **at the port**, so a side
   port gives both a push and a turn: `dv = J / m`, `dw = I^-1 (r x J)`. This differs from the existing
   decoupler, which pushes the centres of mass only. 600 N s gives a ferry leaving a station about 5 cm/s.
4. Both ports go to cooldown, so they cannot recapture each other at once.
5. Craft records go with their parts. The piece holding the helm's craft keeps the helm; every other piece
   gets its own online owner as helm, or none. Throttle is zero on every piece without the old helm.
6. If two links joined the same pair of pieces (a ring), removing one changes nothing but the link list.

### 3.6 Persistent assemblies of many owners, station building

- An assembly is one vessel record holding several craft, each with its own owner. Docking never changes who
  owns what.
- A station is built by docking modules to H ports, craft to C ports, with a tug where the module has no bus.
- The **anchor craft** of an assembly is the one that has been in it longest (`joinedUt`, ties by craft id).
  Seniority, not mass: nobody takes a station over by docking something heavier. When the anchor undocks,
  the next most senior craft becomes the anchor.
- Hooks for the persistence research: expiry should be decided per craft, with the assembly alive while any
  member is; a craft whose owner's claim has lapsed becomes unowned and the anchor's owner may release it.

### 3.7 Who controls a docked assembly

| Option | How it works | For | Against |
|---|---|---|---|
| A. One helm, explicit hand-over | One pilot steers; others ask and are granted | Clear, predictable, what real crews do | A passenger is passive until granted |
| B. Owner of the largest part or craft | Authority follows mass | No interface needed | Docking something heavier steals a station; authority flips as tanks drain |
| C. Per subsystem | Everyone drives their own actuators at once | Everyone has something to do | Inputs fight; the assembly tumbles; no one can fly a burn |
| D. Voting | Actions need a majority | Fair on paper | Useless in the seconds a burn takes; offline members block everything |

**Recommendation: A, with craft sovereignty and lend policies.**

1. **One helm or none.** The helm's inputs (attitude, translation, throttle, SAS mode) drive the vessel. They
   act through the helm's own craft and through the actuators other craft have lent.
2. **Docked free drift.** At hard dock the arriving craft's engines, thrusters and wheels are inhibited, as
   visiting vehicles are in real operations. They rejoin the pool only under the assembly's helm and only as
   far as their owner's policy allows: `lendAttitude` (wheels and RCS, default on), `lendEngines` (default
   off), `lendPropellant` (default off).
3. **Craft sovereignty.** Every owner always keeps, for their own craft: the stage stack, the abort sequence,
   action groups, arming and releasing their own ports, pumping out of their own tanks, and their lend
   policy. None of that needs the helm's consent.
4. **Who is helm.** At dock the base vessel's helm stays. The anchor's owner may take the helm at any time.
   Otherwise the anchor's `helmPolicy` decides: `owner` (nobody else, ever), `crew` (any docked pilot when
   the helm is vacant; the default) or an allow-list. Hand-over is a request; the helm grants it, or it is
   granted automatically after 30 s if the helm has given no input in that time.
5. **Either side can always let go.** A port is released by the owner of the craft it belongs to. That is
   the whole of the undock rights: you can always leave, and you can always make a visitor leave your port.

Edge cases:

| Case | Rule |
|---|---|
| Helm disconnects | Helm becomes vacant at once; throttle goes to zero; SAS keeps its mode. The next pilot may take it under rule 4. |
| Owner offline, craft docked | The craft stays, inhibited, with its lend policy as left. Its port still releases from the other side. |
| Both owners offline | Nothing changes; the assembly persists on rails. |
| Uninvited docking | A capture needs **both** ports armed, so an owner who wants no visitors disarms (state persists offline; "lock when I leave" is a setting). A visitor who does dock is in free drift and cannot steer; the port's owner releases them. |
| Visitor tries to drag a station away | Their engines are inhibited while docked; the only way to push is to become helm, which the anchor's policy governs. A hard burn through the port breaks the joint. |
| Helm burns while a passenger wants out | The passenger releases their port; momentum is conserved; their engines start at zero throttle. |
| A passenger stages | Allowed; it is their craft. The pieces separate physically from the assembly. |
| Propellant theft | Impossible without `lendPropellant`; gifts are always possible. |
| Two attended craft dock | The heavier craft's pilot is helm; the other is in free drift until granted. |
| Reconnect | The player is back in their own craft's seat; if the helm is vacant and the policy allows, they may take it. |
| Warp while several pilots share one assembly | One vessel has one time. Whether warp needs everyone's consent is the warp model's decision; the hook is that a vessel knows its online pilots. |

---

## 4. Collisions

### 4.1 Contact shapes from part data

```ts
type CollisionShapeDef =
  | { kind: 'cylinder'; radius: number; yMin: number; yMax: number }
  | { kind: 'frustum'; r0: number; y0: number; r1: number; y1: number }        // capsule side wall, engine bell
  | { kind: 'capsule'; a: Vec3Tuple; b: Vec3Tuple; radius: number }            // struts, legs, booms
  | { kind: 'box'; centre: Vec3Tuple; size: Vec3Tuple; rotationDeg?: Vec3Tuple }   // arrays, trusses
  | { kind: 'hull'; points: Vec3Tuple[] }                                      // at most 32 points
  | { kind: 'shell'; rInner: number; rOuter: number; yMin: number; yMax: number; segments: number };   // hollow ring
```

- Every shape is convex or a small set of convex pieces (`shell` expands to wedges exactly as `clearance.ts`
  already covers a fairing panel with six prisms).
- With no `collision` entry the collider is what `clearance.ts` `partShape` builds today: the `bounds`
  cylinder, the cylinder around hinges and feet for a `legs` part at its current deployment, the wedge set
  for a jettisoned fairing panel. So every existing part collides without new data.
- Author shapes only where the bounds cylinder is badly wrong: the capsule (frustum), engine bells
  (frustum), legs (one capsule per strut), interstages and adapters (shell, so a bell can sit inside one),
  docking ports, arrays and trusses.
- Each vessel keeps a bounding-volume tree of its part colliders in VES, rebuilt with the structure cache.
- Parachute canopies and lines do not collide. Parts of one vessel never collide with each other.

### 4.2 Broad phase at orbital scale

Three mechanisms, by what the two objects are doing. The invariant: **every pair is either proven apart
until one of them changes orbit, or has a scheduled encounter that is integrated.**

1. **Rails against rails: conjunction screening**, per sphere of influence, run when an object's orbit
   changes (end of a burn, SOI change, spawn, undock), against the others there.
   - Shell filter: perigee-to-apogee intervals, padded, must overlap. Sort and sweep, O(N log N).
   - Path filter: minimum distance between the two conics.
   - Time filter: closest approach in time over the horizon. sim-orbits has this search against a body
     (`closestApproaches`, `docs/handoff/sim-orbits.md`); the same root finding against a second vessel's
     conic is what is needed, and the multiplayer map needs it too.
   - A predicted miss below the two bounding radii plus a margin (rails states are exact Kepler states, so
     10 m is enough) schedules an **encounter event**. Shortly before it both objects are promoted into an
     integrated island, the pass is resolved with continuous detection, and they return to rails.
   - Between orbit changes this costs nothing.
2. **Integrated against rails: a coarse hash.** An attended vessel's path is not predictable. Per body, the
   positions of rails objects are refreshed into a spatial hash about once a second, with a cell size above
   the largest closing speed times the refresh period (2 x escape speed x 1 s, about 22 km in low Earth
   orbit; use 64 km). Five thousand objects cost under 2 ms per refresh at the 0.33 microseconds per
   propagation that sim-orbits measured.
   A rails object within the join distance of an integrated vessel is promoted into its island.
3. **Integrated against integrated: islands.** Two integrated vessels join one island when their separation
   is below `1 km + 2 s x closing speed`, and part again at twice that. Inside an island: sweep and prune on
   bounding spheres, then the part trees.

Islands replace the single 25 km bubble about the one active vessel. A vessel alone is an island of one and
steps exactly as today.

**The island frame.** In a planet's sphere of influence, positions relative to the body centre are good to
1e-9 m (low Earth orbit) or 6e-8 m (lunar distance). In heliocentric flight they are not: 3e-5 m at 1 AU,
1e-4 m at Jupiter, 1e-3 m at Neptune, and two vessels round differently every step, which shows up as
0.004, 0.015 and 0.12 m/s of relative velocity noise (computed). Hard dock needs 3 mm/s. So an island
integrates **relative to a local origin that follows an exact Kepler orbit**: each vessel's state is the
small offset from that origin, and gravity enters as the difference between the acceleration at the vessel
and at the origin, evaluated without cancellation (Encke's method with Battin's `f(q)`). In code,
`VesselEnvironment` gains an optional origin state; with none, everything is exactly as now, so near-planet
flight and the existing mission are unaffected. This is what makes "close docking anywhere in the solar
system" true.

### 4.3 Continuous detection: nothing tunnels

Travel per 1/120 s step (computed): 0.08 m at 10 m/s, 8.3 m at 1 km/s, 65 m at 7.8 km/s, 130 m at 15.6 km/s
(head-on in low orbit). Craft are 3 to 110 m long. Physics warp runs more steps, never longer ones.

Per pair in an island, each step:

1. **Sphere sweep.** With relative position `p` and velocity `u` of the centres, skip the pair if
   `|p| - Ra - Rb > |u| dt + margin`. Relative acceleration over 8 ms is negligible.
2. **Slow pairs** (relative travel per step below a quarter of the thinnest collider, about 10 m/s):
   speculative contacts. A contact constraint is created while the shapes are still a margin apart, allowing
   only the approach speed that closes the gap in one step. Docking and bumping live here.
3. **Fast pairs**: conservative advancement. Advance the pair by `gap / (|u| + ra |wa| + rb |wb|)` (GJK gives
   the gap and the closest features; the angular terms bound what rotation can add) until the gap is below
   tolerance or the step ends. That yields the time of impact, the contact point and normal on the first
   pair of parts to touch. The impact is processed at that time.

Rails objects cannot tunnel because they are never stepped: the screening of 4.2 covers them.

### 4.4 Contact response and friction

A vessel-vessel contact pass runs per island after the per-vessel step, in the same 480 Hz sub-steps the
ground contact uses when anything is within half a metre. The ground model (penalty probes) is unchanged.

- Sequential impulses over the island's contact points: fixed iteration count (8), fixed order (vessel id,
  then part index), warm started, positional correction of 20 % of the penetration beyond 5 mm.
- Restitution 0.2 above 0.3 m/s normal speed, 0 below. Coulomb friction 0.5 in two tangent directions.
- The soft-capture constraint of 3.3 is solved in the same pass.

**Born overlapping.** The staging tests show the separated envelopes interpenetrate at the instant of
separation and come apart 0.01 to 0.39 s later (clamps 0.01 s, M-1 against the Vela-2 bells 0.28 s, the
tower 0.39 s, fairing petals 0.34 s). Therefore: vessels created by one split, and a pair that has just
undocked, are a **nascent pair**; contact between them is ignored until their colliders have first been
fully apart (5 cm). From then on they collide like anything else. Without this rule the first stage
separation after contact is switched on wrecks the stack. Authoring interstages as `shell` colliders shortens
the window but does not remove the need.

### 4.5 Structural damage and break-up

Three regimes by the normal closing speed `vn` at the first contact:

| Regime | Condition | What happens |
|---|---|---|
| Contact | Energy below both parts' tolerance | Impulses only: bump, scrape, a missed docking |
| Crash | Tolerance exceeded, `vn` below about 250 m/s | The overloaded parts are destroyed; joints may break; pieces separate |
| Hypervelocity | `vn` above about 250 m/s | No rigid solve; mass is removed by an energy rule |

**Crash.** The solver gives the energy lost in the collision, `E = 1/2 mu vn^2 (1 - e^2)`, with `mu` the
effective mass at the contact. Each of the two touching parts takes half. A part is destroyed when its share
exceeds `1/2 m_part crashTolerance^2`, where `crashTolerance` is the existing per-part number (3 m/s for
tanks, 4 to 9 for the capsule, 6 for derived probes). So the tolerance means "this part survives hitting
something immovable at this speed", which is what it means against the ground. Examples (computed): two
11 t ferries at 2 m/s lose 11 kJ, 5.6 kJ each, against 37 kJ for the capsule: they bounce. At 6 m/s it is
50 kJ each: the capsule wall fails. A 50 kg fragment at 100 m/s carries 250 kJ: a 9.5 t tank (43 kJ) is
holed, and explodes if it holds propellant.

**Joints.** The velocity change of each vessel, `dv = J / m`, is turned into an equivalent acceleration over
a nominal 0.05 s and compared with the joints' existing `maxAccelG`; joints over the limit break and
`separateVessel` makes the pieces. A ferry stopped from 2 m/s sees 4 g (nothing breaks); from 6 m/s, 12 g
(engines and adapters rated 8 to 12 g come off).

**Hypervelocity.** Following the NASA standard breakup model:

- Catastrophic when the impactor's kinetic energy divided by the target's mass exceeds 40 kJ/kg: every part
  of both vessels is destroyed.
- Otherwise the impactor is destroyed and the target loses mass `m_impactor x (v / 1 km/s)^2`, taken from
  the parts nearest the impact point in order of distance. An 11 t ferry into a 400 t station at 1 km/s is
  14 kJ/kg: the ferry is gone and about 11 t of station around the impact with it. At 300 m/s it is 1 t.
- Survivors keep their velocity; the destroyed mass carries its own momentum away, so the total is conserved.

**Debris.** Destroyed parts vanish into effects, as they do today (`partDestroyed`, `explosion`); there are no
half-parts. What persists are the surviving connected components, each an ordinary vessel. That bounds growth
by itself: a collision cannot create more objects than there were parts. On top of that: at most twelve new
vessels per collision (largest first, the rest removed with reason `limit`), fragments under 50 kg live 60 s
(existing rule), and a debris budget per owner. The numbers belong to the expiry rules.

### 4.6 Explosion of propellant

The existing model stands (`failure.ts`): a destroyed tank with more than 5 % burnable propellant explodes,
150 N s per kg spread over the sphere, each piece taking the share its presented area cuts out at its
distance, capped at 60 m/s. The only change is that the pieces now include **other vessels in the island**.
An 18.6 t Pelican exploding gives a ferry 50 m away 0.12 m/s, one 10 m away 3 m/s, and a station module 5 m
away 16 m/s, which by the joint rule is 32 g and breaks it (computed, taking 15 m^2 of presented area for
the ferry and 40 m^2 for the module). A destroyed neighbour's tank explodes on the next step; the chain runs
in part order with a cap per step.

### 4.7 Cost

Estimated, not measured: narrow phase for two 40-part craft at arm's length is a few dozen part pairs after
the trees at a few microseconds each, so under 0.1 ms per step. The screening and the hash are background
work of a few milliseconds per second.

### 4.8 What is deterministic and what the server alone decides

**Deterministic** (a pure function of state and inputs, the same TypeScript on client and server, no
`Math.random`, fixed iteration order and counts): free flight, the contact pass, the capture state machine,
the damage and breakup rules, explosion impulses, the choice of which fragments survive (by mass, then
index). This is what lets tests hold golden hashes, lets the server replay an incident from its input log,
and lets a client predict.

**Decided by the server alone** (clients display these only when told):

- whether a contact destroyed anything, broke a joint or exploded a tank;
- soft capture, capture lost, hard dock, undock; the merge and the split and the resulting ids;
- ids and ownership of every spawned vessel;
- island membership, promotions from rails, encounter events;
- resource transfers, helm and lend-policy changes;
- pad assignment, pad timers, range safety (section 5).

A client may predict the motion of its own vessel, including a bump. It must not predict anything
irreversible: a destroyed part or a merged vessel that the server then denies cannot be rolled back
gracefully. The delay of one round trip is hidden by the effect's own build-up.

Bit-identical results between the server (Node 24) and a player's browser are not guaranteed for `Math.sin`,
`cos`, `exp`, `pow` and similar, which engines may implement differently across versions. Prediction must
tolerate last-digit drift and take the server's state as truth. If lock-step or audit of client-run physics
is ever wanted, the sim needs its own arithmetic-only implementations of those functions.

### 4.9 Where the computation runs

- **Measured**: one step of the 38-part stack at max-q costs 23 to 29 microseconds. At 120 Hz that is about
  3.3 ms of CPU per vessel-second: **about 300 full-fidelity vessels per core at 1x** (computed), fewer under
  physics warp (4x warp is four times the steps). Rails vessels cost nothing between events.
- **Recommended balance**: the server integrates every attended vessel and every island; the client runs the
  same code to predict its own vessel between snapshots and renders everyone else from server state. Contact,
  docking and damage exist only on the server.
- **Sharding**: an island shares no state with another island within a step, so islands can be spread over
  worker threads or processes. That is the scaling path that keeps the mega-lobby coherent.
- **Client-run solo flight with server audit** (the client simulates a vessel that is alone, the server
  re-runs sampled windows of its input log) would move the per-step cost to players. It is not needed at
  these costs, it opens cheating, and it meets the determinism caveat of 4.8. Keep it as an option: a
  per-vessel authority field is the only hook required. Anything involving two owners stays on the server.
- **Terrain**: wherever the server decides ground contact it needs the height authority's data. Pads are
  flattened discs at a fixed elevation, so launches and pad accidents need none. Landings elsewhere need the
  tiles of that region on the server.

---

## 5. Launch complex

### 5.1 Sites and pads

**Ka Lae** (exists, 18.99 N, 155.60 W). Six pads, all inside the existing 100 km high-resolution region, so
no new bake: `lc-1` (exists) and `lc-2` heavy, `lc-3` and `lc-4` medium, `lc-5` and `lc-6` light, strung
along the coast. Spacing follows the flattened discs: a heavy pad's blend radius is 900 m, so heavy pads sit
at least 2.5 km apart; light pads (flat 150 m, blend 300 m) at least 1 km. Exact positions come from the
site-resolve tool with the rule that placed LC-1 (flat, dry, clear of the shore).

**A second site about 147 deg away: the Arabian Sea coast of Oman, near 19.0 N, 57.8 E** (a fictional
facility at a real place; `sim-design.md` 15.1 already names this coast as an alternate).

- Same latitude as Ka Lae, so both sites reach the same orbit planes (a station at 19 to 21 deg, the lunar
  plane) directly. Craft from the two sites can meet without plane changes.
- 14.2 hours of solar time apart. With one universe clock, both sites are dark together for only about two
  hours a day; with Ka Lae alone, the only pad is in darkness half of every day.
- Barren desert coast, open sea to the east: it looks right at ground level without vegetation, the reason
  LC-1 is where it is.
- Cost: one regional Earth bake (elevation outside the United States is about 30 m, adequate for a flat
  coast) and a structures file. Not verified here: the terrain at the nominal point; the resolve tool
  decides.
- Cheaper fallback: a second complex 40 to 60 km up the coast inside the existing region. It adds pads but
  not daylight.

The Moon region that is already baked could carry a surface pad as a site later (`bodyId` is data); players
launch from Earth for now.

### 5.2 Schema change in place

```ts
interface PadDef {
  id: string; name: string;
  offsetEnu: [number, number];               // metres east / north of the site reference point
  azimuthDeg: number;                        // what LaunchSiteDef.padAzimuthDeg is today
  class: 'light' | 'medium' | 'heavy';       // a pad hosts its class and anything smaller
  maxLiftoffMass: number; maxDiameter: number;
  flatRadius: number; blendRadius: number; mountHeight: number;   // mountHeight = today's clampHeight
  keepOutRadius: number;
  structures: LaunchSiteDef['structures'];
}
interface LaunchSiteDef { ...; pads: PadDef[] }   // replaces `pad`, `padAzimuthDeg`, `structures`
```

- The resolved latitude, longitude and elevation of each pad go into the site's location file, written by
  the resolve tool, as now for the one pad.
- The terrain's `flattenDisc` modifiers should be derived from the pads at load instead of being restated in
  the body file.
- The umbilical tower's arm heights are tuned to the Meridian today. For a pad to host any vehicle of its
  class, the tower takes them from `VehicleDef.padInterface` when a vessel is rolled out.
- The existing site id `ka-lae-lc1` is referenced by scenarios, the region manifest and file names. Either
  keep it as the site id with `lc-1` as its first pad, or rename to `ka-lae` in one sweep; the lead's call.

### 5.3 Pad assignment for concurrent launches

Pad states: `free -> reserved -> occupied -> clearing -> free`.

1. The player picks a vehicle in the menu and asks to launch, optionally naming a site or pad.
2. The server picks a free pad of sufficient class (the named one if free, else the least recently used at
   the preferred site, else the other site), reserves it and spawns the craft on the clamps
   (`hold: 'clamps'`, `prelaunch`). Vehicle preparation happens in the menu, not on the pad, so the pad is
   occupied only for the countdown.
3. No free pad: the player joins a queue, sees their position, and watches the live pads meanwhile.
4. A spawn is refused while anything that is not held sits inside the pad's keep-out radius.

Timers and distances (server configuration, shown to players on a pad status board):

| Rule | Proposed value |
|---|---|
| Longest stay on a pad before roll-back | 300 s, shown as a countdown; one 120 s extension while engines are running |
| Grace after a disconnect on the pad | 60 s, then roll-back |
| Pad counts as cleared when the vehicle is | above 1 500 m and more than 1 000 m away, or destroyed |
| Safing after clearance | 20 s; wreckage inside the keep-out radius is removed |
| Keep-out radius | 600 m heavy, 300 m light |

Throughput (computed): a cycle of 90 s gives 40 launches per hour per pad, 150 s gives 24, 240 s gives 15.
Twelve pads over two sites give 180 to 480 launches per hour. A front-page crowd of a few hundred players
launching every 20 to 30 minutes wants several hundred to over a thousand, so the queue will be seen. More
pads are data plus a resolve run; the pad count per site is the capacity dial to load-test.

### 5.4 Contention and clearance

- A vessel on a pad is an ordinary held vessel. It collides with whatever reaches it, and a held vessel wakes
  on contact. Pad structures are not damageable.
- **Range safety.** A vehicle below 5 km altitude whose instantaneous impact point enters the keep-out
  radius of a pad other than its own is destroyed by the range (a server decision, shown as such). Real
  ranges do this. It makes pad-to-pad attacks expensive without faking invulnerability; falling debris is
  still physical.
- Two vehicles lifting off from neighbouring pads at once are separate islands until they come within the
  join distance.

### 5.5 A vessel left on a pad

| Situation | Outcome |
|---|---|
| Never ignited, timer runs out | Rolled back to the hangar: removed without debris; the player is told and keeps the vehicle choice |
| Player disconnects on the pad | Rolled back after the grace period |
| Engines lit but clamps held (thrust check failed) | The existing behaviour shuts the engines down and re-arms the stage; the timer keeps running |
| Destroyed on the pad | Wreckage inside the keep-out radius is removed at safing; the pad frees |
| A capsule or stage comes to rest inside a keep-out radius (pad abort, a landing) | Recovered (removed) after 60 s at rest or when its owner leaves |

Roll-back and recovery are removals with their own reasons, distinct from expiry.

---

## 6. Proximity operations: what the pilot needs

No autopilot is added. SAS still only holds an attitude.

**Target.** `setTarget` takes a body, a vessel or a port. "Control from here" selects the pilot's own
reference part (command part or a docking port); it sets `helm.controlPart`.

**Navball.** A third mode `target` beside `surface` and `orbit`: prograde and retrograde show the velocity
relative to the target. The `target` / `antiTarget` markers already exist in `NavballMarkers`. SAS gains the
hold modes `target`, `antiTarget` and `portAlign` (own port axis anti-parallel to the target port's);
prograde and retrograde follow the navball mode. All are attitude holds.

**Readouts** (new, beside the existing `Readouts`):

```ts
interface TargetReadout {
  targetId: string; kind: 'vessel' | 'port';
  range: number;                             // port to port when both are selected, else centre of mass to centre of mass
  rangeRate: number;                         // negative = closing
  relVelocity: Vec3; relSpeed: number;       // in the pilot's control frame
  closestApproach: { time: number; distance: number } | null;   // straight-line, valid at short range
  lvlh: { radial: number; along: number; cross: number };       // target-centred local vertical / local horizontal
}
interface DockingReadout {
  ownPort: string; targetPort: string; compatible: boolean; targetArmed: boolean;
  axial: number; lateral: [number, number];  // in the target port's frame
  angleDeg: [number, number]; rollDeg: number;
  closing: number; lateralSpeed: number; rateDegPerS: number;
  within: { lateral: boolean; angle: boolean; roll: boolean; closing: boolean; lateralSpeed: boolean; rate: boolean };
  state: 'far' | 'approach' | 'soft' | 'hard';
}
```

**By phase:**

| Phase | Range | Instruments |
|---|---|---|
| Rendezvous | above 5 km | Map: intercept and closest-approach markers, relative inclination, phase angle |
| Approach | 5 km to 100 m | Navball in target mode, range and range rate, relative velocity by axis, straight-line closest approach, the local-vertical plot |
| Final | below 100 m | Docking camera at the active port with a cross-hair on the target port; an alignment display showing lateral offset, angular error, roll, closing-speed tape and one light per envelope limit; RCS propellant and translation authority per axis; CONTACT / CAPTURE / HARD DOCK lights |

**Translation.** `ControlInputs.translate` and fine control exist, and the allocation already mixes
translation with attitude. A docking control mode in the input layer puts translation on the main keys; no
sim change. Thruster plumes exert no force on the other craft.

---

## 7. Hooks for later (seams named, nothing added)

| Later feature | The seam |
|---|---|
| EVA | An astronaut is a vessel of one craft with a suit part (`command` with one seat, an `rcs` module). `command.hatch` is where it appears; `transfer.crew` on ports is the same crew move without going outside. Islands already hold several small vessels. ARCHITECTURE section 16 otherwise stands. |
| Landing on other bodies | Legs, probes and contact are data and work on any body with terrain. An assembly can rest on a surface, since it is a vessel. What is missing is the bodies' terrain and the server having it. |
| Ship builder | `VehicleDef` is the craft file; `uses`, node kinds, `surfaceAttach`, `symmetry` and `validateVehicle` are the builder's rules; colliders give the overlap check; `stagingInfo` already computes delta-v and TWR per stage. Player craft are `VehicleDef` documents stored per account and validated by the server. |
| Science and resources | New `ModuleDef` members and new `ResourceDef` entries. Flow groups, transfer and cross-feed already move any resource. Electric power would be a resource with generator and consumer modules. |
| Surface bases, rovers | A site is data with a `bodyId`; docking on the ground needs wheels, which are a module. |
| More port designs | `gender` and `portType` are data. |
| Multi-crew craft | The helm is a (player, craft) pair; seats are data. |

---

## 8. What this means for the work

In-place edits, by file:

| File | Change |
|---|---|
| `src/core/contracts/defs.ts` | The optional fields and union members of 2.6 and 5.2 |
| `src/core/contracts/sim.ts`, `controls.ts` | `craftId` on parts, `crafts` and `links` on vessels, docking module state, new events, target and docking readouts, navball mode, SAS modes, the commands (target, arm port, undock, control point, helm, transfer, lend policy) |
| `src/core/defs/loader.ts` | Assembly includes, `validateVehicle`, flatten discs from pads |
| `src/sim/vessel/types.ts`, `assemble.ts` | `CraftRuntime`, `DockLink`, `PartRuntime.craft`; dock links from pre-mated ports |
| `src/sim/vessel/split.ts` | Components over links; `mergeVessels` into the docking merge; impulse at a point |
| `src/sim/vessel/structure.ts` | Flow groups keyed by craft; lent actuators only; colliders and their tree |
| `src/sim/vessel/staging.ts` | Stage stack per craft; `undock` action |
| `src/sim/vessel/clearance.ts` | Becomes the collider library (shapes, distance); add GJK and conservative advancement |
| `src/sim/dynamics/` | New island contact pass and capture constraint; `failure.ts` reaches other vessels; optional origin in the integrator |
| `src/sim/world/` | Islands instead of one bubble; screening and encounter events; pads |

Tests worth writing first: the lunar mission's golden hash is unchanged; merge then undock restores every
part pose and conserves linear and angular momentum to 1e-9; two craft closing at 15.6 km/s never pass
through each other at any phase of the step; every stage separation of the existing stack survives with
contact switched on; capture succeeds just inside each envelope limit and fails just outside; a dock at
30 AU from the Sun holds relative speed noise under 1 mm/s.

Open decisions for the lead:

1. Second site: the far-longitude bake, or more pads in the existing region only.
2. Egret cabin sharing the Kestrel interior, or a second interior.
3. Whether propellant transfer ships with docking or after it (the tanker has no purpose without it).
4. The crash-to-hypervelocity boundary (250 m/s proposed) and the envelope values, after play.
5. Whether unattended rails-against-rails collisions are wanted at all. They are what makes "no tunneling"
   true for everything, and they cost only the screening.

---

## External references

- NASA standard breakup model, 40 J/g catastrophic threshold and the non-catastrophic ejecta mass rule, as
  restated in: https://arxiv.org/pdf/2111.12196 and https://arxiv.org/pdf/2407.18197 (the two differ by a
  factor of one half in how the specific energy is written; check the original before fixing constants).
- International Docking System Standard, Interface Definition Document, Revision F:
  https://ntrs.nasa.gov/citations/20220011643 (initial contact conditions are in its section 3; the
  comparison column in 3.2 is from memory and was not confirmed against it).
