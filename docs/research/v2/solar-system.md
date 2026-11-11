# Research v2: the whole solar system at true scale

Scope: data, visuals, flight-planning numbers and sim-code needs for the Sun, eight planets and the major moons.
Design-only. Every number below was either fetched from the cited source on 2026-11-10/11 or computed by a
throw-away script from fetched inputs; items marked **[unverified]** come from memory and must be checked before
they go into data files. Nothing here edits source; the build packages that follow own the code.

## 0. Decisions this supports

1. **Re-root the body system at the Sun.** Today Earth is the root, the Sun is a `lightOnly` child driven by the
   Astronomical Almanac low-precision formula (`data/defs/bodies/sun.json`, `src/sim/bodies/ephemeris.ts`). The
   solar system needs the Sun as an attractor and root, planets as its children, moons as grandchildren. Three
   levels, no moon-of-moon. `BodySystem` is already generic (one root, one body with `emission`); the root may be the
   star. ROOT axes stay J2000 equatorial; only the origin moves (section 7.1).
2. **Every body enters the existing tile pipeline** (`TileManifest`, gnomonic cube, `frt1-height` + 256 px WebP
   albedo) as a small pyramid, baked by one config-driven tool. No second terrain code path (section 5). Gas and ice
   giants are the exception by nature: no solid surface, so a cloud-top texture plus an atmosphere parameter set.
3. **The data model needs five additive fields**, all defaulting to today's behaviour so Earth and Moon do not
   change: secular rates and a mean-motion override on `KeplerOrbitDef`; a `pole` plane frame (Laplace planes); a
   `flattening` (oblate spheroid) for altitude; planet-specific render atmosphere schemas; ring definitions
   (section 7.3).
4. **Warp:** the present ceiling (100,000x) makes Uranus and Neptune hours of wall time. Add 1e6 and 1e7 rails levels
   (data-level change, `RAILS_WARP_LEVEL_COUNT` 7 -> 9) (section 6.4).
5. **"Reach and orbit" is cheaper than it sounds if "orbit" means a bound capture ellipse.** From LEO: Jupiter 7.0,
   Saturn 8.0, Uranus 9.0, Neptune 9.4 km/s for a 20-30 day capture ellipse, against 15-24 km/s for a low circular
   orbit. Fleet design should key on ellipse capture plus aerobraking where it exists (section 6).
6. **Continuous-thrust vehicles need thrust on rails.** If the fleet includes ion/electric craft, the present rails
   model (coasting only, physics warp <= 5x) cannot fly them across planets (section 6.6).
7. **Do not hand-transcribe JPL satellite elements.** I reproduced the Jovian, Martian and Uranian rows against
   JPL Horizons but could not reproduce the Saturnian rows (section 2.3). Generate body defs by a tool that checks
   itself against Horizons.

## 1. Sources and verification log

| What | URL (fetched, HTTP 200) | Used for |
|---|---|---|
| JPL planet mean elements ("approximate positions"), Table 1 (1800-2050) and 2a/2b (3000 BC-3000 AD), with accuracy table | https://ssd.jpl.nasa.gov/planets/approx_pos.html | planet elements and rates |
| JPL satellite mean elements, with the frame definitions | https://ssd.jpl.nasa.gov/sats/elem/ | moon elements |
| JPL satellite physical parameters (GM, mean radius, density) | https://ssd.jpl.nasa.gov/sats/phys_par/ | moon GM and radius |
| JPL planet physical parameters | https://ssd.jpl.nasa.gov/planets/phys_par.html | planet radii, rotation |
| JPL astrodynamic parameters (DE440 system GMs, GM sun, obliquity) | https://ssd.jpl.nasa.gov/astro_par.html | GM, obliquity 84381.448 arcsec = 23.4392911 deg (matches `OBLIQUITY_J2000` in the repo) |
| NAIF `pck00011.tpc` (IAU WGCCRE 2009/2015 pole and prime-meridian constants, radii) | https://naif.jpl.nasa.gov/pub/naif/generic_kernels/pck/pck00011.tpc | pole RA/Dec and rates, W0 and rates, triaxial radii |
| IAU WGCCRE report (the primary reference of pck00011; direct PDF link at iau.org redirects/404s from here, so I did not read the PDF) | https://astropedia.lpl.usgs.gov/download/Docs/WGCCRE/WGCCRE2015reprint.pdf **[unverified]** | cross-check only |
| NASA NSSDC planetary fact sheets (atmosphere, albedo, scale heights, Saturn rings) | https://nssdc.gsfc.nasa.gov/planetary/factsheet/ (`venusfact.html`, `marsfact.html`, `jupiterfact.html`, ... `satringfact.html`, `joviansatfact.html`, `saturniansatfact.html`, `uraniansatfact.html`, `neptuniansatfact.html`) | albedo, atmosphere, rings |
| JPL Small-Body Database API (Pluto, Ceres osculating elements) | https://ssd-api.jpl.nasa.gov/sbdb.api?sstr=134340&full-prec=true (and `sstr=1`) | dwarf planets |
| JPL Horizons API (used to test element conventions) | https://ssd.jpl.nasa.gov/api/horizons.api (`VECTORS`, `REF_SYSTEM=ICRF`) | validation |
| USGS Astrogeology global mosaics (public S3 bucket behind `planetarymaps.usgs.gov`) | https://planetarymaps.usgs.gov/mosaic/<file> (302 to `asc-pds-services.s3.us-west-2.amazonaws.com/mosaic/<file>`) | colour maps, DEMs |
| Solar System Scope textures, CC BY 4.0 | https://www.solarsystemscope.com/textures/download/<file> (returns the image to a GET with a browser User-Agent; HEAD returns an HTML page) | giants, rings, Venus clouds |
| Bjorn Jonsson's planetary maps (free with credit, see licence note) | https://bjj.mmedia.is/data/planetary_maps.html | upgrade path |

Verified against the sources above: the Earth GM, Moon GM, obliquity, planet elements, satellite elements, pole and
rotation constants, Saturn ring radii, albedos, scale heights. Cross-check inside the repo: my TLI + LOI estimate
(3.14 + 0.82 = 3.96 km/s) matches the sim-orbits hand-off (3,150 m/s TLI, 782 m/s capture).

## 2. Body data

All elements below are in the JPL convention (mean ecliptic and equinox of J2000 for planets). `ut` = seconds since
J2000 = JD 2451545.0 TDB. The sim's `ecliptic` frame already rotates by the same obliquity.

### 2.1 Sun and planets

Planet orbit (JPL Table 1, valid 1800-2050; element, then rate per Julian century). L = mean longitude, w_bar =
longitude of perihelion, Node = longitude of ascending node, all degrees. M = L - w_bar, argument of perihelion =
w_bar - Node.

| | a (AU) | e | I | L | w_bar | Node |
|---|---|---|---|---|---|---|
| Mercury | 0.38709927 (+0.00000037) | 0.20563593 (+0.00001906) | 7.00497902 (-0.00594749) | 252.25032350 (+149472.67411175) | 77.45779628 (+0.16047689) | 48.33076593 (-0.12534081) |
| Venus | 0.72333566 (+0.00000390) | 0.00677672 (-0.00004107) | 3.39467605 (-0.00078890) | 181.97909950 (+58517.81538729) | 131.60246718 (+0.00268329) | 76.67984255 (-0.27769418) |
| EM barycentre | 1.00000261 (+0.00000562) | 0.01671123 (-0.00004392) | -0.00001531 (-0.01294668) | 100.46457166 (+35999.37244981) | 102.93768193 (+0.32327364) | 0 |
| Mars | 1.52371034 (+0.00001847) | 0.09339410 (+0.00007882) | 1.84969142 (-0.00813131) | -4.55343205 (+19140.30268499) | -23.94362959 (+0.44441088) | 49.55953891 (-0.29257343) |
| Jupiter | 5.20288700 (-0.00011607) | 0.04838624 (-0.00013253) | 1.30439695 (-0.00183714) | 34.39644051 (+3034.74612775) | 14.72847983 (+0.21252668) | 100.47390909 (+0.20469106) |
| Saturn | 9.53667594 (-0.00125060) | 0.05386179 (-0.00050991) | 2.48599187 (+0.00193609) | 49.95424423 (+1222.49362201) | 92.59887831 (-0.41897216) | 113.66242448 (-0.28867794) |
| Uranus | 19.18916464 (-0.00196176) | 0.04725744 (-0.00004397) | 0.77263783 (-0.00242939) | 313.23810451 (+428.48202785) | 170.95427630 (+0.40805281) | 74.01692503 (+0.04240589) |
| Neptune | 30.06992276 (+0.00026291) | 0.00859048 (+0.00005105) | 1.77004347 (+0.00035372) | -55.12002969 (+218.45945325) | 44.96476227 (-0.32241464) | 131.78422574 (-0.00508664) |

