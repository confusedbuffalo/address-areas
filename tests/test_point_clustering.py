"""
Unit tests for prepare_points_for_tippecanoe and _write_points_geojson_file in scripts/spatial.py and scripts/workers.py.
"""

import json
import os
import tempfile
import unittest
from scripts.spatial import prepare_points_for_tippecanoe
from scripts.workers import _write_points_geojson_file


class TestPointClustering(unittest.TestCase):
    """Tests for point pre-clustering and GeoJSON file streaming."""

    def test_prepare_points_for_tippecanoe_empty(self) -> None:
        """Tests that empty points list returns empty list."""
        res = prepare_points_for_tippecanoe([])
        self.assertEqual(res, [])

    def test_prepare_points_for_tippecanoe_and_write_geojson(self) -> None:
        """Tests point pre-clustering tiers and GeoJSON output file writing."""
        all_points = [
            {
                "props": {
                    "name": "1 High St",
                    "postcode": "SW1A 1AA",
                    "level": "points",
                    "parent_id": "st_main",
                    "osm_id": "n1",
                    "fillColour": "#000000",
                    "labelColour": "#ffffff"
                },
                "x_proj": 530000.0,
                "y_proj": 180000.0,
                "lon": -0.12,
                "lat": 51.50
            },
            {
                "props": {
                    "name": "2 High St",
                    "postcode": "SW1A 1AA",
                    "level": "points",
                    "parent_id": "st_main",
                    "osm_id": "n2",
                    "fillColour": "#000000",
                    "labelColour": "#ffffff"
                },
                "x_proj": 530010.0,
                "y_proj": 180005.0,
                "lon": -0.119,
                "lat": 51.501
            }
        ]

        processed_rows = prepare_points_for_tippecanoe(all_points, parent_id_col="parent_id")
        self.assertTrue(len(processed_rows) > len(all_points))

        # Check raw points output tier
        raw_row = processed_rows[0]
        self.assertEqual(raw_row[0]["parent_id"], "st_main")
        self.assertEqual(raw_row[1], {"minzoom": 15, "maxzoom": 17})
        self.assertEqual(raw_row[2], -0.12)
        self.assertEqual(raw_row[3], 51.50)

        # Stream to temporary file and verify line-delimited GeoJSON structure
        with tempfile.NamedTemporaryFile(mode="w+", delete=False, suffix=".geojson") as tmp:
            tmp_path = tmp.name

        try:
            _write_points_geojson_file(processed_rows, tmp_path)
            self.assertTrue(os.path.exists(tmp_path))

            lines = []
            with open(tmp_path, "r", encoding="utf-8") as f:
                for line in f:
                    if line.strip():
                        feat = json.loads(line)
                        lines.append(feat)

            self.assertEqual(len(lines), len(processed_rows))
            first_feat = lines[0]
            self.assertEqual(first_feat["type"], "Feature")
            self.assertIn("geometry", first_feat)
            self.assertEqual(first_feat["geometry"]["type"], "Point")
            self.assertEqual(first_feat["geometry"]["coordinates"], [-0.12, 51.5])
            self.assertIn("properties", first_feat)
            self.assertEqual(first_feat["properties"]["name"], "1 High St")
        finally:
            if os.path.exists(tmp_path):
                os.remove(tmp_path)


if __name__ == "__main__":
    unittest.main()
