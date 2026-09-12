"""
Unit tests for physical street extraction, length-weighted attribute aggregation,
map line geometry generation, and missing physical road QA warnings.
"""
import json
import os
import sqlite3
import tempfile
from typing import Any
import unittest

import geopandas as gpd

from scripts.osm_parser import WayAddressHandler
from scripts.spatial import match_and_aggregate_physical_highway, process_hierarchy
from scripts.warnings_detector import extract_warnings_from_db


class DummyNodeRef:
    def __init__(self, lat: float, lon: float, valid: bool = True):
        class Location:
            def __init__(self, lat_v: float, lon_v: float, valid_v: bool):
                self.lat = lat_v
                self.lon = lon_v
                self._valid = valid_v
            def valid(self) -> bool:
                return self._valid
        self.location = Location(lat, lon, valid)


class DummyTag:
    def __init__(self, k: str, v: str):
        self.k = k
        self.v = v


class DummyTags:
    def __init__(self, tags_dict: dict[str, str]):
        self._dict = tags_dict
        self._list = [DummyTag(k, v) for k, v in tags_dict.items()]

    def __iter__(self):
        return iter(self._list)

    def __contains__(self, key: str):
        return key in self._dict

    def __getitem__(self, key: str):
        return self._dict[key]

    def get(self, key: str, default: Any = None):
        return self._dict.get(key, default)