Nominal errors of this table (JPL, 1800-2050, heliocentric longitude / distance): Mercury 15" / 1,000 km, Venus 20" /
4,000 km, EM barycentre 20" / 6,000 km, Mars 40" / 25,000 km, Jupiter 400" / 600,000 km, Saturn 600" / 1,500,000 km,
Uranus 50" / 1,000,000 km, Neptune 10" / 200,000 km. Table 2a/2b (3000 BC-3000 AD) is 2-10x worse near today but does
not degrade in a century; its outer-planet mean anomaly needs the extra terms `b T^2 + c cos(f T) + s sin(f T)`
(Jupiter b=-0.00012452 c=0.06064060 s=-0.35635438 f=38.35125; Saturn 0.00025899 -0.13434469 0.87320147 38.35125; Uranus
0.00058331 -0.97731848 0.17689245 7.67025; Neptune -0.00041348 0.68346318 -0.10162547 7.67025).
**Recommendation:** Table 1, because the scenario start is 2037 and Table 1 is the better fit there. Document that
beyond 2050 the universe is an internally perfect clock, not a faithful copy of reality.
**Earth:** use the existing `sunLowPrecision` formula negated (Earth about the Sun) so that `tools/sim/start-time.json`,
the launch windows and the solstice tests reproduce to rounding. The EM-barycentre vs Earth-centre offset (4,671 km)
is invisible at 1 AU (6 arcsec).

Physical constants. GM from DE440 (JPL astro_par) is for the **planetary system**; the body-only value, which the
sim's `mu` must be, is the system value minus the moons I list from the JPL satellite table. Mean radius is the sim's
datum sphere (Earth uses 6,371 km); equatorial/polar radii and poles from `pck00011.tpc`.

| | GM body (km3/s2) | mean R (km) | R eq / polar (km) | flattening | g (m/s2, GM/R2) | v_esc (km/s) | pole RA / Dec (deg) at J2000 | pole rate RA / Dec (deg/cy) | W0 (deg) | W rate (deg/day) | sidereal rotation | obliquity (deg) |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Sun | 132,712,440,041 | 695,700 | 695,700 | 0 | 274 | 617.7 | 286.13 / 63.87 | 0 / 0 | 84.176 | 14.1844 | 25.38 d | 7.25 |
| Mercury | 22,031.87 | 2439.4 | 2440.53 / 2438.26 | 0.0009 | 3.70 | 4.25 | 281.0103 / 61.4155 | -0.0328 / -0.0049 | 329.5988 | 6.1385108 | 58.646 d | 0.034 |
| Venus | 324,858.59 | 6051.8 | 6051.8 | 0 | 8.87 | 10.36 | 272.76 / 67.16 | 0 / 0 | 160.20 | -1.4813688 | 243.02 d retrograde | 177.36 |
| Earth | 398,600.44 | 6371.0 (sim) | 6378.14 / 6356.75 | 0.0034 (sim: 0) | 9.82 | 11.19 | 0 / 90 | -0.641 / -0.557 | 190.147 | 360.9856235 | 23.934 h | 23.44 |
| Mars | 42,828.38 | 3389.5 | 3396.19 / 3376.20 | 0.0059 | 3.73 | 5.03 | 317.269202 / 54.432516 | -0.10927547 / -0.05827105 | 176.049863 | 350.891982443 | 24.623 h | 25.19 |
| Jupiter | 126,686,534 | 69,911 | 71,492 / 66,854 | 0.0649 | 25.92 | 60.2 | 268.056595 / 64.495303 | -0.006499 / 0.002413 | 284.95 | 870.5360 (System III) | 9.925 h | 3.13 |
| Saturn | 37,931,207 | 58,232 | 60,268 / 54,364 | 0.0980 | 11.19 | 36.1 | 40.589 / 83.537 | -0.036 / -0.004 | 38.90 | 810.7939024 | 10.656 h | 26.73 |
| Uranus | 5,793,951.3 | 25,362 | 25,559 / 24,973 | 0.0229 | 9.01 | 21.4 | 257.311 / -15.175 | 0 / 0 | 203.81 | -501.1600928 | 17.24 h retrograde | 97.77 |
| Neptune | 6,835,099 | 24,622 | 24,764 / 24,341 | 0.0171 | 11.27 | 23.6 | 299.36 / 43.46 | 0 / 0 | 249.978 | 541.1397757 | 15.97 h | 28.32 |

The g and v_esc are at the mean radius; for the giants the reference is the 1-bar level (use the equatorial radius for
altitude, see 7.3). Notes: Mars GM = system 42,828.375816 minus Phobos and Deimos. Jupiter, Saturn, Uranus and Neptune
body GMs are the DE440 system GMs minus the sum of their listed moons (126,712,764.1 - 26,229.9; 37,940,584.8 -
9,377.6; 5,794,556.4 - 605.1; 6,836,527.1 - ~1,428.5-1,430); each is within 1e-6 of the JPL planet-only values from
memory **[unverified at 1e-7]**; get them from `jup365`/`sat441`/`ura182`/`nep097` headers when the data tool is
written. Sun's `mu` in the repo (1.32712440018e20) differs from DE440 (1.32712440041e20) by 1.7e-10: leave it.

**Mean motion warning.** The Table 1 mean-longitude rates are the fitted mean motions; sqrt(mu/a^3) differs from them
by up to 5e-5 relative (Jupiter, a = 5.202887 AU gives 3034.9 deg/cy against 3034.746). Over the 100 years a session
can warp, that is 0.1 deg of Jupiter's longitude. The current `KeplerEphemeris` takes n from `mu_parent + mu_body`;
add a `meanMotionDegPerDay` override and use the table's L rate. Rotation: use `fixedRate` from `pck00011` for every
body, not `tidalLock`, so the prime meridian matches the baked maps.

### 2.2 Dwarf planets: recommendation

Include **Ceres** and **Pluto + Charon** as tier-2 bodies (data and sources are free, no extra code once the generic
bake exists); skip Vesta, Eris and the rest. Do not add small-body machinery. Both are osculating elements (JPL SBDB,
ecliptic J2000, heliocentric):

| | epoch (JD TDB) | a (AU) | e | i | node | arg. peri | M at epoch |
|---|---|---|---|---|---|---|---|
| Ceres | 2461200.5 | 2.765552595034094 | 0.07969229514816586 | 10.58802780183462 | 80.24862682043221 | 73.29421453021587 | 274.4193463761342 |
| Pluto | 2457588.5 | 39.58862938517124 | 0.2518378778576892 | 17.14771140999114 | 110.2923840543057 | 113.7090015158565 | 38.68366347318184 |

Ceres: GM 62.6284 km3/s2 (SBDB), radii 487.3/487.3/446 (pck00011), rotation 9.074 h; maps from Dawn (section 5).
Pluto: pole 132.993/-6.163, W0 302.695, rate 56.3625225 deg/day, radius 1188.3 km (pck00011). Charon: GM 106.1 (JPL),
R 606 km, a 19,600 km, period 6.387222 d, tidally locked; pole equal to Pluto's. The Pluto-Charon barycentre lies
~2,030 km from Pluto's centre (outside Pluto); the patched-conic model puts Charon on a relative orbit about Pluto
and loses Pluto's own ~2,000 km wobble. Acceptable for a placeholder. Osculating elements drift from reality in
decades (Pluto's resonance); state that the dwarf planets are "plausible", not exact.

### 2.3 Moons

Sources: JPL satellite mean-elements table (epoch 2000-01-01.5 TDB), JPL satellite physical parameters, `pck00011`.
Columns: a (km), e, w (arg. of periapsis), M, i, Node (all deg), P (sidereal period, days), P_apsis, P_node (years;
precession periods), frame, and the Laplace-plane pole (RA, Dec) when the frame is "Laplace".

| Moon (parent) | GM (km3/s2) | mean R (km) / triaxial radii (pck00011) | a | e | w | M | i | Node | P (d) | P_apsis / P_node (yr) | frame (pole RA, Dec) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| Moon (Earth) | 4902.800 | 1737.4 | 384,400 | 0.0554 | 318.15 | 135.27 | 5.16 | 125.08 | 27.322 | 5.997 / 18.600 | ecliptic |
| Phobos (Mars) | 0.0007087 | 11.08 / 13.0 x 11.4 x 9.1 | 9,375 | 0.015 | 216.3 | 189.7 | 1.1 | 169.2 | 0.3187 | 1.1 / 2.3 | Laplace (317.7, 52.9) |
| Deimos (Mars) | 0.0000962 | 6.2 / 7.8 x 6.0 x 5.1 | 23,457 | 0.000 | 0.0 | 205.0 | 1.8 | 54.3 | 1.2625 | 0.0 / 56.2 | Laplace (316.6, 53.5) |
| Io (Jupiter) | 5959.915 | 1821.49 / 1829.4 x 1819.4 x 1815.7 | 421,800 | 0.004 | 49.1 | 330.9 | 0.0 | 0.0 | 1.762732 | 1.333 / 0 | Laplace (268.1, 64.5) |
| Europa | 3202.712 | 1560.8 / 1562.6 x 1560.3 x 1559.5 | 671,100 | 0.009 | 45.0 | 345.4 | 0.5 | 184.0 | 3.525463 | 1.394 / 30.202 | Laplace (268.1, 64.5) |
| Ganymede | 9887.833 | 2631.2 | 1,070,400 | 0.001 | 198.3 | 324.8 | 0.2 | 58.5 | 7.155588 | 68.301 / 137.812 | Laplace (268.2, 64.6) |
| Callisto | 7179.283 | 2410.3 | 1,882,700 | 0.007 | 43.8 | 87.4 | 0.3 | 309.1 | 16.690440 | 277.921 / 577.264 | Laplace (268.7, 64.8) |
| Mimas (Saturn) | 2.5035 | 198.2 / 207.8 x 196.7 x 190.6 | 186,000 | 0.020 | 160.4 | 275.3 | 1.6 | 66.2 | 0.942422 | 0.493 / 0.986 | Laplace (40.6, 83.5) |
| Enceladus | 7.2104 | 252.1 / 256.6 x 251.4 x 248.3 | 238,400 | 0.005 | 119.5 | 57.0 | 0.0 | 0.0 | 1.370218 | 2.916 / 0 | Laplace (40.6, 83.5) |
| Tethys | 41.2135 | 531.1 / 538.4 x 528.3 x 526.3 | 295,000 | 0.001 | 335.3 | 0.0 | 1.1 | 273.0 | 1.887802 | 0.005 / 4.982 | Laplace (40.6, 83.5) |
| Dione | 73.1161 | 561.4 / 563.4 x 561.3 x 559.6 | 377,700 | 0.002 | 116.0 | 212.0 | 0.0 | 0.0 | 2.736916 | 11.698 / 0 | Laplace (40.6, 83.5) |
| Rhea | 153.9418 | 763.5 / 765.0 x 763.1 x 762.4 | 527,200 | 0.001 | 44.3 | 31.5 | 0.3 | 133.7 | 4.517503 | 33.939 / 35.775 | Laplace (40.6, 83.5) |
| Titan | 8978.137 | 2574.76 / 2575.15 x 2574.78 x 2574.47 | 1,221,900 | 0.029 | 78.3 | 11.7 | 0.3 | 78.6 | 15.945448 | 346.680 / 687.370 | Laplace (36.4, 84.0) |
| Iapetus | 120.5151 | 734.3 / 745.7 x 745.7 x 712.1 | 3,561,700 | 0.028 | 254.5 | 74.8 | 7.6 | 86.5 | 79.331002 | 1662.900 / 3130.302 | Laplace (288.7, 78.9), tilt 14.8 |
| Miranda (Uranus) | 4.3 | 235.8 / 240.4 x 234.2 x 232.9 | 129,846 | 0.001 | 154.8 | 73.0 | 4.4 | 100.9 | 1.413479 | 8.939 / 17.787 | equatorial |
| Ariel | 83.5 | 578.9 / 581.1 x 577.9 x 577.7 | 190,929 | 0.001 | 9.6 | 193.5 | 0.0 | 0.0 | 2.520379 | 28.901 / 0 | equatorial |
| Umbriel | 85.1 | 584.7 | 265,986 | 0.004 | 183.4 | 253.0 | 0.1 | 174.8 | 4.144177 | 64.126 / 129.945 | equatorial |
| Titania | 226.9 | 788.9 | 436,298 | 0.002 | 184.0 | 68.1 | 0.1 | 29.5 | 8.705869 | 579.928 / 1644.649 | equatorial |
| Oberon | 205.3 | 761.4 | 583,511 | 0.002 | 132.2 | 143.6 | 0.1 | 76.8 | 13.463237 | 158.604 / 192.798 | equatorial |
| Triton (Neptune) | 1428.495 | 1352.6 | 354,800 | 0.000 | 0.0 | 63.0 | 157.3 | 177.7 | 5.8792 | 675.2 / 299.4 | equatorial (retrograde, i > 90) |
| Charon (Pluto) | 106.1 | 606 | 19,600 | 0.000 | 0 | 304.1 | 0.0 | 0.0 | 6.387222 | - | equatorial |

Moon rotation (pck00011): pole = the parent's pole (Jovian, Saturnian, Uranian moons; Phobos 317.67071657 /
52.88627266, Deimos 316.65705808 / 53.50992033, Titan 39.4827 / 83.4279, Iapetus 318.16 / 75.03 with rates -3.949 and
-1.143 deg/cy, Triton 299.36 / 41.17). W rates equal the orbital mean motion for the synchronous moons (Io 203.4889538
deg/d, Europa 101.3747235, Ganymede 50.3176081, Callisto 21.5710715, Titan 22.5769768, Phobos 1128.84475928,
Deimos 285.16188899, Triton -61.2572637 retrograde).

