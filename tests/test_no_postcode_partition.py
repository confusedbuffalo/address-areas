"""
Unit tests for 'No postcode' sub-partition worker processing in scripts/workers.py.
"""

import os
import shutil
import sqlite3
import tempfile
import unittest
import pandas as pd
import geopandas as gpd
from pyproj import Transformer

from scripts.config import (
    assign_colours,
    get_city_letter_key,
    get_clean_id,
    get_street_letter_key,
)
from scripts.workers import process_no_postcode_sub_partition_worker

TRANSFORMER_TO_27700 = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)


class TestNoPostcodeSubPartitionWorker(unittest.TestCase):
    """Tests for sub-partitioning 'No postcode' addresses by city letter key."""

    def setUp(self) -> None:
        """Creates temporary directory and populates test SQLite database."""
        self.temp_dir = tempfile.mkdtemp()
        self.db_path = os.path.join(self.temp_dir, "addresses.db")

        conn = sqlite3.connect(self.db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                lat REAL, lon REAL, x_proj REAL, y_proj REAL,
                postcode TEXT, postcode_area TEXT, city TEXT,
                suburb TEXT, suburb_type TEXT, suburb_key TEXT,
                street TEXT, street_type TEXT, street_key TEXT,
                popup_tags TEXT, osm_id TEXT, osm_name TEXT, is_addressed INTEGER
            )
        """)

        test_addresses = [
            # City: 'Aberdeen' -> letter_key 'a'
            (57.1497, -2.0943, "No postcode", "No postcode", "Aberdeen", "Rosemount", "suburb", "suburb:Rosemount", "High St", "street", "street:High St", "{}", "n101", "High St 1", 1),
            # City: 'Alloa' -> letter_key 'a'
            (56.1165, -3.7932, "No postcode", "No postcode", "Alloa", "Town Centre", "suburb", "suburb:Town Centre", "Main St", "street", "street:Main St", "{}", "n102", "Main St 1", 1),
            # City: None / missing -> letter_key 'no-city'
            (55.9533, -3.1883, "No postcode", "No postcode", "No city", "Princes St", "suburb", "suburb:Princes St", "George St", "street", "street:George St", "{}", "n103", "George St 1", 0),
            # City: 'Dundee' in standard postcode area 'DD'
            (56.4620, -2.9707, "DD1 1AA", "DD", "Dundee", "City Centre", "suburb", "suburb:City Centre", "Nethergate", "street", "street:Nethergate", "{}", "n104", "Nethergate 1", 1),
        ]

        batch = []
        for lat, lon, pc, pa, city, sub, sub_t, sub_k, strt, strt_t, strt_k, ptags, osmid, osmname, is_addr in test_addresses:
            x_proj, y_proj = TRANSFORMER_TO_27700.transform(lon, lat)
            batch.append((lat, lon, float(x_proj), float(y_proj), pc, pa, city, sub, sub_t, sub_k, strt, strt_t, strt_k, ptags, osmid, osmname, is_addr))

        conn.executemany("""
            INSERT INTO addresses (
                lat, lon, x_proj, y_proj, postcode, postcode_area, city,
                suburb, suburb_type, suburb_key, street, street_type, street_key,
                popup_tags, osm_id, osm_name, is_addressed
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, batch)

        conn.execute("CREATE INDEX idx_postcode_area ON addresses(postcode_area);")
        conn.execute("CREATE INDEX idx_xy ON addresses(x_proj, y_proj);")
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        """Cleans up temporary files and directories."""
        shutil.rmtree(self.temp_dir)

    def test_process_no_postcode_sub_partition_worker_letter_a(self) -> None:
        """Tests processing the letter 'a' partition for No postcode."""
        arg = ('a', ['Aberdeen', 'Alloa'], 0, 1, [], 1, 2, self.db_path, self.temp_dir)
        city_items, search_items, points_path, hulls_path, letter_key, letter_suburbs_dict, sector_points_dict = process_no_postcode_sub_partition_worker(arg)

        self.assertEqual(letter_key, 'a')
        self.assertEqual(len(city_items), 2)  # Aberdeen and Alloa
        if isinstance(hulls_path, dict):
            self.assertTrue(any(os.path.exists(p) for p in hulls_path.values()))
        else:
            self.assertTrue(os.path.exists(hulls_path))

        # Check letter_suburbs_dict mapping
        city_ids = [item[3] for item in city_items]
        for c_id in city_ids:
            self.assertIn(c_id, letter_suburbs_dict)

    def test_get_street_letter_key(self) -> None:
        """Tests street name letter partition key extraction."""
        self.assertEqual(get_street_letter_key("George St"), "g")
        self.assertEqual(get_street_letter_key("1st Avenue"), "other")
        self.assertEqual(get_street_letter_key("No street"), "no-street")
        self.assertEqual(get_street_letter_key(""), "no-street")
        self.assertEqual(get_street_letter_key(None), "no-street")

    def test_process_no_postcode_sub_partition_worker_no_city(self) -> None:
        """Tests processing the 'no-city' partition for No postcode and verifies street-letter point files."""
        arg = ('no-city', [], 0, 1, [], 2, 2, self.db_path, self.temp_dir)
        city_items, search_items, points_path, hulls_path, letter_key, letter_suburbs_dict, sector_points_dict = process_no_postcode_sub_partition_worker(arg)

        self.assertEqual(letter_key, 'no-city')
        self.assertEqual(len(city_items), 1)  # No city item
        self.assertEqual(city_items[0][1], 'No city')

        # Check that sector points under no-city are keyed by street letter (e.g. no-postcode-xxx_no-city_g)
        pa_id = get_clean_id('root', 'No postcode')
        expected_sector_id = f"{pa_id}_no-city_g"
        self.assertIn(expected_sector_id, sector_points_dict)

    def test_no_postcode_top_level_postcode_area_hull_properties(self) -> None:
        """Tests that 'No postcode' city hulls can be combined into a valid top-level postcode_area hull feature."""
        import json
        import shapely.geometry

        arg_a = ('a', ['Aberdeen', 'Alloa'], 0, 1, [], 1, 2, self.db_path, self.temp_dir)
        city_items, _, _, hulls_path_a, _, _, _ = process_no_postcode_sub_partition_worker(arg_a)

        geoms = []
        city_file = hulls_path_a.get('city') if isinstance(hulls_path_a, dict) else hulls_path_a
        if city_file and os.path.exists(city_file):
            with open(city_file, 'r', encoding='utf-8') as f:
                for line in f:
                    if line.strip():
                        feat = json.loads(line)
                        if feat.get("properties", {}).get("level") == "city":
                            geoms.append(shapely.geometry.shape(feat["geometry"]))

        self.assertGreater(len(geoms), 0)
        union_geom = shapely.union_all(geoms)
        self.assertTrue(union_geom.is_valid)

        pm_props = {
            "name": "No postcode",
            "raw_name": "No postcode",
            "level": "postcode_area",
            "child_id": get_clean_id('root', 'No postcode'),
            "parent_id": "root"
        }
        assign_colours(pm_props, is_points_level=False)
        self.assertEqual(pm_props["fillColour"], "#fca5a5")
        self.assertEqual(pm_props["labelColour"], "#7f1d1d")


if __name__ == "__main__":
    unittest.main()
