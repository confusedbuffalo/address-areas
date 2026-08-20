"""
Unit tests for optimized parallel Tippecanoe PMTiles layer compilation.
"""

import json
import os
import tempfile
import unittest
from datetime import datetime, timezone
from concurrent.futures import ProcessPoolExecutor, as_completed
from unittest.mock import patch

from scripts.process import compile_single_layer_pmtiles


def mock_subprocess_run(cmd, check=True):
    if "-o" in cmd:
        out_idx = cmd.index("-o") + 1
        with open(cmd[out_idx], "wb") as f:
            f.write(b"mock_pmtiles_data")


class TestTippecanoeCompilation(unittest.TestCase):
    """Tests for parallel Tippecanoe layer compilation helper."""

    @patch("subprocess.run", side_effect=mock_subprocess_run)
    def test_compile_single_layer_pmtiles(self, mock_run) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            geojson_path = os.path.join(temp_dir, "test_layer.geojson")
            with open(geojson_path, "w", encoding="utf-8") as f:
                feat = {
                    "type": "Feature",
                    "properties": {"name": "Test Feature", "level": "postcode_area"},
                    "geometry": {
                        "type": "Polygon",
                        "coordinates": [[[-0.1, 51.5], [-0.05, 51.5], [-0.05, 51.55], [-0.1, 51.55], [-0.1, 51.5]]]
                    }
                }
                f.write(json.dumps(feat) + "\n")

            cfg = {"level": "postcode_area", "min_zoom": 0, "max_zoom": 11}
            timestamp_str = "20250101_120000"

            res_lvl = compile_single_layer_pmtiles(cfg, geojson_path, timestamp_str, temp_dir)
            self.assertEqual(res_lvl, "postcode_area")

            expected_pmtiles = os.path.join(temp_dir, "postcode_area_20250101_120000.pmtiles")
            self.assertTrue(os.path.exists(expected_pmtiles))
            self.assertGreater(os.path.getsize(expected_pmtiles), 0)

    @patch("subprocess.run", side_effect=mock_subprocess_run)
    def test_parallel_layer_compilation(self, mock_run) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layer_configs = [
                {"level": "postcode_area", "min_zoom": 0, "max_zoom": 11},
                {"level": "city", "min_zoom": 5, "max_zoom": 12},
                {"level": "suburb", "min_zoom": 5, "max_zoom": 13},
                {"level": "street", "min_zoom": 9, "max_zoom": 14},
                {"level": "points", "min_zoom": 0, "max_zoom": 15},
            ]

            geojson_paths = {}
            for cfg in layer_configs:
                lvl = cfg["level"]
                path = os.path.join(temp_dir, f"{lvl}.geojson")
                geojson_paths[lvl] = path
                with open(path, "w", encoding="utf-8") as f:
                    if lvl == "points":
                        feat = {
                            "type": "Feature",
                            "properties": {"name": "Point", "level": "points"},
                            "geometry": {"type": "Point", "coordinates": [-0.1, 51.5]},
                            "tippecanoe": {"minzoom": 15, "maxzoom": 15}
                        }
                    else:
                        feat = {
                            "type": "Feature",
                            "properties": {"name": f"{lvl} Feature", "level": lvl},
                            "geometry": {
                                "type": "Polygon",
                                "coordinates": [[[-0.1, 51.5], [-0.05, 51.5], [-0.05, 51.55], [-0.1, 51.55], [-0.1, 51.5]]]
                            }
                        }
                    f.write(json.dumps(feat) + "\n")

            timestamp_str = "20250101_120000"

            completed = []
            with ProcessPoolExecutor(max_workers=5) as executor:
                futures = [
                    executor.submit(compile_single_layer_pmtiles, cfg, geojson_paths[cfg["level"]], timestamp_str, temp_dir)
                    for cfg in layer_configs
                ]
                for future in as_completed(futures):
                    completed.append(future.result())

            self.assertEqual(set(completed), {"postcode_area", "city", "suburb", "street", "points"})
            for cfg in layer_configs:
                lvl = cfg["level"]
                expected_pmtiles = os.path.join(temp_dir, f"{lvl}_20250101_120000.pmtiles")
                self.assertTrue(os.path.exists(expected_pmtiles))
                self.assertGreater(os.path.getsize(expected_pmtiles), 0)


if __name__ == "__main__":
    unittest.main()