**Convention test against Horizons (I ran it).** Position of each moon at J2000 from the elements, versus Horizons
(`ICRF`, parent-centred): with the frame "X = ascending node of the plane on the ICRF equator, Z = the listed pole",
Io 0.11 deg, Europa 0.01 deg, Ganymede 0.08 deg, Phobos 0.06 deg (all fine). Uranian moons agree (0.0-0.3 deg) only
when the equatorial frame uses the **positive pole (77.311, +15.175)**, not the IAU north pole (257.311, -15.175);
with the IAU pole they are 130-240 deg off. The **Saturnian rows did not reproduce** with either the equatorial or
the ecliptic node origin (offsets 6 to 300 deg, not a constant), and Triton with Neptune's IAU pole is off by 4.6 deg
(probably the NEP098 pole differs slightly). I did not resolve the Saturn convention. Consequence: the body-data tool
must fit/check against Horizons for every moon and fail a test if any moon deviates by more than ~1 deg over 2030-2060.
For Saturn the pragmatic fallback is to derive plane, node and phase from a Horizons state at the sim epoch and keep
only the JPL a, e, i, P and precession periods.

Also read the JPL warning on the page: "mean orbital parameters are not intended for ephemeris computation". They
describe a precessing ellipse. For a game they are right; for the Moon they differ from the repo's frozen ellipse
(which is deliberately kept: sim-orbits acceptance tests pin its libration and inclination).

### 2.4 Sphere of influence, Hill sphere, surface gravity (computed)

