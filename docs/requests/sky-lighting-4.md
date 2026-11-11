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

Added 2026-11-11 (same owner, same bake step): the Large Magellanic Cloud is magenta in the cube. Mean of
3 x 3 texels of mip 4 at RA 80.9, Dec -69.75: stored (44.2, 35.1, 49.7), R/G 1.26 and B/G 1.42; the Small
Cloud (18.4, 17.5, 23.4). The galactic centre is (42, 28, 19), the Crux band (57, 47, 40), the poles neutral.
Since the display's toe became hue-preserving (request sky-lighting-3) the screen shows what the data holds:
a purple cloud beside warm-grey star clouds (`out/screens/sky/pbr-spheres-leo-night.png`, upper left of the
frame centre). The LMC's integrated colour is that of its stars (B-V about 0.5: a slightly warm white); green
below both red and blue is not a colour starlight has. Please check whether the SVS Milky Way layer carries an
H-alpha tint there and, if so, bring the two Clouds to R >= G >= B x 0.9 or the catalogue colour.

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

Added 2026-11-11, round 2 (same owner, same bake step): the faint stars that live in the cube look smeared at the
1440p target towards the corners of a 90 deg frame and in the 24 deg Orion view (artifact critic of round 1:
radial / tangential lag-1 autocorrelation 0.68 / 0.47 in the top-left corner of
`out/screens/sky/perf-1440p-leo-horizon-night.png`). A rectilinear frame magnifies the sky radially towards its
corners (a 1440p pixel there is 0.022 deg radially against the 0.044 deg texel of the baked 2048 level), so a
star that is one texel of the cube becomes a radially stretched blob whatever reconstruction filter the sky
uses; only point sources stay round. If the bake can, carry the catalogue (`stars.f32`) to about V 9 (Tycho-2:
some 230,000 more stars, 9 MB at 40 B per star) and take those stars out of the cube as it already does for the
catalogue to V 6.5; the sky draws them as point images with the photometric PSF and needs no code change (the
star count comes from the manifest; the whole background pass, 8,920 stars and the Milky Way, is 0.014 ms p99 at
1440p today, so the star budget has room; the count would be measured when the data lands).
