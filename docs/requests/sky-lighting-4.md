Status: open
From: sky-lighting
Owner path: tools/bake/sky (the Milky Way cube `data/sky/milkyway-*.rgb9e5`)
Blocking: no

## Problem
The sky cube carries starlight and dust but no emission nebulae and no galaxies beyond the Magellanic
Clouds: SVS Deep Star Maps 2020 is built from star catalogues (Hipparcos-2, Tycho-2, Gaia DR2). In the 24 deg
Orion view the sword is a handful of blue-white dots with no glow, and there is nothing at Carina. In a real
long exposure of these fields the Orion Nebula is the most conspicuous object after the bright stars (a
pink-white glow about a degree across, visible to the naked eye), and Carina likewise in the southern Milky
Way (item 12 of `out/qa/wave2/sky-lighting.md`).

## Evidence
- `out/screens/sky/orion-closeup-ev-5.png` around pixel (635, 500): the sword, no nebula.
- `out/screens/sky/crux-centaurus-ev-5.png`: no glow anywhere along the band towards Carina.
- `docs/handoff/bake-moon-sky.md` section 4.3: the cube is `milkyway_2020` x 0.5 + `hiptyc_2020` minus the
  catalogue stars.

## Requested change
Composite the handful of extended objects that the eye or a short exposure shows into the cube before the mip
chain is built, from a freely licensed photographic source (public domain or CC BY / CC BY-SA with the
attribution added to `manifest.attribution`), each scaled to its literature surface brightness and placed by
its J2000 coordinates: M42/M43 (Orion Nebula; integrated V about 4.0 over roughly 1 deg), the Carina Nebula
(NGC 3372; V about 1 over 2 deg), the Lagoon (M8; V about 6 over 1.5 x 0.7 deg), M31 (V 3.4 over 3 x 1 deg),
and if cheap M33, the Pleiades reflection glow and omega Centauri's halo. Hues: H-alpha regions pink-white
(not saturated red: the eye and a daylight-balanced sensor see a pale rose), M31 neutral warm.
Must not change: the cube's format, orientation, `luminanceScale` and the removal of the catalogue stars (the
sky package reads the files exactly as the manifest describes them and its specs measure the band's
luminance at Sagittarius, Carina, Crux, Cygnus and Cassiopeia: the windows are 60 px at a 60 deg field, so
an added nebula changes them by well under their tolerance).
The sky package needs no code change: it re-shoots `orion-closeup` and `crux-centaurus` when the data lands.