SOI = a (m_body/M_parent)^0.4 (the sim's `"auto"`); Hill = a (m/3M)^(1/3). Planets use the Sun's GM.

| Planet | SOI (km) | SOI / R | Hill (km) |
|---|---|---|---|
| Mercury | 112,400 | 46 | 220,700 |
| Venus | 616,300 | 102 | 1,011,000 |
| Earth | 924,600 | 145 | 1,497,000 |
| Mars | 577,200 | 170 | 1,084,000 |
| Jupiter | 48,210,000 | 690 | 53,140,000 |
| Saturn | 54,550,000 | 937 | 65,160,000 |
| Uranus | 51,760,000 | 2041 | 70,090,000 |
| Neptune | 86,650,000 | 3519 | 116,000,000 |

| Moon | g (m/s2) | v_esc (km/s) | SOI (km) | SOI / R | Hill (km) | circular speed 100 / 50 / 10 km alt (m/s) |
|---|---|---|---|---|---|---|
| Moon | 1.624 | 2.376 | 66,183 | 38 | 61,524 | 1634 |
| Phobos | 0.006 | 0.011 | **7.2 (inside the body)** | 0.65 | 16.6 | 6 |
| Deimos | 0.003 | 0.006 | 8.1 | 1.3 | 21.3 | 2 |
| Io | 1.796 | 2.558 | 7,836 | 4.3 | 10,558 | 1761 |
| Europa | 1.315 | 2.026 | 9,725 | 6.2 | 13,657 | 1389 |
| Ganymede | 1.428 | 2.742 | 24,350 | 9.3 | 31,717 | 1903 |
| Callisto | 1.236 | 2.441 | 37,681 | 15.6 | 50,141 | 1691 |
| Mimas | 0.064 | 0.159 | 250 | 1.26 | 521 | 110 |
| Enceladus | 0.113 | 0.239 | 489 | 1.9 | 950 | 154 |
| Tethys | 0.146 | 0.394 | 1,214 | 2.3 | 2,103 | 266 |
| Dione | 0.232 | 0.510 | 1,955 | 3.5 | 3,259 | 346 |
| Rhea | 0.264 | 0.635 | 3,676 | 4.8 | 5,831 | 435 |
| Titan | 1.354 | 2.641 | 43,322 | 16.8 | 52,407 | 1832 |
| Iapetus | 0.224 | 0.573 | 22,515 | 30.7 | 36,305 | 392 |
| Miranda | 0.077 | 0.191 | 459 | 1.95 | 815 | 123 |
| Ariel | 0.249 | 0.537 | 2,210 | 3.8 | 3,222 | 364 |
| Umbriel | 0.249 | 0.540 | 3,102 | 5.3 | 4,517 | 366 |
| Titania | 0.365 | 0.758 | 7,532 | 9.5 | 10,273 | 520 |
| Oberon | 0.354 | 0.734 | 9,679 | 12.7 | 13,289 | 503 |
| Triton | 0.781 | 1.453 | 11,968 | 8.9 | 14,599 | 992 |

**Do not miss:** the `"auto"` SOI rule gives **SOI < R for Phobos** and a 50 km gap above the surface for Mimas, and
`BodySystem` throws "soiRadius must exceed the radius". Recommendation: `soiRadius = min(Hill, max(auto, 2.5 R))`:
Phobos 16.6 km, Deimos 15.5 km, Mimas 495 km, Enceladus 630 km, Miranda 590 km; all others keep `auto`. These tiny
SOIs have orbital speeds of 2-6 m/s (Phobos/Deimos) and the Mars tide would destabilise real orbits in days; with a
perturbation-free patched-conic model it is stable. "Orbit them" for these means hovering-class orbits at a few m/s.
Say so in the UI and keep landing for later.

### 2.5 Geometric albedo (NASA fact sheets) and mean colour for far shading

Planets: Mercury 0.142 (0.106 per JPL phys_par), Venus 0.689, Mars 0.170, Jupiter 0.538, Saturn 0.499, Uranus 0.488,
Neptune 0.442. Moons: Io 0.62, Europa 0.68, Ganymede 0.44, Callisto 0.19, Mimas 0.6, Enceladus 1.0, Tethys 0.8,
Dione 0.7, Rhea 0.7, Titan 0.22, Iapetus 0.05 / 0.5 (dark leading hemisphere / bright trailing), Miranda 0.32, Ariel
0.39, Umbriel 0.21, Titania 0.27, Oberon 0.23 (NASA NSSDC satellite fact sheets); Triton 0.76, Phobos 0.07, Deimos 0.07,
Charon 0.35, Ceres 0.09 **[unverified, memory]**. Bond albedos: Venus 0.77, Mars 0.25, Jupiter 0.343, Saturn 0.342,
Uranus 0.30, Neptune 0.29. These feed `render.geometricAlbedo` and `render.meanColor` (the far-field disc shading).

## 3. Atmospheres

Atmospheres to model: Venus, Mars, Titan (scattering + physics), Jupiter, Saturn, Uranus, Neptune (cloud-top + scale
height), and optionally Triton (14 microbar, ignore) and Pluto (ignore). Earth's existing set is in
`data/defs/render/earth.atmosphere.json` (Rayleigh [5.802, 13.558, 33.1]e-6 /m at about 680/550/440 nm, Mie scale
height 1,200 m, g 0.8). The same schema is used below. Rayleigh coefficients are derived, not looked up:
beta_R = beta_air,STP x (N/N_air) x (polarisability ratio)^2 x King factor, from refractive indices (CO2 n-1 = 4.5e-4,
N2 2.98e-4, H2 1.39e-4, He 3.5e-5 at STP; **[unverified]**: values from memory, accurate to ~5%). They are engineering
starting points to be tuned against reference photos; the physical anchors are the NASA numbers quoted.

| | Mars | Venus (above the clouds) | Titan | Jupiter | Saturn | Uranus | Neptune |
|---|---|---|---|---|---|---|---|
| Surface / reference pressure | 610 Pa (6.36 mb) | 92 bar (surface), reference level 70 km: ~0.04 bar | 1.467 bar | 1 bar (reference level) | 1 bar | 1 bar | 1 bar |
| Temperature at reference (K) | 214 | 737 (surface); ~230 at 70 km | 94 | 165 | 134 | 76 | 72 |
| Reference density (kg/m3) | 0.0154 (NASA ~0.016 +/- 0.006) | 65 at surface | 5.3 | 0.162 | 0.186 | 0.418 | 0.443 |
| Scale height (km) | 11.0 | 15.9 near the surface; ~4.9 near 70 km | 20.6 | 27 | 59.5 | 27.7 | 19.1-20.3 |
| Composition | CO2 95.1%, N2 2.6% | CO2 96.5%, N2 3.5% | N2 ~95%, CH4 ~5% | H2 89.8%, He 10.2% | H2 96.3%, He 3.25% | H2 82.5%, He 15.2%, CH4 2.3% | H2 80%, He 19%, CH4 1.5% |
| Mean molecular weight | 43.49 | 43.45 | 28 | 2.22 | 2.07 | 2.64 | 2.53-2.69 |
| Rayleigh scattering [R, G, B] (/m) at reference | [1.0e-7, 2.4e-7, 6.0e-7] | [2.0e-7, 4.8e-7, 1.2e-6] at 70 km | [2.4e-5, 5.6e-5, 1.4e-4] | [1.7e-6, 3.9e-6, 9.4e-6] | [2.0e-6, 4.7e-6, 1.15e-5] | [3.2e-6, 7.5e-6, 1.8e-5] | [3.3e-6, 7.7e-6, 1.9e-5] |
| Aerosol / Mie extinction (/m) | dust: 4.5e-5 (tau 0.5 over H_dust 11 km), more in dust storms | cloud deck (below) | tholin haze 6.5e-5 / 8.9e-5 / 1.25e-4 at surface | optional thin haze | optional thin haze | optional thin haze | optional thin haze |
| Aerosol single-scattering albedo [R, G, B] | [0.93, 0.90, 0.85] | ~[1.0, 0.99, 0.93] | [0.97, 0.92, 0.80] | - | - | - | - |
| Mie phase g | 0.6-0.7 (dust, forward) | 0.7 | 0.62 | - | - | - | - |
| Mie scale height (m) | 11,000 (dust mixed up to ~20 km) | cloud deck 48-70 km, haze to 90 km | 45,000 | - | - | - | - |
| Absorption (gas) [R, G, B] (/m) | - | - | - | ~0 (colour from the cloud map) | ~0 | methane: [1.8e-5, 2.2e-6, 1.8e-7] | methane: [3.0e-5, 3.0e-6, 2.0e-7] |
| `topAltitude` for the scattering model | 70 km | 120 km | 600 km (detached haze at ~500 km) | 300 km | 500 km | 300 km | 250 km |
| Physics `simTop` | 130 km | 250 km | 1,000 km | 1 bar + ~700 km | 1 bar + ~1,200 km | 1 bar + ~700 km | 1 bar + ~500 km |
| Atmosphere model | `exponential` rho0 0.0154 H 11.0 km, or `table` (MCD/Mars-GRAM) | `table` (VIRA: 65 kg/m3 at 0 km, ~1 at 50 km) | `table` (Huygens HASI) | `exponential` rho0 0.162 H 27 | rho0 0.186 H 59.5 | rho0 0.418 H 27.7 | rho0 0.443 H 19.7 |
| Gamma / gas constant | 1.29 / 188.9 | 1.28 / 188.9 | 1.4 / 296.8 | 1.43 / 3745 | 1.4 / 4017 | 1.4 / 3150 | 1.4 / 3080 |

**Venus clouds.** From orbit Venus is a featureless pale yellow-white disc: bond albedo 0.77, a thick H2SO4 cloud deck
between 48 and 70 km (optical depth ~30-40) with a UV-absorbing top (yellowish). Treat the visible body as a
single thick Mie layer (g ~0.7, near-conservative scattering, blue slightly absorbed, albedo target [0.93, 0.86, 0.66])
textured with the SSS cloud map (`4k_venus_atmosphere.jpg`, 4096 x 2048, CC BY 4.0) and a thin Rayleigh layer above it
that produces the bluish limb. The sub-cloud atmosphere (0-48 km, 90 bar, 737 K) matters only to physics and a
future landing; the surface is not visible from space. Radiative heating tables for CO2 entries are a new
`atmosphere.heating` set (Earth's is in `earth.json`; Sutton-Graves k scales as 1/sqrt(Rn) with the CO2/N2 gas
coefficient; Venus entries at ~10.7 km/s are comparable to a lunar return).

**Mars.** Rayleigh is negligible (optical depth of the whole column in blue ~0.007); the butterscotch daytime sky and
the blue sunset are Mie scattering by dust (tau ~0.3-0.9, effective radius ~1.5 micron, g ~0.65, absorbs blue). Dust
storms: let `mieScattering` scale with a global dust optical depth parameter (0.3 baseline, 3+ during a storm).

**Titan.** From orbit Titan is an orange haze ball: tholin aerosol of vertical optical depth ~4-5 at 0.5 micron,
strongly absorbing in blue, with a detached haze layer near 500 km. Surface is not visible at visible wavelengths from
orbit. Use the haze as the visible body (colour driven by the Mie parameters), and the USGS 938 nm ISS mosaic as the
surface albedo underneath for a low-altitude descent. Haze parameters are from memory of Tomasko et al. 2008 / Lorenz
**[unverified]**; verify the single-scattering albedos before final tuning.

**Gas and ice giants: workable treatment.** There is no surface. Define the body radius as the 1-bar equatorial
radius, render a thin scattering shell on top of a **cloud-top texture** (equirectangular, below), with: a Rayleigh
layer from the table (scale height 20-60 km), limb darkening from that scattering, and methane red-absorption for
Uranus and Neptune (the difference between a blue-green and a white planet). Differential rotation: the texture is
tied to System III (the `W` rate in 2.1); animate zonal flow by shifting texture u by `wind(lat) t / (R cos lat)`
relative to System III, with peak equatorial winds of ~100 m/s (Jupiter), ~400 m/s (Saturn), about -400 m/s
(Neptune) **[unverified, Voyager/Cassini values from memory]**. A vessel that dives below 1 bar meets pressure
(`maxDepth`, the physics floor, ~60 km below the 1-bar level at Jupiter = 10 bar) and is destroyed; ablation heating
uses the same `atmosphere.heating` schema with a hydrogen-helium gas coefficient (radiative term dominates above
~15 km/s; Jupiter entry is 60 km/s). Oblateness (6.5% Jupiter, 9.8% Saturn) means the atmosphere altitude must come
from the spheroid, section 7.3.

## 4. Rings

**Saturn (NASA NSSDC `satringfact.html`, fetched).** Radii from the planet centre:

| Feature | inner (km) | outer (km) | optical depth | albedo | thickness (m) |
|---|---|---|---|---|---|
| D | 66,900 | 74,510 | 1e-5 | - | - |
| C | 74,658 | 91,975 | 0.05-0.35 | 0.12-0.30 | 5 |
| B | 91,975 | 117,507 | 0.4-2.5 | 0.4-0.6 | 5-10 |
| Cassini division | 117,507 | 122,340 | 0-0.1 | 0.2-0.4 | 20 |
| A | 122,340 | 136,780 (Encke gap 133,410, Keeler gap 136,487) | 0.4-1.0 | 0.4-0.6 | 10-30 |
| F (narrow) | 139,826 | - | 0.1 | 0.6 | - |
| G | 166,000 | 173,000 | 1e-6 | - | - |
| E | 180,000 | 480,000 | 1e-6 | - | - |

**Usable texture:** `https://www.solarsystemscope.com/textures/download/8k_saturn_ring_alpha.png` (verified: 8192 x
500 RGBA PNG, 65 KB, CC BY 4.0), a radial strip; I did not verify which radial range its edges represent (assume the C
inner edge to the A outer edge, 74,500-140,220 km, and calibrate against the fact-sheet gaps). A physically better
source is Bjorn Jonsson's Voyager-based ring model (`https://bjj.mmedia.is/data/s_rings/index.html`: three viewing
geometries plus the Voyager occultation optical-depth profile at 5 km resolution) but see the licence note in 5.4.
Render recipe: treat the ring as a flat annulus in the planet's equatorial plane (pole from 2.1); per texel an optical
depth tau and albedo; lit-side reflection = albedo (1 - exp(-tau/mu_sun)), unlit-side transmission = exp(-tau/mu_sun)
(the unlit rings glow where they are thin); a forward-scattering phase function (strong lobe, Saturn's rings are
spectacular from the dark side); the ring shadow on the planet and the planet's shadow on the rings are analytic
(project along the sun direction onto the ring plane). Physical thickness (5-30 m) makes collisions irrelevant; a
vessel crossing the plane needs nothing. Because the rings tilt 26.73 deg with the pole, their plane is the body
equatorial plane via `qFixedToRoot`.

