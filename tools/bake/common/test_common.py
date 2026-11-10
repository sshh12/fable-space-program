"""Cross-language checks: Python bake helpers vs. the TypeScript contracts (golden files from `npm run golden`).

Run from the repository root:   python -I tools/bake/common/test_common.py
Also writes tools/bake/golden/py_sample.hgt, which the TypeScript test suite decodes.
"""
from __future__ import annotations

import json
import sys
import unittest
import zlib
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))  # tools/bake

import numpy as np  # noqa: E402

from common import cube, frt1, layout  # noqa: E402

GOLDEN = HERE.parent / "golden"


def golden_height(i: np.ndarray, j: np.ndarray) -> np.ndarray:
    return np.floor((1000.0 * np.sin(i * 0.05) * np.cos(j * 0.07) + 3.0 * i - 2.0 * j) / 0.125 + 0.5) * 0.125


class CubeMapping(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        with open(GOLDEN / "cube_vectors.json", "r", encoding="utf-8") as f:
            cls.golden = json.load(f)

    def test_directions(self) -> None:
        for e in self.golden["dirs"]:
            d = np.array(e["dir"])
            face, s, t = cube.dir_to_face_st(d)
            self.assertEqual(int(face), e["face"], e["name"])
            self.assertAlmostEqual(float(s), e["s"], places=12)
            self.assertAlmostEqual(float(t), e["t"], places=12)
            np.testing.assert_allclose(cube.face_st_to_dir(e["face"], e["s"], e["t"]), d, atol=1e-14)
            np.testing.assert_allclose(cube.lat_lon_to_dir(np.radians(e["latDeg"]), np.radians(e["lonDeg"])), d, atol=1e-12)
            key = e.get("tile12") or e.get("tile")
            level = key["level"]
            f, x, y, u, v = cube.dir_to_tile(d, level)
            self.assertEqual((f, x, y), (key["face"], key["x"], key["y"]), e["name"])
            self.assertAlmostEqual(u, e["u"], places=6)
            self.assertAlmostEqual(v, e["v"], places=6)

    def test_tiles(self) -> None:
        for e in self.golden["tiles"]:
            k = e["key"]
            for smp in e["samples"]:
                d = cube.tile_uv_to_dir(k["face"], k["level"], k["x"], k["y"], smp["u"], smp["v"])
                np.testing.assert_allclose(d, smp["dir"], atol=1e-14)

    def test_grids(self) -> None:
        g = cube.height_tile_dirs(2, 5, 7, 9)
        self.assertEqual(g.shape, (259, 259, 3))
        # sample (i=1, j=1) is the tile's (u=0, v=0) corner; (257, 257) the (1, 1) corner
        np.testing.assert_allclose(g[1, 1], cube.tile_uv_to_dir(2, 5, 7, 9, 0.0, 0.0), atol=1e-15)
        np.testing.assert_allclose(g[257, 257], cube.tile_uv_to_dir(2, 5, 7, 9, 1.0, 1.0), atol=1e-15)
        # column index follows u, row index follows v
        np.testing.assert_allclose(g[1, 257], cube.tile_uv_to_dir(2, 5, 7, 9, 1.0, 0.0), atol=1e-15)
        # shared edge with the +x neighbour is bit-identical
        g2 = cube.height_tile_dirs(2, 5, 8, 9)
        self.assertTrue(np.array_equal(g[:, 257], g2[:, 1]))
        img = cube.image_tile_dirs(0, 3, 1, 2)
        np.testing.assert_allclose(img[0, 0], cube.tile_uv_to_dir(0, 3, 1, 2, 0.5 / 256, 0.5 / 256), atol=1e-15)

    def test_lat_lon(self) -> None:
        lat, lon = cube.dir_to_lat_lon(cube.lat_lon_to_dir(np.radians(-33.0), np.radians(151.0)))
        self.assertAlmostEqual(float(np.degrees(lat)), -33.0, places=10)
        self.assertAlmostEqual(float(np.degrees(lon)), 151.0, places=10)
        # north is +v on equatorial faces
        a = cube.dir_to_lat_lon(cube.face_st_to_dir(3, 0.0, 0.0))[0]
        b = cube.dir_to_lat_lon(cube.face_st_to_dir(3, 0.0, 0.1))[0]
        self.assertGreater(float(b), float(a))

    def test_disc_coverage(self) -> None:
        lat, lon = np.radians(19.1), np.radians(-155.5)
        tiles = cube.tiles_covering_disc(lat, lon, 100_000.0, 6_371_000.0, 10)
        f, x, y, _, _ = cube.dir_to_tile(cube.lat_lon_to_dir(lat, lon), 10)
        self.assertIn((f, x, y), tiles)
        self.assertGreater(len(tiles), 100)
        rects = cube.rects_from_tiles(tiles)
        self.assertTrue(all(r["x0"] <= r["x1"] and r["y0"] <= r["y1"] for r in rects))


class Frt1(unittest.TestCase):
    def test_decode_ts_sample(self) -> None:
        t = frt1.from_file_bytes((GOLDEN / "ts_sample.hgt").read_bytes())
        self.assertEqual((t["kind"], t["width"], t["height"], t["border"]), ("height", 259, 259, 1))
        self.assertEqual(t["scale"], 0.125)
        j, i = np.meshgrid(np.arange(259.0), np.arange(259.0), indexing="ij")
        expect = golden_height(i, j).astype(np.float32)
        self.assertTrue(np.array_equal(t["heights"], expect))
        self.assertEqual(t["hMin"], float(expect.min()))
        self.assertEqual(t["hMax"], float(expect.max()))

    def test_encode_matches_ts_bytes(self) -> None:
        j, i = np.meshgrid(np.arange(259.0), np.arange(259.0), indexing="ij")
        raw = frt1.encode_height(golden_height(i, j), 0.125)
        ts_raw = zlib.decompress((GOLDEN / "ts_sample.hgt").read_bytes())
        self.assertEqual(raw, ts_raw)
        (GOLDEN / "py_sample.hgt").write_bytes(frt1.to_file_bytes(raw))

    def test_scale_and_u8(self) -> None:
        self.assertEqual(frt1.choose_height_scale(-11000, 8850, 0.5), 0.5)
        self.assertEqual(frt1.choose_height_scale(-5000, 4200, 0.0625), 0.25)
        h = np.zeros((2, 2))
        h[1, 1] = 9000
        t = frt1.decode(frt1.encode_height(h, 0.0625, border=0))
        self.assertEqual(t["scale"], 0.25)
        self.assertEqual(float(t["heights"][1, 1]), 9000.0)
        a = (np.arange(256 * 256, dtype=np.uint32) * 31 % 256).astype(np.uint8).reshape(256, 256)
        t = frt1.from_file_bytes(frt1.to_file_bytes(frt1.encode_u8(a)))
        self.assertEqual(t["channels"], 1)
        self.assertTrue(np.array_equal(t["data"][:, :, 0], a))
        with self.assertRaises(ValueError):
            frt1.encode_height(np.zeros((2, 2)), 0.3)


class Layout(unittest.TestCase):
    def test_manifest_validation(self) -> None:
        m = {
            "formatVersion": 1, "tileset": "unit-test", "radius": 1000.0, "mapping": "gnomonic-cube",
            "layers": {"height": {"encoding": "frt1-height", "ext": "hgt", "globalMaxLevel": 2, "heightScales": [0.5] * 5,
                                  "coverage": {"3": [{"face": 0, "x0": 2, "y0": 2, "x1": 3, "y1": 3}],
                                               "4": [{"face": 0, "x0": 4, "y0": 4, "x1": 7, "y1": 7}]}}},
            "globals": {}, "residentHeightLevel": 2, "attribution": [],
        }
        layout.validate_manifest(m)
        self.assertTrue(layout.layer_has_tile(m["layers"]["height"], 5, 2, 3, 3))
        self.assertTrue(layout.layer_has_tile(m["layers"]["height"], 0, 4, 5, 6))
        self.assertFalse(layout.layer_has_tile(m["layers"]["height"], 1, 4, 5, 6))
        m["layers"]["height"]["coverage"]["4"][0]["x1"] = 9  # parent (4, y) at level 3 is not covered
        with self.assertRaises(ValueError):
            layout.validate_manifest(m)
        self.assertEqual(str(layout.tile_file("earth", "height", 3, 7, 12, 99, "hgt")).replace("\\", "/").split("data/tiles/")[1],
                         "earth/height/3/7/12/99.hgt")


if __name__ == "__main__":
    unittest.main(verbosity=1)
