Status: resolved (commits d9f9413, 2bd0a88)
From: app-integration-v1
Owner path: src/ui/hud/hud.ts (flight-ui)
Blocking: no

## Problem
With the real simulation the HUD shows the ENTRY panel (heat flux, heat shield, skin temperature) during the
ascent and removes the ORBIT panel (apoapsis / periapsis) for it, from about Mach 0.5 onward: the real sim reports
the stagnation heat flux of an ascending vehicle (2 kW/m^2 at 4 km and Mach 0.6, rising with speed), and
`HEATING_FLUX` (hud.ts line 144) is 1 kW/m^2, so `heating` is true and `showOrbit` false for most of the climb.
During an ascent the apoapsis is the number the player flies by; the FakeSim's ascent scene has no heat flux, so
the labs never showed it.

## Evidence
`out/screens/app/climb-chase-4km.png` (`tests/browser/app/app.spec.ts` "a short real flight", the app at
`/?capture=0`: Z, T, Space, chase view at 4.1 km, MET 45 s, 202 m/s up, Mach 0.62): panel "ENTRY" with HEAT FLUX
2 kW/m^2, HEAT SHIELD 100 %, SKIN TEMP. 41 %; no ORBIT panel. At 2 km (`climb-chase-2km.png`, 2.07 km, Mach 0.40)
the ORBIT panel with the atmosphere strip is still shown.

## Requested change
Show the entry panel for an ENTRY, not for an ascent: e.g. heating counts only while the vessel is descending or
on a path whose periapsis is inside the atmosphere after apoapsis (`isDescending`, `orbitPhase`), or with a heat
flux threshold that the ascent does not reach (measure the mission vehicle's ascent peak with the real sim; an
entry from the Moon is orders of magnitude above it). Keep a skin-temperature or ablator
warning visible whenever a limit is approached, whatever the phase. Must not change: the entry panel during an
entry, the orbit panel's phase rules otherwise.

## Resolution
`src/ui/model.ts` `isEntering(s, defs)` decides the ENTRY panel instead of the bare heat flux: heating (above
`ENTRY_HEAT_FLUX`, 1 kW/m^2) counts as an entry only while coming down (vertical speed below 0), or while rising
UNPOWERED (no thrust, throttle 0) on a path whose apoapsis stays inside the atmosphere (a skip). A powered ascent
keeps its ORBIT panel (with the air-data strip) however hot it runs. Kept whatever the phase: the heat-shield and
skin-temperature rows appear (the entry panel opens) once the skin passes 70 % of its limit or the ablator its
redline (`thermalWarn` in `src/ui/hud/hud.ts`). Unchanged: the entry panel during an entry, the orbit panel's phase
rules. Test: `tests/unit/flight-ui/displays.test.ts` "opens the entry panel for an entry, not for the heating of an
ascent" (2 kW/m^2 at +202 m/s under thrust: no entry; the same falling: entry; unpowered with Ap 90 km: entry).
Seen in the real app: the browser mission's pictures `out/screens/mission/03-stage-sep-1-chase.png` (76.9 km) and
`04-fairing-jettison-chase.png` (96.8 km) show the ORBIT panel with Ap/Pe and the air strip during the climb;
`14-entry-interface-chase.png` shows ENTRY. Nothing to re-run in src/app.