**Other rings (all data-only, optional) [unverified, memory]:** Uranus: 13 narrow dark rings between ~38,000 km
(6) and ~51,150 km (epsilon, tau up to ~2), albedo ~0.03; Neptune: Galle ~41,900, Le Verrier ~53,200, Adams ~62,930
km (with arcs), albedo ~0.03; Jupiter: halo ~92,000-122,500 km, main 122,500-129,000 km, gossamer to ~226,000 km,
tau ~1e-6. Skip Uranus/Neptune/Jupiter rings in the first pass; they are invisible at typical ranges.

## 5. Visuals: placeholder-but-real

### 5.1 The rule for entering the existing pipeline

The tile pipeline already consumes anything that is (a) a sphere with a body-fixed frame, (b) a gnomonic cube
mapping (`tools/bake/common/cube.py`, mirrored by `src/core/geo/cubeSphere.ts`), (c) layers named `height` and
`albedo` of the formats in `TileManifest`. The Moon bake (`tools/bake/moon`) and Earth bake (`tools/bake/earth`) are
bespoke only in their *sources* (regional DEMs, de-shading); the shared parts are `common/cube.py`,
`common/layout.py` (disk layout `data/tiles/<tileset>/<layer>/<face>/<level>/<x>/<y>.<ext>`, manifest write and
content hash), `earth/hpyramid.py` (the 1-2-1 full-weighting height pyramid, seamless across face edges) and the
256 px WebP albedo writer. Plan: a single `tools/bake/planet/` driver reading
`tools/bake/planet/bodies/<id>.json`:

```
{ "id": "mars", "radius": 3389500, "datum": "mean-sphere",
  "shape": { "equatorialRadius": 3396190, "polarRadius": 3376200 },
  "albedo": { "url": ".../Mars_Viking_ClrMosaic_global_925m.tif", "sha256": "...", "bytes": 797888177,
              "projection": "simple-cylindrical", "lat": "planetocentric", "lonPositive": "east", "lonRange": [0,360],
              "maxLevel": 6, "colour": "rgb" },
  "height": { "url": ".../Mars_MGS_MOLA_DEM_mosaic_global_463m.tif", "units": "m", "reference": "areoid",
              "maxLevel": 5 },
  "attribution": ["USGS Astrogeology / NASA MGS MOLA"] }
```

Steps, each a pure function of the config: fetch (resumable; reuse `tools/bake/moon/fetch.py`), window-read with
`rasterio` (already in `tools/bake/earth/requirements.txt`; the 12.7 GB Viking MDIM2.1 colour file must be read in
windows, never loaded), resample to the finest level with an area filter, build the coarser levels by the
existing full-weighting pyramid, write tiles, write the manifest with `residentHeightLevel` and a `contentHash`.
One Python module, one JSON per body, no per-body code. Body shape: the height layer is "radius minus the datum
sphere", so a triaxial moon (Phobos, Iapetus, Mimas) is handled by baking `ellipsoid_radius(dir) - R_mean (+ DEM)` into
the height layer; the physics and render see a normal heightfield. Collision and impact prediction then work for
every body exactly as they do for Earth and Moon: `TerrainProvider.heightAt(bodyId, dirFixed)` over the resident level
(set 3 by the Moon precedent), with the procedural amplification model chosen per body in `terrain.amplification`
(a registry key; new keys `rocky-generic` and `icy-generic` are the only code, derived from `lunar-regolith`).

Landmark tests per body (a 10-line table in the config): Olympus Mons (18.65 N, 226.2 E, +21.2 km above the MOLA
datum), Valles Marineris, Caloris Basin (30 N, 160 E), Hellas (-42 N, 70 E), Tycho on the Moon (already). Longitude
conventions are the main trap: USGS file names carry `clon0` / `clon180` (centre longitude), planetocentric vs
planetographic latitude, and IAU planetographic longitudes increase *westward* for prograde rotators in the older
products; the test catches a flipped or shifted map in one assertion.

### 5.2 Pyramid size and levels

Level L has 6 x 4^L tiles; cumulative 2 (4^(L+1) - 1); the albedo tile is 256 px, so ground sample = R (pi/2) /
(256 2^L). Target: the texel is close to the source resolution but a body costs at most L = 6 (albedo) / 5 (height).
Moon precedent: albedo tile ~8.8 KB, so L5 is ~72 MB, L6 ~290 MB.

| Body | albedo level (m/px) | height level (m/px) | tiles (albedo + height) |
|---|---|---|---|
| Mercury | 5 (468) | 5 (468) | 16,380 |
| Venus | 4 (2,321) | 4 (2,321) | 4,092 |
| Mars | 6 (325) | 5 (650) | 40,956 |
| Phobos | 3 (8) | 3 (8) | 1,020 |
| Deimos | 2 (10) | 2 (10) | 252 |
| Io, Europa, Ganymede, Callisto | 5 (300-500) | 3 (1.2-2.0 km) | 8,700 each |
| Mimas | 3 (152) | 3 (152) | 1,020 |
| Enceladus, Tethys, Dione, Rhea, Iapetus | 4 (100-300) | 3 (190-590) | 2,556 each |
| Titan | 4 (987) | 4 (987) | 4,092 |
| Miranda, Ariel, Umbriel, Titania, Oberon | 3 (180-600) | 3 | 1,020 each |
| Triton | 4 (519) | 3 (1.0 km) | 2,556 |
| Pluto | 5 (228) | 5 (228) | 16,380 |
| Charon | 4 (232) | 4 (232) | 4,092 |
| Ceres | 4 (180) | 4 (180) | 4,092 |
| **Total (25 bodies)** | | | **~148,000 tiles, ~0.9 GB albedo + ~1.9 GB height (est. 45 KB/tile, to measure)** |