class DummyWay:
    def __init__(self, way_id: int, tags: dict[str, str], nodes: list[DummyNodeRef]):
        self.id = way_id
        self.tags = DummyTags(tags)
        self.nodes = nodes


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
             # Segment 3: The Walk, 100m long, service, asphalt, lit=no, maxspeed=30 mph, Q1234
            ("w101", "The Walk", "service", "asphalt", "yes", "30 mph", "2", "both", "Q1234", 100.0,
             "LINESTRING (-1.570000 54.770000, -1.571000 54.771000)", 394000.0, 394100.0, 806000.0, 806100.0),
            # Segment 4: The Walk, 100m long, secondary, paved, lit=yes, Q1234
            ("w102", "The Walk", "footway", "paved", "no", "30 mph", None, None, "Q1234", 100.0,
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
        # Group 3: 'Market Square' in DH -> street_type='place' (addr:place)
        addresses = [
            (54.7705, -1.5705, 394050.0, 806050.0, "DH1 1AA", "DH", "Durham", "City", "suburb", "suburb:City", "High Street", "street", "street:High Street", "{}", "{}", "n101", "", 1, 0),
            (54.7800, -1.5800, 395000.0, 807000.0, "DH1 2BB", "DH", "Durham", "City", "suburb", "suburb:City", "Missing Road", "street", "street:Missing Road", "{}", "{}", "n102", "", 1, 0),
            (54.7705, -1.5705, 394050.0, 806050.0, "DH1 2CC", "DH", "Durham", "City", "suburb", "suburb:City", "The Walk", "street", "street:The Walk", "{}", "{}", "n103", "", 1, 0),
            (54.7850, -1.5850, 395500.0, 807500.0, "DH1 3DD", "DH", "Durham", "City", "suburb", "suburb:City", "Market Square", "place", "place:Market Square", "{}", "{}", "n104", "", 1, 0),
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

    def test_match_and_aggregate_physical_highway_mixed_path(self) -> None:
        """Tests attribute aggregation when physical highway is a mix of roads and paths."""
        address_bounds = (394000.0, 806000.0, 394100.0, 806100.0)
        child_id = "dh1_durham_city_the-walk"

        street_info, line_features = match_and_aggregate_physical_highway(
            self.conn, "The Walk", address_bounds, child_id
        )

        self.assertTrue(street_info.get("has_physical_road"))
        self.assertEqual(street_info.get("total_length_m"), 200.0)
        self.assertEqual(street_info.get("wikidata"), "Q1234")

        print(street_info)

        # Check aggregated tag percentages (100m + 100m = 200m total -> 50% each for residential/secondary, asphalt/paved, yes/no)
        self.assertEqual(street_info["highway"].get("service"), 50.0)
        self.assertEqual(street_info["highway"].get("footway"), 50.0)
        self.assertEqual(street_info["surface"].get("asphalt"), 50.0)
        self.assertEqual(street_info["surface"].get("paved"), 50.0)
        self.assertEqual(street_info["lit"].get("yes"), 50.0)
        self.assertEqual(street_info["lit"].get("no"), 50.0)
        self.assertEqual(street_info["maxspeed"].get("30 mph"), 100.0)
        self.assertEqual(street_info["lanes"].get("2"), 100.0)
        self.assertEqual(street_info["sidewalk"].get("both"), 100.0)

        # Check line features output for Tippecanoe vector tiles
        self.assertEqual(len(line_features), 2)
        feat0 = line_features[0]
        self.assertEqual(feat0["properties"]["child_id"], child_id)
        self.assertEqual(feat0["properties"]["name"], "The Walk")
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
        """Tests that extract_warnings_from_db extracts missing physical road QA warnings and ignores addr:place."""
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

    def test_process_hierarchy_skips_street_info_for_place(self) -> None:
        """Tests that process_hierarchy does not generate street_info for addr:place groups."""
        import pandas as pd
        from shapely.geometry import Point

        df_raw = pd.read_sql_query("SELECT * FROM addresses WHERE street = 'Market Square'", self.conn)
        geometry = [Point(xy) for xy in zip(df_raw['lon'], df_raw['lat'])]
        df = gpd.GeoDataFrame(df_raw, geometry=geometry, crs="EPSG:4326").to_crs("EPSG:27700")

        features = process_hierarchy(
            df,
            group_col='street_area',
            filename='dh1_durham_city',
            next_col='points',
            db_conn=self.conn
        )

        self.assertEqual(len(features), 1)
        item = features[0]
        # Tuple format for street_area without street_info:
        # [display_name, raw_name, level, child_id, total, addr_perc, bbox, sector_ids]
        # Length should be 8, instead of 9 (which includes street_info)
        self.assertEqual(len(item), 8)

    def test_name_left_and_right_highway_parsing_and_matching(self) -> None:
        """Tests that ways with name:left or name:right are extracted and matched correctly."""
        handler = WayAddressHandler(conn=self.conn)

        # Way 301 has name:left = "North Street" and name:right = "South Street"
        nodes_301 = [
            DummyNodeRef(54.7700, -1.5700),
            DummyNodeRef(54.7710, -1.5710)
        ]
        way_301 = DummyWay(301, {
            "highway": "residential",
            "name:left": "North Street",
            "name:right": "South Street",
            "surface": "asphalt",
            "lit": "yes"
        }, nodes_301)

        handler.way(way_301)
        handler.flush()

        # Verify physical_highways table contains records for both "North Street" and "South Street"
        cursor = self.conn.cursor()
        cursor.execute("SELECT osm_id, name, highway_type, surface, lit FROM physical_highways WHERE osm_id = 'w301'")
        rows = cursor.fetchall()

        self.assertEqual(len(rows), 2)
        names = {r[1] for r in rows}
        self.assertEqual(names, {"North Street", "South Street"})

        cursor.execute("SELECT min_x, min_y, max_x, max_y FROM physical_highways WHERE osm_id = 'w301'")
        r_bbox = cursor.fetchone()
        bounds_301 = (r_bbox[0], r_bbox[1], r_bbox[2], r_bbox[3])

        # Match against "North Street" and "South Street" address elements
        child_id_n = "dh1_durham_city_north-street"
        s_info_n, l_feats_n = match_and_aggregate_physical_highway(
            self.conn, "North Street", bounds_301, child_id_n
        )
        self.assertTrue(s_info_n.get("has_physical_road"))
        self.assertEqual(len(l_feats_n), 1)

        child_id_s = "dh1_durham_city_south-street"
        s_info_s, l_feats_s = match_and_aggregate_physical_highway(
            self.conn, "South Street", bounds_301, child_id_s
        )
        self.assertTrue(s_info_s.get("has_physical_road"))
        self.assertEqual(len(l_feats_s), 1)


if __name__ == "__main__":
    unittest.main()
