Status: open
From: cockpit
Owner path: src/render/vehicle/parts/payload.ts (`les.tower`: the boost protective cover) and data/defs/visuals/parts/kestrel-les.json
Blocking: yes (the brief's first acceptance view, "on the pad at noon looking up through the forward window", cannot show the world while the cover has no port there; visual QA round 1, cockpit, blocker / major in both lists)

## Problem
On the pad the launch-escape boost cover lies over all four cabin windows; it has one glazed port, over the
hatch window. From the commander's seat both forward windows therefore show the INSIDE of the cover a hand's
width (10.5 cm clearance) outside the glass, and that inside is drawn as a near-white quilted sheet
(material `blanket`, 233-250 / 255, with a dot moire) as bright as open sky although it sits in an enclosed
gap: "the windows read as stuffed with white padding". No sky, cloud or tower is visible in the view the
brief names first. The Apollo boost protective cover had two ports: over the hatch window and over the
commander's forward (rendezvous) window.

## Evidence
`out/screens/cockpit/world-pad-noon-forward-window.png` (integration lab, `scene=pad`, seat view yaw 18 pitch 46):
panes x 870-1000, y 285-670 and x 1185-1390, y 395-690. Critics' lists `out/qa/wave2/cockpit.r1.photo.json`
(third blocker) and `out/qa/wave2/cockpit.r1.artifact.json` ("On the pad both forward windows are filled by a
near-white quilted sheet"). `out/screens/vehicle/les-boost-cover-hatch.png` shows the one existing port.
Re-shoot with `node tools/dev/heavy.mjs --class=gpu -- npx playwright test tests/browser/cockpit/world.spec.ts --project=functional -g pad-noon`.

## Requested change
1. A second glazed port in the boost cover, over the commander's forward window (`fwd-left` of
   `visuals/shared/kestrel-mouldline`), built like the hatch-window port (opening a little larger than the
   window's rounded rectangle, pane, bezel), and the cover's ports DECLARED in data so that the cockpit can
   read which windows see out: `"windowPorts": ["hatch-window", "fwd-left"]` in the `params` of
   `data/defs/visuals/parts/kestrel-les.json` (ids of the shared mould line's windows; `hatch-window` for the
   hatch's round window). The cockpit reads exactly that key (see below) and treats a missing key as the
   present state of the generator: one port, over the hatch window.
2. The inside of the cover must not be lit like an outside surface: it is in the cover's own shadow and sees
   no sky. Today the lining takes the sun through the cloth shading (no self-shadow at 10 cm) and the full
   sky ambient; it should be near black (a non-cloth or zero-translucency dark lining with `ao` near 0, or
   the cover as a two-sided caster in the vessel cascade).

What the cockpit does on its side (in this round, no change needed from you for it): a cabin window whose
outer opening lies inside the bounds of another part of the same vessel is treated as COVERED unless that
part's visuals section lists the window under `params.windowPorts`: a covered window sends no sky light and
no sun into the cabin (cabin light, sun apertures, cabin probe), so on the pad the cabin is lit by its
floods and by the ported windows only. Must not change: the mould line, the cover's outer shape, the hatch port.