Delivery note (the user's hosting constraint: the Earth/Moon data is already ~15 GB in ~400,000 files): ~148,000 more
files would be 37% more files for 18% more bytes. Pack the small bodies (and the coarse levels of the large ones) as
one archive per body and layer with a tile index (a PMTiles-like container with HTTP range reads) instead of one file
per tile; the tile client already addresses by (face, level, x, y), so only the fetch layer changes. This is a hosting
decision for the architect; the numbers are here.

### 5.3 Per-body sources (all URLs probed with a HEAD request and returned 200 with the stated size)

Pattern: `https://planetarymaps.usgs.gov/mosaic/<file>`. USGS Astrogeology products from NASA missions are U.S.
Government works (public domain; credit "NASA/JPL-Caltech/USGS" as courtesy; the USGS copyright page returned 403 to
my fetch, so the licence statement is **[unverified in text]** but is the long-standing USGS position).

| Body | Colour/albedo source | Size | Height source | Size | Notes |
|---|---|---|---|---|---|
| Mercury | `Mercury_MESSENGER_MDIS_Basemap_BDR_Mosaic_Global_166m.tif` (mono 166 m); colour alt: `..._EnhancedColor_Mosaic_Global_665m.tif` (false colour, exaggerated) | 4.25 GB; 797 MB | `Mercury_Messenger_USGS_DEM_Global_665m_v2.tif` | 531 MB | tint the mono map with mean colour; oblateness 0.0009 ignored |
| Venus | `Venus_Magellan_C3-MDIR_Colorized_Global_Mosaic_4641m.tif` (radar, coloured by height); or SSS `8k_venus_surface.jpg` (8192 x 4096, CC BY 4.0) | 101 MB; 12.5 MB | `Venus_Magellan_Topography_Global_4641m_v02.tif` | 67 MB | surface hidden by clouds, placeholder is enough; cloud map `4k_venus_atmosphere.jpg` (CC BY 4.0, 1.5 MB) |
| Mars | `Mars_Viking_ClrMosaic_global_925m.tif`; finer: `Mars_Viking_MDIM21_ClrMosaic_global_232m.tif` (12.7 GB), mono 232 m (4.2 GB); SSS `8k_mars.jpg` as a fallback (8192 x 4096) | 798 MB | `Mars_MGS_MOLA_DEM_mosaic_global_463m.tif` (heights relative to the areoid; add the areoid/ellipsoid radius so the height layer carries the 20 km polar flattening) | 2.13 GB | polar caps are in the Viking colour; clouds optional |
| Phobos | `Phobos_Viking_Mosaic_40ppd_DLRcontrol.tif` | 104 MB | triaxial ellipsoid 13.0 x 11.4 x 9.1 km, or a shape model **[not found in the bucket listing]** | - | `Phobos_ME_SRC_Mosaic_Global_16ppd.tif` (16.6 MB) also exists |
| Deimos | none in the USGS bucket; procedural | - | ellipsoid 7.8 x 6.0 x 5.1 km | - | |
| Io | `Io_GalileoSSI-Voyager_Global_Mosaic_ClrMerge_1km.tif` | 197 MB | Jonsson DEM is "largely fictional" (his words); use a flat sphere + amplification | - | mono 1 km (65.5 MB) also exists |
| Europa | `Europa_Voyager_GalileoSSI_global_mosaic_500m.tif` (mono) | 193 MB | sphere | - | tint to white-brown lineae |
| Ganymede | `Ganymede_Voyager_GalileoSSI_Global_ClrMosaic_1435m.tif` | 199 MB | sphere | - | |
| Callisto | `Callisto_Voyager_GalileoSSI_global_mosaic_1km.tif` (mono) | 115 MB | sphere | - | tint dark brown-grey |
| Mimas | none found in the bucket (Voyager/Cassini mosaics exist at USGS Astropedia but not under `mosaic/` **[not verified]**); procedural: albedo 0.6 + Herschel crater (130 km) | - | ellipsoid 207.8 x 196.7 x 190.6 | - | |
| Enceladus | `Enceladus_Cassini_ISS_Global_Mosaic_100m_HPF.tif` | 126 MB | ellipsoid 256.6 x 251.4 x 248.3 | - | |
| Tethys | `Tethys_Cassini_mosaic_global_293m.tif` | 66 MB | ellipsoid | - | |
| Dione | `Dione_Cassini_Voyager_mosaic_global_154m.tif` | 265 MB | ellipsoid | - | |
| Rhea | `Rhea_Cassini_Voyager_mosaic_global_417m.tif` | 66 MB | ellipsoid | - | Jonsson's Rhea colour/albedo is nicer; see licence |
| Titan | `Titan_ISS_P19658_Mosaic_Global_4km.tif` (938 nm surface albedo) | 8.2 MB | sphere (Cassini SAR topography is partial) | - | the visible body is the haze shell (section 3) |
| Iapetus | `Iapetus_Cassini_Voyager_mosaic_global_783m.tif` | 16.6 MB | ellipsoid 745.7 x 745.7 x 712.1 (equatorial ridge optional) | - | the two-tone albedo (0.05 / 0.5) is the visual identity |
| Miranda, Ariel, Umbriel, Titania, Oberon | none in the bucket (Voyager 2 covered ~40-50% at good resolution); procedural icy-cratered, albedo per 2.5 | - | spheres | - | accept as the documented placeholder |
| Triton | `Triton_Voyager2_ClrMosaic_GlobalFill_600m.tif` | 300 MB | sphere | - | |
| Pluto | `Pluto_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif` | 310 MB | `Pluto_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif` | 620 MB | |
| Charon | `Charon_NewHorizons_Global_Mosaic_300m_Jul2017_8bit.tif` | 81 MB | `Charon_NewHorizons_Global_DEM_300m_Jul2017_16bit.tif` | 161 MB | |
| Ceres | `Ceres_Dawn_FC_DLR_global_20ppd_Oct2015.tif` | 27 MB | `Ceres_Dawn_FC_HAMO_DTM_DLR_Global_60ppd_Oct2016.tif` | 467 MB | |
| Jupiter | SSS `8k_jupiter.jpg` (4096 x 2048 actually, CC BY 4.0, 3.1 MB) | - | none (gas giant) | - | Jonsson Cassini map is better, licence note |
| Saturn | SSS `8k_saturn.jpg` (4096 x 2048, 1.1 MB, CC BY 4.0) | - | none | - | |
| Uranus | SSS `2k_uranus.jpg` (2048 x 1024, 78 KB) | - | none | - | near-featureless by nature |
| Neptune | SSS `2k_neptune.jpg` (2048 x 1024, 242 KB) | - | none | - | Jonsson's Voyager 2 map is higher resolution |
| Sun | SSS `8k_sun.jpg` (3.7 MB) or a procedural granulation; the Sun is an emitter | - | - | - | |
| Earth, Moon | existing bakes | | | | |
| Rings | SSS `8k_saturn_ring_alpha.png` (8192 x 500 RGBA, 65 KB) | | | | |

Total download for the recommended set ~ 10 GB (Mercury BDR 4.25 GB and Mars MOLA 2.1 GB dominate; use the lower
resolutions if bandwidth matters: EnhancedColor 665 m for Mercury, Viking colour 925 m for Mars).

### 5.4 Licences and gaps

* **Solar System Scope**: CC BY 4.0 ("Distributed under Attribution 4.0 International license" on
  https://www.solarsystemscope.com/textures/; licence text https://creativecommons.org/licenses/by/4.0/ reachable).
  Credit line required in the credits screen. Many of their maps are artist-processed from NASA data (e.g. the dwarf
  planet files are literally named `_fictional`; do not use those).
* **Bjorn Jonsson** (https://bjj.mmedia.is/data/planetary_maps.html, verified text): "publicly available. You do not
  need a special permission to use them but ... please mention their origin" **but also** "please do not place a
  copy of the maps on your website". A baked tile pyramid served from our CDN is a copy; either ask him (feedback form
  linked from his site) or use the SSS/USGS equivalents. Maps there: Venus, Jupiter (Cassini, Voyager 1/2), Io,
  Europa, Ganymede, Callisto, Saturn (Cassini south, Voyager north, 9000 x 4500 full size), Saturn's rings, Rhea,
  Neptune. He asks for credit as "created by Bjorn Jonsson".
* **Gaps with no good global map**: Mimas, Miranda, Ariel, Umbriel, Titania, Oberon, Deimos. They will be procedural
  (mean albedo + crater population from the existing amplification model). That is the cheapest thing that still
  looks right from orbit and uses no new code path.
* **Expansion scope check**: the brief allows simple surfaces off Earth and Moon, so L3-L6 placeholders with generic
  amplification satisfy it. Landing is a future update; the pyramid is then deepened per body by adding levels (same
  tool, higher `maxLevel`, regional rectangles as in the Moon bake).

## 6. Flight-planning numbers

Method (reproducible; the throw-away scripts are not in the repo): Earth start = circular LEO at 185 km (sim's
parking orbit; radius 6,371 + 185 km), departure by impulsive burn to the required v_inf (dv = sqrt(v_inf^2 + 2mu/r)
- sqrt(mu/r)). Heliocentric legs: a 3-D Lambert solver (universal variables, prograde, no gravity assists)
between **JPL Table 1 positions** of Earth (EM barycentre) and the target for departure dates 2030-2044, one
synodic-period window at a time. Arrival: impulsive insertion at the target. Two arrival styles: **circular** =
circular orbit at the stated altitude; **ellipse** = capture into an ellipse with the stated period, periapsis at the
same altitude (the cheap "orbit"). "Best" = the best window in ~14 years, "worst" = the worst window's best. Low orbit
altitudes: Mercury 100 km, Venus 300 km, Mars 200 km, giants 0.1 R above the 1-bar radius; ellipse periods: Mercury
0.5 d, Venus 1 d, Mars 1 d, Jupiter and Saturn 30 d, Uranus and Neptune 20 d. No inclination matching at the target
beyond what the Lambert arc implies.

### 6.1 Delta-v from LEO and transfer times

Hohmann-class = ToF within 0.8-1.2 x the circular-orbit Hohmann time (Mercury 105.5 d, Venus 146.1 d, Mars 258.9 d,
Jupiter 997.5 d = 2.73 y, Saturn 2,208 d = 6.05 y, Uranus 5,857 d = 16.0 y, Neptune 11,182 d = 30.6 y).

| Target | Hohmann-class dv, circular low orbit: best (worst window) | Hohmann-class, capture ellipse: best | v_inf dep / arr (km/s) | Departure dv alone | Fast (0.6 x Hohmann ToF): ToF, dv circ / ellipse | Fast (0.45 x): ToF, dv circ / ellipse |
|---|---|---|---|---|---|---|
| Moon (TLI + LOI) | 3.96 (sim: 3.15 + 0.78) | - | - | 3.14 | - | - |
| Mercury | 13.4 (19.9) | 12.5 | 9.4 / 8.8 | 6.7 | 63 d: 18.0 / 17.1 | 48 d: 27.2 / 26.3 |
| Venus | 7.1 (8.8) | 4.5 | 3.2 / 3.0 | 3.7 | 88 d: 8.0 / 5.5 | 66 d: 9.7 / 7.1 |
| Mars | 6.1 (6.6); best of 0.8-1.2 x is 5.7 | 4.9 | 4.0 / 2.9 | 3.9 | 155 d: 6.3 (9.8) / 5.1 | 117 d: 7.7 / 6.5 |
| Jupiter | 23.4 (24.2) | **7.0** | 8.8 / 5.7 | 6.3 | 599 d: 24.3 / 7.9 | 449 d: 26.2 / 9.8 |
| Saturn | 17.8 (19.2) | **8.05** | 10.4 / 5.3 | 7.35 | 1,325 d: 18.5 / 8.7 | 994 d: 20.2 / 10.4 |
| Uranus | 14.8 (14.9) | **9.0** | 11.6 / 4.9 | 8.2 | 3,514 d: 15.2 / 9.4 | 2,636 d: 16.4 / 10.6 |
| Neptune | 15.8 (16.2) | **9.4** | 12.5 / 4.1 | 8.9 | 6,709 d: 16.1 / 9.7 | 5,032 d: 16.9 / 10.5 |

Reading it: circular insertion at the giants is the expensive part (Jupiter 17 km/s of the 23); an elliptical
capture costs 7-9.4 km/s from LEO for *every* outer planet, close to a Mars circular orbit. Faster transfers are
cheap at the outer planets (Saturn in 3.6 y instead of 6 y for +0.7 km/s ellipse capture) and expensive at the inner
planets (Mars at 0.45x costs +1.6 to +7.5 km/s depending on the window). Mercury is the outlier: even the best
Hohmann-class window needs 12.5-13.4 km/s with no gravity assist; the 7 degree inclination and 0.2 eccentricity make
the window quality vary by 50%. Add 9.4 km/s to reach LEO from the ground (the sim's Earth ascent) for total budgets.

### 6.2 Moon systems (from LEO, no gravity assists, Hohmann-class arrival v_inf)

Estimate A = tangential flyby at the moon's orbit radius, then capture to a low moon orbit (100 km alt for R > 1000
km, 50 km for R 200-1000 km, 10 km below). B = capture at the planet into an ellipse whose apoapsis touches the moon's
orbit, then capture at the moon. The cheaper of the two is quoted; real mission designs use moon gravity assists and
resonant tours to cut these by 20-40% (the patched-conic sim supports that for free).

| Moon | dv from LEO (km/s) | | Moon | dv from LEO (km/s) |
|---|---|---|---|---|
| Phobos / Deimos | 5.7-6.0 (rendezvous with a 2-6 m/s "orbit") | | Rhea | 11.6 |
| Io | 12.8 | | Titan | 10.2 (aerobraking cuts ~2.8 km/s, section 6.5) |
| Europa | 11.7 | | Iapetus | 10.4 |
| Ganymede | 10.5 | | Miranda | 12.1 |
| Callisto | 9.9 | | Ariel / Umbriel | 11.6 / 11.4 |
| Mimas | 13.8 | | Titania / Oberon | 11.2 / 11.1 |
| Enceladus | 13.2 | | Triton | 11.2 (its atmosphere is 14 microbar: no aerobraking) |
| Tethys / Dione | 12.6 / 12.1 | | Charon | not computed (Pluto v_inf is not in the table) |

So every outer moon is a 10-14 km/s mission from LEO, after the 9.4 km/s ascent. Chemical stages need staging in LEO
or docked assembly (a natural use of the rendezvous/docking feature).

### 6.3 Windows

Synodic periods (the interval between equal launch windows): Mercury 115.9 d, Venus 583.9 d (1.60 y), Mars 779.9 d
(2.14 y), Jupiter 398.9 d, Saturn 378.1 d, Uranus 369.7 d, Neptune 367.5 d. Outer-planet windows are annual and so
forgiving that "any day" within ~2 months works; Mars and Venus windows are sharp (the worst window of the next
decade costs +0.5 to +1.7 km/s). The Moon needs the pad to pass through the Moon's orbit plane (sidereal day, solved
analytically by `computeLaunchWindow`). The rendezvous design question for multiplayer: two craft launched in the same
Mars window arrive within days of each other; two in different windows are 2 years apart.

### 6.4 Time-warp rates

Rails warp today tops out at 100,000x (`WARP_LEVELS = [1,2,3,4,5,10,50,100,1000,10000,100000]`). Wall time for the
Hohmann-class cruise at 100,000x, and what is needed to fit a 10-minute leg:

| Target | cruise (d) | wall time at 1e5x | warp for 10 min | wait-for-window worst case (syn. period) at 1e5x |
|---|---|---|---|---|
| Moon | 3 | 2.6 s at 1e5; 4.3 min at 1e3 | 430x | 27 d |
| Mercury | 105 | 1.5 min | 15,000x | 1.7 min |
| Venus | 146 | 2.1 min | 21,000x | 8.4 min |
| Mars | 259 | 3.7 min | 37,000x | 11.2 min |
| Jupiter | 998 | 14.4 min | 144,000x | 5.7 min |
| Saturn | 2,208 | 31.8 min | 318,000x | 5.4 min |
| Uranus | 5,857 | 84 min | 843,000x | 5.3 min |
| Neptune | 11,182 | 161 min | 1,610,000x | 5.3 min |

Fast transfers (0.6x) halve the outer numbers but not enough. Recommendation: add 1e6 and 1e7 rails levels (then
Neptune is 16 min at 1e6x, 1.6 min at 1e7x), plus an "auto-warp to the next event" action (SOI change, burn, window)
which `nextWarpEvent` already supports. Per-body `warpAltitudeLimits` gets two more entries (9 per body). At 1e7x one
frame (16 ms) is 1.85 days, so a moon with a 0.32 d period (Phobos) completes six revolutions per frame: rails
state is analytic so this is correct, but rendering and any proximity logic must switch to "snapshot only" when warp
is high near a moon system. In multiplayer these levels apply only to a craft that is alone; the synchronisation model
is another document.

### 6.5 Aerobraking and aerocapture

Entry speed at the atmosphere interface for a Hohmann-class arrival: Mars (interface 120 km) 5.7 km/s, Venus (150 km)
10.7 km/s, Titan (interface 1,000 km, after Saturn capture) ~4.5 km/s, Jupiter at 1 bar 60.5 km/s, Saturn 36.5,
Uranus ~21.9, Neptune ~23.9 (v_esc and v_inf combined).

| Body | what aerocapture/aerobrake saves from the totals in 6.1-6.2 | feasibility |
|---|---|---|
| Mars | the insertion burn: 2.2 km/s (circular) or 1.0 km/s (1-sol ellipse); LEO to LMO from 6.1 to ~3.9 km/s | easy: thin atmosphere (610 Pa, H 11 km), 5.7 km/s, existing heating model class; multiple aerobraking passes over weeks at warp |
| Venus | up to 3.4 km/s (circular) / 0.9 (ellipse) | feasible: 10.7 km/s is a lunar-return class entry; thick atmosphere, high peak heating |
| Titan | 2.8 km/s of the Saturn-system 10.2 | the best aerobraking target in the outer system (1.45 bar, 5.3 kg/m3, low entry speed, 1.35 m/s2) |
| Jupiter, Saturn | none practical | 60 and 36 km/s entries: heating and g beyond any realistic vehicle |
| Uranus, Neptune | would save ~2.5-6 km/s of the ellipse capture | 22-24 km/s entry; published ice-giant aerocapture studies exist **[unverified, from memory]**; keep as an advanced stunt |
| Mercury, Moon, Mimas, etc. | none | no atmosphere |

The present `AtmosphereDef` supports all three models needed (`ussa76` / `table` / `exponential`) and the heating
schema (`kConv`, radiative table) is per body; the work is data per body (CO2 and H2/He gas coefficients) plus the
Venus/Mars/Titan tables from public references (VIRA, Mars-GRAM/MCD, Huygens HASI) which I did not fetch.

### 6.6 What "reach and orbit" demands of a vehicle (rocket equation)

Mass ratio m0/mf = exp(dv / (g0 Isp)) for impulsive burns after the ascent. For the 9.4 km/s ellipse capture at
Neptune: kerolox (Isp 350 s) 15.5, hydrolox (450 s) 8.4, nuclear-thermal (900 s) 2.9. For a Jupiter ellipse (7.0
km/s): 7.7 / 4.9 / 2.2. For Mars circular (6.1): 5.9 / 4.0 / 2.0. For the Moon (4.0): 3.2 / 2.5 / 1.6. A capture ellipse
at a giant (periapsis 1.1 R) is a dive through the radiation belts and a 30 day orbit: the game should call that
"orbit" and tally it.

Tiers a fleet should span: **A** LEO only (9.4 km/s); **B** Moon (+4.0); **C** Mars/Venus ellipse (+4.5-4.9) or
circular (+6-7); **D** outer-planet capture ellipse (+7-9.4); **E** moon-system orbit (+10-14), only with an
in-space stage and refuelling or nuclear/electric propulsion. **A design flag the fleet depends on:** low-thrust
(ion) craft cannot fly cruise legs under the present model, where rails warp is pure coasting and physics warp stops
at 5x. Either exclude electric propulsion from the fleet or design thrust-on-rails (constant acceleration
integrated over rails time, as KSP's mods and several space sims do). The multiplayer model (burns, encounters) needs
the same decision.

## 7. What the present ephemeris and SOI code needs

Facts read from `docs/handoff/sim-orbits.md` and the source: `src/sim/bodies/bodySystem.ts` builds one tree with one
root and one star; ephemerides are `KeplerEphemeris` (fixed mean elements, no secular drift, `n = sqrt((mu_parent +
mu_body)/a^3)`, ecliptic frame rotated by 23.4392911 deg, or `parentEquator` rotated by the parent's pole) or
`SunLowPrecisionEphemeris` (only for a child of the root); SOI is `auto` = a (m/M)^0.4 or a number; each body's patch
search tests only the direct attractor children of the current body (`childIds`); `predictPatches` budget 0.26-0.29
ms for a TLI through an SOI change; warp is a global index with 7 rails levels; the vessel state is stored in BCI of
its SOI body and handed over at SOI crossings by adding/subtracting `stateRelParent` (exactly the design that scales).

### 7.1 Root and frames

* Re-root to the Sun: `sun.json` becomes `parent: null`, `gravityRole: "attractor"`, keeps `emission`, `mu` and
  `radius`; `earth.json` gets a `parent: "sun"` and an orbit; every planet is a child of the Sun and every moon a child
  of its planet. `BodySystem` already allows the root to be the star. The `sunLowPrecision` ephemeris is currently
  restricted to a child of the root; for Earth about the Sun add `invert: true` (state = minus the geocentric sun
  state). Then `sunDirection` and `sunVisibility` still work (the star is the root, `stateRoot(star)` is zero).
* ROOT stays J2000 equatorial axes, so star-catalogue and Milky Way cubemap orientation and every rotation are
  unchanged; only the origin moves from Earth to the Sun. Audit every consumer of `rRoot` (`src/audio`, `src/camera`,
  `src/render/core/frame`, `src/render/vfx/director.ts`, `src/pilot`, `src/map`, `src/sim/nav/startWindow.ts`) for the
  assumption "Earth is at the origin" and for float32 narrowing of ROOT positions: at 1 AU a float32 ULP is 8 km,
  at Neptune 0.5 Mm. The documented rule (camera-relative float64 subtraction before narrowing) already covers it,
  but this is the single biggest regression risk of the change; add a test that renders at Neptune.
* ARCHITECTURE sections 3/20 say "ROOT = centre of the root body (Earth)"; that text changes to "the Sun".
* **Tests that pin Earth-as-root:** `tools/sim/start-time.json`, the sun-declination test (0.0032 deg), the launch
  window tests. With the negated AA Sun formula and the same Earth rotation they should reproduce exactly; keep them
  as the regression gate for the re-root.

### 7.2 Ephemeris content

* Planets: JPL Table 1 elements with the six rates. The KeplerEphemeris takes fixed elements; add per-element rates
  (per century or per year) applied as `elem(ut) = elem0 + rate (ut - epoch)`, default 0 (the Moon stays frozen).
  Add the `meanMotionDegPerDay` override, and compute `M = L - w_bar` with the mean anomaly rate = L-rate - w_bar-rate
  - node-rate-weighted term (for fast-precessing satellites such as Mimas, w_bar-dot is 0.5% of n).
* Moons: three plane frames: `ecliptic` (Moon, and the Pluto/Ceres/planets), `parentEquator` (Uranian, Neptunian; use
  the **positive** Uranus pole), and a new `pole { raDeg, decDeg }` for Laplace planes (Mars moons, Jovian moons,
  Saturnian moons). The Uranus retrograde-pole sign is the cheap trap: the repo's rotation model treats the IAU pole
  (257.311, -15.175) as the spin pole, which is right for `rotation`, wrong for the orbit plane of the satellites.
* Precession: Phobos' node regresses in 2.3 y, Mimas' in 0.99 y, the Moon in 18.6 y. Without the rates the conic is
  frozen and the moon systems do not drift apart from reality, which is fine for a game within a session but wrong
  over the years a persistent universe lives. Decide with the persistence document whether the universe runs only
  forward from a fixed epoch; the rates cost nothing at runtime (a few multiplies per body per ephemeris call).
* Validation: a test (and a tool) that compares every body's position against Horizons at ~10 epochs over 2030-2060;
  tolerances per source accuracy (planets: the JPL table above; moons ~1 deg phase). I ran this by hand for 8 moons
  at J2000 (section 2.3).

### 7.3 Body-model additions

* `flattening` (or equatorial + polar radius) on `BodyDef`; one `surfaceRadius(body, dirFixed)` used by altitude
  (atmosphere sampling, warp altitude limits, navball switch), the sea/datum surface and the baker. It is mandatory for
  Jupiter (6.5%) and Saturn (9.8%): with the mean-radius sphere, the 1-bar level is 1,580 km above the sphere at the
  equator of Jupiter (and 3,870 km above the pole of Saturn's sphere), so atmosphere entry altitudes would be wrong by
  that much. Earth can keep 0 (the repo accepts the 21 km sphere error).
* `rings` block on a body: `[{ innerRadius, outerRadius, texture, opticalDepthScale }]`; render-only.
* Atmosphere `heating` sets and the new `AtmosphereDef` `table` rows for Venus/Mars/Titan from public data.
* Sun attractor: heliocentric kill radius (photosphere) and an out-of-range rule: a hyperbolic heliocentric escape
  beyond e.g. 100 AU (1.5e13 m) expires the ship (also bounds persistence).

### 7.4 SOI and prediction

* Min SOI stepping: `findSoiEntry` steps of `d/V` with a minimum of 30 s. With the new tiny SOIs (Phobos 16.6 km at
  ~2 km/s relative, crossing in 8 s; Mimas 495 km at 14 km/s, 35 s) a fixed 30 s floor misses encounters. Make the
  floor `min(30 s, SOI / (4 V))`.
* Horizon: `predictPatches` default horizon is 60 days for open orbits; heliocentric legs last years. Make the
  horizon a function of the body (e.g. 3 x the circular period at the periapsis, capped at 40 y) and `maxPatches`
  higher (a Mars return alone is Earth, Sun, Mars, Mars-moon, Sun, Earth = 6-8 patches; a Jupiter-assist outer
  mission is 10+).
* Closest approach: `closestApproaches` samples 64 points over **one period** of the patch; between a heliocentric
  patch and a planet with a different period that is not a search for a close approach. Replace with an adaptive scan
  over the horizon with step <= min(period)/64 and golden refinement, restricted to bodies whose orbit radius range
  brackets the patch's.
* Cost: at the Sun level the patch search tests 8 children over years of horizon; the TLI example costs 0.26 ms,
  I estimate 5-20 ms for a Sun patch (8 children x the d/V stepping of ~1e8 km at 60 km/s over ~1,000 steps). Run it
  off the main thread and re-run only on change (burn, SOI crossing); the multiplayer server runs the same function,
  so its cost is a capacity number: ~100-200 predictions per second per core at that estimate **[estimate, measure]**.
* Hierarchy: Sun -> planet -> moon is three levels. Because a moon's SOI is inside its planet's SOI, a patch never
  needs to test grandchildren; `childIds` is already per-body.
* The perturbation-free assumption is a feature for the server: every craft's rails state is analytic and every body
  is a pure function of `ut`; no body or craft ever needs integrating while on rails (only burns, atmosphere and
  contact).

### 7.5 Precision

| Quantity | Magnitude | float64 ULP | Matters? |
|---|---|---|---|
| `ut` in 2037 (1.19e9 s) | 1.2e9 s | 2.4e-7 s (1.9 mm at 8 km/s) | tolerable; common-mode for craft in the same frame |
| Earth in Sun frame | 1.5e11 m | 3e-5 m | no |
| Neptune in Sun frame | 4.5e12 m | 1e-3 m | only if two craft in different SOIs near each other are differenced through ROOT |
| Craft in Neptune frame | <= 9e10 m | 1.5e-5 m | no |
| Phase M = n (ut - epoch), Phobos | n 2.2e-4 rad/s x 1.2e9 s = 2.6e5 rad | 4e-11 rad = 0.4 mm of arc | no |
| Rotation W, Jupiter | 1.76e-4 rad/s x 1.2e9 = 2.1e5 rad | 2e-11 rad = 1.5 mm at the equator | no |
| Heliocentric velocity | 30 km/s | 4e-12 m/s | no |

Rules to keep, all already in the design but worth stating for the Sun-centred system: (1) never subtract two
ROOT-frame positions of craft in the same SOI; subtract their BCI states. (2) Docking and contact run in the
vessel/target frame with a local origin, not ROOT. (3) Camera-relative float32 conversion happens after a float64
subtraction. (4) At high warp, `ut` advances by up to 1.6e5 s per frame and per-craft `propagate` stays exact because
it rebuilds from the epoch state each time (the repo's own measurement: exact after 1e6 periods). (5) Time-zero
effects: the Table 1 elements and SBDB epochs mix J2000 (Table 1) and 2016/2026 (Pluto/Ceres); each body carries its own
`epochUt`.

Illumination range for the renderer (facts, from the Sun's 128,000 lux at 1 AU in `sun.json`): Mercury at perihelion
~1.3 million lux, Earth 128,000, Mars 55,000, Jupiter 4,700, Saturn 1,400, Uranus 350, Neptune 142, Pluto ~80.
Angular diameter of the Sun: 1.4 deg (Mercury) to 1.1 arcmin (Neptune). The exposure range spans four decades and the
Sun's disc in the sky/atmosphere/shadow code must scale with distance (the snapshots already carry `sunDistance`).

## 8. Risks and open items for the architect

1. **Saturn mean-element convention unresolved** (section 2.3). The generator must be validated against Horizons;
   budget for deriving Saturn's moons from state vectors.
2. **Phobos/Deimos/Mimas SOI** rule and the "orbit" meaning (2.4).
3. **Spheroid altitude** for the giants (7.3) touches atmosphere, navball and warp limits; scope it as one function.
4. **Ephemeris end-of-validity**: Table 1 is a fit to 2050; the persistent universe will pass it. Either extend the
   rates (Table 2a/2b is valid 3000 BC-3000 AD at lower accuracy) or declare the clock internal. Do not discover this
   in 2050.
5. **Low-thrust propulsion** (6.6) is a fleet-wide model decision.
6. **Tile delivery**: 148,000 extra files; pack the small bodies (5.2).
7. **Licences**: Jonsson's no-copy request; keep the credits screen with CC BY (SSS) and NASA/USGS lines (5.4).
8. Items marked [unverified] in this file: Pluto/Ceres tier-2 values beyond the SBDB elements, the Uranus/Neptune/Jupiter
   ring radii, giant wind speeds, Titan haze single-scattering albedos, Triton/Phobos/Deimos/Charon albedos, King-factor
   details of the Rayleigh numbers, planet-only GM of the four giants to 1e-7, the IAU report URL.
