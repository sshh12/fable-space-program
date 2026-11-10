"""FRT1 raster tile container: the Python mirror of src/core/geo/tileCodec.ts (see that file for the spec).

Lead-owned shared contract code. A tile FILE is zlib.compress(FRT1 bytes).
"""
from __future__ import annotations

import struct
import zlib

import numpy as np

MAGIC = b"FRT1"
HEADER_BYTES = 32
KIND_HEIGHT = 1
KIND_U8 = 2
_HEADER = struct.Struct("<4sBBHHHffffI")
assert _HEADER.size == HEADER_BYTES


def choose_height_scale(h_min: float, h_max: float, preferred_scale: float) -> float:
    """Smallest power-of-two scale >= preferred_scale whose int16 range holds the tile."""
    scale = float(preferred_scale)
    while (h_max - h_min) / scale > 65000:
        scale *= 2.0
    return scale


def _js_round(a: np.ndarray) -> np.ndarray:
    """JavaScript Math.round (halves toward +infinity) so TS and Python quantise identically."""
    return np.floor(a + 0.5)


def encode_height(heights: np.ndarray, preferred_scale: float, border: int = 1) -> bytes:
    """Encode metres (2-D array [row j, column i], row index increasing with tile v) to FRT1 bytes (not compressed)."""
    h = np.asarray(heights, dtype=np.float64)
    if h.ndim != 2:
        raise ValueError("heights must be 2-D")
    if not np.all(np.isfinite(h)):
        raise ValueError("non-finite height")
    if np.log2(preferred_scale) % 1 != 0:
        raise ValueError("scale must be a power of two")
    lo, hi = float(h.min()), float(h.max())
    scale = choose_height_scale(lo, hi, preferred_scale)
    offset_counts = float(_js_round(np.float64((lo + hi) / 2.0 / scale)))
    q = _js_round(h / scale) - offset_counts
    if q.min() < -32768 or q.max() > 32767:
        raise ValueError("height out of int16 range")
    q = q.astype(np.int64)
    d = np.empty_like(q)
    d[:, 1:] = q[:, 1:] - q[:, :-1]
    d[1:, 0] = q[1:, 0] - q[:-1, 0]
    d[0, 0] = q[0, 0]
    payload = d.astype(np.uint16).astype("<u2").tobytes()  # modulo 2^16
    offset = offset_counts * scale
    header = _HEADER.pack(
        MAGIC, KIND_HEIGHT, 1, h.shape[1], h.shape[0], border, scale, offset,
        offset + scale * float(q.min()), offset + scale * float(q.max()), 0,
    )
    return header + payload


def encode_u8(data: np.ndarray) -> bytes:
    """Encode a uint8 raster of shape (rows, cols) or (rows, cols, channels) to FRT1 bytes (not compressed)."""
    a = np.asarray(data)
    if a.dtype != np.uint8:
        raise ValueError("data must be uint8")
    if a.ndim == 2:
        a = a[:, :, None]
    rows, cols, channels = a.shape
    header = _HEADER.pack(MAGIC, KIND_U8, channels, cols, rows, 0, 1.0, 0.0, 0.0, 0.0, 0)
    return header + np.ascontiguousarray(a).tobytes()


def decode(raw: bytes) -> dict:
    """Decode FRT1 bytes (already inflated). Returns a dict with kind 'height' or 'u8'."""
    if len(raw) < HEADER_BYTES:
        raise ValueError("FRT1: truncated header")
    magic, kind, channels, width, height, border, scale, offset, h_min, h_max, _ = _HEADER.unpack_from(raw, 0)
    if magic != MAGIC:
        raise ValueError("FRT1: bad magic")
    if kind == KIND_HEIGHT:
        d = np.frombuffer(raw, dtype="<i2", count=width * height, offset=HEADER_BYTES).astype(np.int64).reshape(height, width)
        col0 = np.cumsum(d[:, 0])
        rows = d.copy()
        rows[:, 0] = col0
        q = np.cumsum(rows, axis=1)
        q = ((q + 32768) % 65536) - 32768  # wrap to int16
        heights = (np.float32(offset) + np.float32(scale) * q.astype(np.float32)).astype(np.float32)
        return {"kind": "height", "width": width, "height": height, "border": border, "scale": scale,
                "offset": offset, "hMin": h_min, "hMax": h_max, "heights": heights}
    if kind == KIND_U8:
        a = np.frombuffer(raw, dtype=np.uint8, count=width * height * channels, offset=HEADER_BYTES)
        return {"kind": "u8", "width": width, "height": height, "channels": channels, "data": a.reshape(height, width, channels).copy()}
    raise ValueError(f"FRT1: unknown kind {kind}")


def to_file_bytes(frt1: bytes, level: int = 9) -> bytes:
    """Compress FRT1 bytes into the on-disk tile format (zlib stream)."""
    return zlib.compress(frt1, level)


def from_file_bytes(data: bytes) -> dict:
    return decode(zlib.decompress(data))
