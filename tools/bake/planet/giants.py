"""Global maps of the bodies without a surface (Jupiter, Saturn, Uranus, Neptune) and Saturn's ring strip.

Output (data/staged/render/, registered at activation by bodies-activation):
  <id>/<name>.<png|webp>     the map
  <id>.maps.json             { body, maps: { name: map descriptor with its conventions and credit } }

Equirect maps: resampled (bilinear, in linear light, nodata taps left out) onto the tile sets' global-map
convention (TileManifest.globals): row 0 = north, column 0 = longitude -180, longitude increasing EAST in the
body-fixed frame, planetocentric latitude. A west-positive source is mirrored, a point-registered grid (pixel
centres on the map edges) is read as such, a planetographic latitude is converted with the body's radii.
Pixels the source does not cover (polar caps outside the observations, the ring shadow on Saturn) are filled
zonally: from the mean of their latitude's covered pixels, or, for a latitude with no coverage, from the
nearest covered latitudes (giants' cloud bands are zonal; the fill is stated in the descriptor).

Radial maps (Saturn's rings): column i covers radius innerKm + (i + 0.5) (outerKm - innerKm) / W from the
planet's centre. Alpha = normal opacity 1 - exp(-tau), tau the area mean of an occultation optical-depth
profile over the texel; RGB = the albedo of the configured ring regions (NSSDC ring fact sheet), sRGB.
"""
from __future__ import annotations

import io

import numpy as np
from PIL import Image

from common import layout
from moon.sampling import srgb_decode, srgb_encode
from planet import config, fetch, rt

Image.MAX_IMAGE_PIXELS = 400_000_000


def _read_fits(path) -> np.ndarray:
    """Primary array of a FITS file as (rows, cols, channels) float64 in storage order (row 0 first)."""
    raw = path.read_bytes()
    cards = {}
    off = 0
    done = False
    while not done:
        block = raw[off:off + 2880].decode("ascii", "replace")
        off += 2880
        for i in range(0, 2880, 80):
            card = block[i:i + 80]
            key = card[:8].strip()
            if key == "END":
                done = True
                break
            if card[8:10] == "= ":
                cards[key] = card[10:].split("/")[0].strip().strip("'").strip()
    bitpix = int(cards["BITPIX"])
    naxis = int(cards["NAXIS"])
    dims = [int(cards[f"NAXIS{k}"]) for k in range(1, naxis + 1)]
    dt = {8: ">u1", 16: ">i2", 32: ">i4", -32: ">f4", -64: ">f8"}[bitpix]
    n = int(np.prod(dims))
    a = np.frombuffer(raw, dtype=dt, count=n, offset=off).astype(np.float64)
    a = a * float(cards.get("BSCALE", 1.0)) + float(cards.get("BZERO", 0.0))
    a = a.reshape(dims[::-1])  # (NAXIS3, NAXIS2, NAXIS1)
    return np.moveaxis(a, 0, -1) if a.ndim == 3 else a[..., None]


def _load(path, src: dict) -> tuple[np.ndarray, np.ndarray]:
    """(values (H, W, C) in [0, 1] display units, valid (H, W))."""
    if src["format"] == "fits":
        a = _read_fits(path)
        valid = np.all(np.isfinite(a), axis=-1)
        a = np.nan_to_num(a) / 255.0
    else:
        im = Image.open(path)
        if im.mode == "P":
            im = im.convert("RGB")
        a = np.asarray(im)
        scale = 65535.0 if (a.dtype == np.uint16 or im.mode.startswith("I;16")) else 255.0
        a = a.astype(np.float64) / scale
        if a.ndim == 2:
            a = a[..., None]
        valid = np.ones(a.shape[:2], bool)
    a = a[..., :3]
    if src["nodata"] is not None:
        valid &= ~np.all(np.abs(a - float(src["nodata"]) / 255.0) < 1e-9, axis=-1)
    if src.get("registration", "cell") == "point" and a.shape[1] == 2 * (a.shape[0] - 1) + 1:
        # the first and last columns of a global point-registered grid are the same meridian, sampled at the
        # edge of the observation (Saturn's is dark in the south): it becomes the mean of its two neighbours
        a = a.copy()
        a[:, 0] = a[:, -1] = 0.5 * (a[:, 1] + a[:, -2])
        valid = valid.copy()
        valid[:, 0] = valid[:, -1] = valid[:, 1] & valid[:, -2]
    if "validLatDeg" in src:
        # rows outside the observation's clean latitude range (limb smear, polar night) count as uncovered
        H = a.shape[0]
        if src.get("registration", "cell") == "point":
            lat = 90.0 - np.arange(H) * 180.0 / (H - 1)
        else:
            lat = 90.0 - (np.arange(H) + 0.5) * 180.0 / H
        lo, hi = src["validLatDeg"]
        valid &= ((lat >= lo) & (lat <= hi))[:, None]
    return a, valid


