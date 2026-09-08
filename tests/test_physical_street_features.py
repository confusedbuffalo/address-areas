"""
Unit tests for physical street extraction, length-weighted attribute aggregation,
map line geometry generation, and missing physical road QA warnings.
"""
import json
import os
import sqlite3
import tempfile
import unittest

from scripts.spatial import match_and_aggregate_physical_highway
from scripts.warnings_detector import extract_warnings_from_db


class TestPhysicalStreetFeatures(unittest.TestCase):
    """Tests for physical street extraction and spatial attribute aggregation."""

    def setUp(self) -> None:
        """Sets up a temporary SQLite database with addresses and physical_highways tables."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "test_street_features.db")

        self.conn = sqlite3.connect(self.db_path)
        self.conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lat REAL, lon REAL, x_proj REAL, y_proj REAL,
                postcode TEXT, postcode_area TEXT, city TEXT,
                suburb TEXT, suburb_type TEXT, suburb_key TEXT,
                street TEXT, street_type TEXT, street_key TEXT,
                popup_tags TEXT, unusual_addr_tags TEXT,
                osm_id TEXT, osm_name TEXT, is_addressed INTEGER, has_feature_tag INTEGER
            )
        """)

        self.conn.execute("""
            CREATE TABLE physical_highways (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                osm_id TEXT,
                name TEXT,
                highway_type TEXT,
                surface TEXT,
                lit TEXT,
                maxspeed TEXT,
                lanes TEXT,
                sidewalk TEXT,
                etymology_wikidata TEXT,
                length_m REAL,
                geom_wkt TEXT,
                min_x REAL, max_x REAL, min_y REAL, max_y REAL
            )
        """)

        # Add physical highways for 'High Street'
        highways = [
            # Segment 1: High Street, 100m long, residential, asphalt, lit=yes, maxspeed=30 mph, Q1234
            ("w201", "High Street", "residential", "asphalt", "yes", "30 mph", "2", "both", "Q1234", 100.0,
             "LINESTRING (-1.570000 54.770000, -1.571000 54.771000)", 394000.0, 394100.0, 806000.0, 806100.0),
            # Segment 2: High Street, 100m long, secondary, paved, lit=no, maxspeed=30 mph, Q1234
            ("w202", "High Street", "secondary", "paved", "no", "30 mph", "2", "left", "Q1234", 100.0,
             "LINESTRING (-1.571000 54.771000, -1.572000 54.772000)", 394100.0, 394200.0, 806100.0, 806200.0),
        ]

        self.conn.executemany("""
            INSERT INTO physical_highways (
                osm_id, name, highway_type, surface, lit, maxspeed, lanes, sidewalk,
                etymology_wikidata, length_m, geom_wkt, min_x, max_x, min_y, max_y
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, highways)

        # Add address records
        # Group 1: 'High Street' in DH -> matches physical_highways
        # Group 2: 'Missing Road' in DH -> no physical_highways match
        addresses = [
            (54.7705, -1.5705, 394050.0, 806050.0, "DH1 1AA", "DH", "Durham", "City", "suburb", "suburb:City", "High Street", "street", "street:High Street", "{}", "{}", "n101", "", 1, 0),
            (54.7800, -1.5800, 395000.0, 807000.0, "DH1 2BB", "DH", "Durham", "City", "suburb", "suburb:City", "Missing Road", "street", "street:Missing Road", "{}", "{}", "n102", "", 1, 0),
        ]

        self.conn.executemany("""
            INSERT INTO addresses (
                lat, lon, x_proj, y_proj, postcode, postcode_area, city,
                suburb, suburb_type, suburb_key, street, street_type, street_key,
                popup_tags, unusual_addr_tags, osm_id, osm_name, is_addressed, has_feature_tag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, addresses)

        self.conn.commit()

    def tearDown(self) -> None:
        """Closes connection and cleans up temp files."""
        self.conn.close()
        import shutil
        shutil.rmtree(self.temp_dir)

    def test_match_and_aggregate_physical_highway_matched(self) -> None:
        """Tests spatial matching and attribute aggregation when physical highways match."""
        address_bounds = (394000.0, 806000.0, 394100.0, 806100.0)
        child_id = "dh1_durham_city_high-street"

        street_info, line_features = match_and_aggregate_physical_highway(
            self.conn, "High Street", address_bounds, child_id
        )

        self.assertTrue(street_info.get("has_physical_road"))
        self.assertEqual(street_info.get("total_length_m"), 200.0)
        self.assertEqual(street_info.get("wikidata"), "Q1234")

        # Check aggregated tag percentages (100m + 100m = 200m total -> 50% each for residential/secondary, asphalt/paved, yes/no)
        self.assertEqual(street_info["highway"].get("residential"), 50.0)
        self.assertEqual(street_info["highway"].get("secondary"), 50.0)
        self.assertEqual(street_info["surface"].get("asphalt"), 50.0)
        self.assertEqual(street_info["surface"].get("paved"), 50.0)
        self.assertEqual(street_info["lit"].get("yes"), 50.0)
        self.assertEqual(street_info["lit"].get("no"), 50.0)
        self.assertEqual(street_info["maxspeed"].get("30 mph"), 100.0)

        # Check line features output for Tippecanoe vector tiles
        self.assertEqual(len(line_features), 2)
        feat0 = line_features[0]
        self.assertEqual(feat0["properties"]["child_id"], child_id)
        self.assertEqual(feat0["properties"]["name"], "High Street")
        self.assertEqual(feat0["geometry"]["type"], "LineString")
        self.assertEqual(len(feat0["geometry"]["coordinates"]), 2)

    def test_match_and_aggregate_physical_highway_unmatched(self) -> None:
        """Tests spatial matching when no physical highway exists."""
        address_bounds = (395000.0, 807000.0, 395100.0, 807100.0)
        child_id = "dh1_durham_city_missing-road"

        street_info, line_features = match_and_aggregate_physical_highway(
            self.conn, "Missing Road", address_bounds, child_id
        )

        self.assertFalse(street_info.get("has_physical_road"))
        self.assertEqual(len(line_features), 0)

    def test_extract_warnings_missing_physical_road(self) -> None:
        """Tests that extract_warnings_from_db extracts missing physical road QA warnings."""
        warnings_data = extract_warnings_from_db(self.db_path)

        self.assertIn("DH", warnings_data)
        dh_warnings = warnings_data["DH"]
        self.assertIn("missing_physical_road", dh_warnings)

        missing_roads = dh_warnings["missing_physical_road"]
        self.assertEqual(len(missing_roads), 1)

        missing_item = missing_roads[0]
        self.assertEqual(missing_item[0], "Missing Road")
        self.assertIn("No physical highway", missing_item[1])
        self.assertEqual(missing_item[2], "n102")


if __name__ == "__main__":
    unittest.main()
