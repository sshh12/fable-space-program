Status: open
From: bake-moon-sky
Owner path: docs/WORK_PACKAGES.json (bake-moon-sky acceptance), docs/research/moon-sky-data.md section 0 item 0
Blocking: no

## Problem
The acceptance criterion "the four LOLA benchmarks (Tranquility -1925 m, Tycho floor -1295 m, Apollo 17
-2624 m, Aitken -6948 m) within 60 m at global level 6" cannot be met for Tycho by any correct bake of the
256 ppd LOLA data. The benchmarks are single pixels of PDS `ldem_64.img` (64 ppd), and `ldem_64` is offset by
about 1-2 pixels of 118 m (120-240 m) in longitude relative to the 256 ppd LOLA products. On flat ground that
is invisible (Tranquility, Apollo 17, Aitken agree to 0.2-5.5 m), but the Tycho "floor" benchmark sits on the
steep central peak, where 150 m of longitude is 80-90 m of height.

## Evidence
- `python -I tools/bake/moon/verify.py` prints, for each benchmark, the level-6 value (point and mean over the
  ldem_64 pixel), the ldem_64 value and the PDS `ldem_256` pixel at the same place.
- PDS `ldem_256_90s_00s_180_360.img` and the USGS 118 m GeoTIFF (which the bake uses) agree pixel for pixel
  along the Tycho row at zero shift (max difference 12 m over 17 pixels; 41 m at a shift of one pixel).
- Comparing 17 x 17 `ldem_64` pixels around each benchmark with 4 x 4 block means of the 118 m grid gives the
  smallest RMS at a column shift of -1 to -2 pixels of 118 m at all four sites (Tycho: RMS 46.0 m at zero
  shift, 37.1 m at -1; centre difference -86.8 m at zero shift).
- Benchmark pixels located by reading `ldem_64.img`: Tranquility row 5717 col 1502 (0.664 N, 23.477 E),
  Tycho row 8531 col 22310 (43.305 S, 348.602 E), Apollo 17 row 4467 col 1969, Aitken row 9152 col 12224.

## Requested change
Re-base the Tycho benchmark on the 256 ppd product (the `ldem_256` pixel the verifier prints, -1357 m region
value at the same coordinates) or widen that one tolerance to 100 m with this note. Nothing in the bake or
the tile data needs to change; the other three benchmarks pass as specified.
