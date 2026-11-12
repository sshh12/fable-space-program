Status: open
From: lead (user report, 2026-11-11, from playing the integrated build)
Owner path: src/render/cockpit/** (cabin geometry: console, couches, fixtures, apertures) and data/defs/visuals/cockpits/**
Blocking: no

## Problem
The cockpit's polygons overlap in visible, odd ways: the instrument console (the dash) runs into the side of the
craft - it penetrates the cabin's inner hull wall instead of ending against it. The visual critiques had already found
related interpenetration (seat parts poking through or past one another, harness straps cutting through the cushions:
docs/qa/wave2/cockpit*.json), but not the console against the hull, which the user saw first.

## Evidence
User report while playing the app (`npm run dev`, then C for the cockpit view, looking left and right along the
console). Pictures to compare: out/screens/cockpit/ and out/screens/mission/*-cockpit.png.

## Requested change
Make the cabin geometrically consistent: no part of the console, couches, panels, lockers, harnesses or fixtures
crosses the inner pressure-hull surface or another part. Fit the console's ends to the hull's curvature (a closure
panel or a fillet against the wall, as real capsules do), and add an automated check: sample every interior part's
triangles against the hull's inner surface (signed distance from the conical / cylindrical frustum the cabin is
built from) and against each other, and fail on any penetration deeper than a few millimetres. Re-shoot the cockpit
views looking along the console to both sides and LOOK at them.