def _resample(a: np.ndarray, valid: np.ndarray, src: dict, body: config.Body, w: int, h: int) -> tuple[np.ndarray, np.ndarray]:
    """Bilinear resample (linear light) onto the canonical grid; returns (linear RGB, weight 0..1)."""
    H, W = a.shape[:2]
    point = src.get("registration", "cell") == "point"
    if point and W == 2 * (H - 1) + 1:
        a, valid, W = a[:, :-1], valid[:, :-1], W - 1
    lin = srgb_decode(np.clip(a, 0, 1))
    lat_c = np.radians(90.0 - (np.arange(h) + 0.5) * 180.0 / h)
    lon_e = -180.0 + (np.arange(w) + 0.5) * 360.0 / w
    if src["latitude"] == "planetographic":
        ra, rb, rc = body.abc
        lat_q = np.degrees(np.arctan(np.tan(lat_c) * (((ra + rb) / 2.0) / rc) ** 2))
    else:
        lat_q = np.degrees(lat_c)
    lon_q = -lon_e if src["lonPositive"] == "west" else lon_e
    if point:
        sy = (90.0 - lat_q) / (180.0 / (H - 1))
        sx = ((lon_q - src["lonLeftEdgeDeg"]) % 360.0) / (360.0 / W)
    else:
        sy = (90.0 - lat_q) / (180.0 / H) - 0.5
        sx = ((lon_q - src["lonLeftEdgeDeg"]) % 360.0) / (360.0 / W) - 0.5
    sy = np.clip(sy, 0.0, H - 1.0)
    y0 = np.floor(sy).astype(int)
    fy = sy - y0
    y1 = np.minimum(y0 + 1, H - 1)
    x0 = np.floor(sx).astype(int)
    fx = sx - x0
    xa, xb = np.mod(x0, W), np.mod(x0 + 1, W)
    acc = np.zeros((h, w, lin.shape[2]))
    ws = np.zeros((h, w))
    vf = valid.astype(np.float64)
    for yy, wy in ((y0, 1 - fy), (y1, fy)):
        for xx, wx in ((xa, 1 - fx), (xb, fx)):
            wt = wy[:, None] * wx[None, :] * vf[yy][:, xx]
            acc += lin[yy][:, xx] * wt[..., None]
            ws += wt
    out = np.where(ws[..., None] > 1e-9, acc / np.maximum(ws, 1e-12)[..., None], 0.0)
    return out, np.clip(ws, 0, 1)


def _zonal_fill(lin: np.ndarray, wgt: np.ndarray) -> tuple[np.ndarray, float]:
    """Fill uncovered pixels from their latitude's covered mean (or the nearest covered latitudes)."""
    h = lin.shape[0]
    cover = wgt > 0.5
    rows_ok = cover.mean(axis=1) >= 0.25
    if not rows_ok.any():
        raise ValueError("map has no covered latitude")
    means = np.zeros((h, lin.shape[2]))
    for j in np.nonzero(rows_ok)[0]:
        means[j] = lin[j][cover[j]].mean(axis=0)
    ok_idx = np.nonzero(rows_ok)[0]
    for j in np.nonzero(~rows_ok)[0]:
        lo = ok_idx[ok_idx < j]
        hi = ok_idx[ok_idx > j]
        if len(lo) and len(hi):
            a, b = lo[-1], hi[0]
            t = (j - a) / (b - a)
            means[j] = means[a] * (1 - t) + means[b] * t
        else:
            means[j] = means[lo[-1]] if len(lo) else means[hi[0]]
    out = lin * wgt[..., None] + means[:, None, :] * (1.0 - wgt[..., None])
    return out, float(1.0 - cover.mean())


def _feather_seams(lin: np.ndarray, seams_deg: list, feather_deg: float) -> np.ndarray:
    """Remove the brightness step of a mosaic seam at the given east longitudes: per row and channel, half the
    step between the two columns either side is taken off each side, fading linearly over feather_deg."""
    h, w = lin.shape[:2]
    out = lin.copy()
    fw = max(1, int(round(feather_deg / 360.0 * w)))
    ramp = 1.0 - np.arange(fw) / fw
    for lon in seams_deg:
        c = int(round(((lon + 180.0) % 360.0) / 360.0 * w)) % w
        left = 0.5 * (lin[:, (c - 1) % w] + lin[:, (c - 2) % w])
        right = 0.5 * (lin[:, c % w] + lin[:, (c + 1) % w])
        step = right - left
        for i in range(fw):
            out[:, (c - 1 - i) % w] += 0.5 * step * ramp[i]
            out[:, (c + i) % w] -= 0.5 * step * ramp[i]
    return np.clip(out, 0.0, 1.0)


def _read_table(path, spec: dict) -> tuple[np.ndarray, np.ndarray]:
    rows = []
    for line in path.read_text(encoding="ascii", errors="replace").splitlines():
        parts = line.replace(",", " ").split()
        try:
            vals = [float(p) for p in parts]
        except ValueError:
            continue
        if len(vals) >= max(spec["radiusColumn"], spec["tauColumn"]):
            rows.append((vals[spec["radiusColumn"] - 1], vals[spec["tauColumn"] - 1]))
    t = np.array(sorted(rows))
    r, tau = t[:, 0], t[:, 1]
    if spec["opaqueValue"] is not None:
        tau = np.where(tau >= spec["opaqueValue"], 8.0, tau)
    return r, np.clip(tau, 0.0, 8.0)


