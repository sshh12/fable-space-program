"""Mean linear-RGB colour of a global equirectangular 8-bit RGB map (sRGB-encoded), weighted by the area of each
row (cos latitude), no-data pixels (all channels 0) left out. Prints JSON: {"linearRgb": [r, g, b], "pixels": n}.
Used by tools/bodies/fetch-sources.mjs for the mean colour of the bodies with a global colour map; run with
`python -I` (the map is untrusted data, only decoded).

    python -I tools/bodies/mapcolour.py <map.tif>
"""
import json
import sys

import numpy as np
from PIL import Image


def srgb_to_linear(c: np.ndarray) -> np.ndarray:
    c = c / 255.0
    return np.where(c <= 0.04045, c / 12.92, ((c + 0.055) / 1.055) ** 2.4)


def main() -> None:
    Image.MAX_IMAGE_PIXELS = None
    im = Image.open(sys.argv[1])
    if im.mode != "RGB":
        raise SystemExit(f"{sys.argv[1]}: mode {im.mode}, expected 8-bit RGB")
    w, h = im.size
    total = np.zeros(3)
    weight = 0.0
    pixels = 0
    band = 256
    for y0 in range(0, h, band):
        y1 = min(h, y0 + band)
        a = np.asarray(im.crop((0, y0, w, y1)), dtype=np.float64)
        lat = (90.0 - (np.arange(y0, y1) + 0.5) * 180.0 / h) * np.pi / 180.0
        cw = np.cos(lat)[:, None]
        valid = a.max(axis=2) > 0
        lin = srgb_to_linear(a)
        wv = cw * valid
        total += (lin * wv[:, :, None]).sum(axis=(0, 1))
        weight += wv.sum()
        pixels += int(valid.sum())
    mean = total / weight
    sys.stdout.write(json.dumps({"linearRgb": [float(x) for x in mean], "pixels": pixels, "width": w, "height": h}) + "\n")


if __name__ == "__main__":
    main()