def _ring_strip(g: dict, path, src: dict) -> tuple[np.ndarray, dict]:
    r, tau = _read_table(path, src["table"])
    w = g["width"]
    edges = np.linspace(g["innerKm"], g["outerKm"], w + 1)
    if r.min() > edges[0] + 1 or r.max() < edges[-1] - 1:
        raise ValueError(f"ring profile covers {r.min():.0f}-{r.max():.0f} km, strip needs {edges[0]}-{edges[-1]} km")
    idx = np.searchsorted(r, edges)
    tex_tau = np.array([tau[idx[i]:max(idx[i + 1], idx[i] + 1)].mean() for i in range(w)])
    centre = (edges[:-1] + edges[1:]) / 2
    col = np.zeros((w, 3))
    wsum = np.zeros(w)
    for reg in g["albedoRegions"]:
        lo, hi, alb, tint = reg["innerKm"], reg["outerKm"], reg["albedo"], np.asarray(reg["tint"], float)
        # smooth 300 km transitions between regions
        a = np.clip((centre - lo) / 300.0 + 0.5, 0, 1) * np.clip((hi - centre) / 300.0 + 0.5, 0, 1)
        col += a[:, None] * alb * tint / float(tint @ np.array([0.2126, 0.7152, 0.0722]))
        wsum += a
    col = col / np.maximum(wsum, 1e-9)[:, None]
    opacity = 1.0 - np.exp(-tex_tau)
    rgba = np.concatenate([srgb_encode(np.clip(col, 0, 1)), opacity[:, None]], axis=1)
    img = np.repeat(rgba[None, :, :], g["height"], axis=0)
    stats = {"tauMax": float(tex_tau.max()), "tauMean": float(tex_tau.mean())}
    return img, stats


def bake(body: config.Body, record: bool = False) -> None:
    maps = {}
    credits = config.load_credits()
    for g in body.raw["globals"]:
        src = body.source(g["source"])
        path = fetch.ensure(body, g["source"], record=record)
        extra: dict = {}
        if g["kind"] == "equirect":
            a, valid = _load(path, src)
            if (a.shape[1], a.shape[0]) != (src["width"], src["height"]):
                raise ValueError(f"{body.id}.{g['source']}: image is {a.shape[1]} x {a.shape[0]}, config says {src['width']} x {src['height']}")
            lin, wgt = _resample(a, valid, src, body, g["width"], g["height"])
            lin, filled = _zonal_fill(lin, wgt)
            if g.get("featherSeamLonDeg"):
                lin = _feather_seams(lin, g["featherSeamLonDeg"], g.get("featherDeg", 20.0))
            img = srgb_encode(np.clip(lin, 0, 1))
            extra = {"rowZero": "north", "columnZeroLonDeg": -180.0, "latitude": "planetocentric",
                     "longitude": "east-positive in the body-fixed frame of the rotation model",
                     "zonallyFilledFraction": round(filled, 4)}
        else:
            img, stats = _ring_strip(g, path, src)
            extra = {"innerKm": g["innerKm"], "outerKm": g["outerKm"], "columnZero": "innerKm",
                     "alpha": "normal opacity 1 - exp(-tau)", **stats}
        nch = len(g["channels"])
        u8 = (np.clip(img[..., :nch], 0, 1) * 255.0 + 0.5).astype(np.uint8)
        pil = Image.fromarray(u8 if nch > 1 else u8[..., 0], {1: "L", 3: "RGB", 4: "RGBA"}[nch])
        buf = io.BytesIO()
        if g["format"] == "png":
            pil.save(buf, "PNG", optimize=True)
        else:
            pil.save(buf, "WEBP", lossless=True)
        rel = f"{body.id}/{g['name']}.{g['format']}"
        layout.write_atomic(rt.STAGED_RENDER / rel, buf.getvalue())
        c = credits[src["credit"]]
        maps[g["name"]] = {"path": rel, "width": g["width"], "height": g["height"], "channels": g["channels"],
                           "format": g["format"], "kind": g["kind"], "note": g["note"], "credit": c["attribution"],
                           "licence": c["licence"], **extra}
        rt.log(f"{body.id}: staged {rel} ({len(buf.getvalue()) / 1e3:.0f} kB) {extra}")
    rt.write_json(rt.STAGED_RENDER / f"{body.id}.maps.json",
                  {"body": body.id, "name": body.raw["name"], "radii": {k: body.raw["radii"][k] for k in ("mean", "a", "b", "c")},
                   "bakeConfig": f"tools/bake/planet/bodies/{body.id}.json", "maps": maps})
    if not maps:
        raise RuntimeError(f"{body.id}: nothing staged")
