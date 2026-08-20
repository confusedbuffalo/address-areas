"""
Unit tests for get_nearby_buffer_points spatial query logic in scripts/spatial.py.
"""

import sqlite3
import unittest
import pandas as pd
from scripts.spatial import get_nearby_buffer_points


class TestNearbyBufferPoints(unittest.TestCase):
    """Tests for spatial buffer query calculation with localized grid bounding boxes."""

    def setUp(self) -> None:
        """Sets up in-memory SQLite database with test address records."""
        self.conn = sqlite3.connect(":memory:")
        self.conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY,
                x_proj REAL,
                y_proj REAL,
                postcode_area TEXT
            )
        """)

        # Insert points in Kent (x ~ 570000, y ~ 168000)
        kent_records = [
            (1, 570000.0, 168000.0, "ME"),
            (2, 570500.0, 168500.0, "ME"),
            (3, 571000.0, 169000.0, "ME"),
            (4, 571200.0, 169200.0, "CT"),  # Nearby point in different postcode area
        ]

        # Insert points in Midlands (x ~ 400000, y ~ 280000) - in between
        midlands_records = [
            (i, 400000.0 + (i * 100), 280000.0 + (i * 100), "B")
            for i in range(10, 50)
        ]

        # Insert outlier point in Scotland (x ~ 300000, y ~ 700000) tagged as ME
        scotland_records = [
            (100, 300000.0, 700000.0, "ME"),
            (101, 300200.0, 700200.0, "AB"),  # Nearby point in Scotland
        ]

        all_records = kent_records + midlands_records + scotland_records
        self.conn.executemany(
            "INSERT INTO addresses (id, x_proj, y_proj, postcode_area) VALUES (?, ?, ?, ?)",
            all_records
        )
        self.conn.commit()

    def tearDown(self) -> None:
        """Closes the SQLite connection."""
        self.conn.close()

    def test_get_nearby_buffer_points_empty_dataframe(self) -> None:
        """Tests that empty target DataFrame returns empty result without error."""
        df_empty = pd.DataFrame(columns=["id", "x_proj", "y_proj"])
        res = get_nearby_buffer_points(df_empty, self.conn)
        self.assertTrue(res.empty)

    def test_get_nearby_buffer_points_localized_cluster(self) -> None:
        """Tests spatial buffer query for a single localized area (postcode area B)."""
        df_target = pd.read_sql_query("SELECT * FROM addresses WHERE postcode_area = 'B'", self.conn)
        res = get_nearby_buffer_points(df_target, self.conn, buffer_dist=1000.0, grid_size=10000.0)

        # Should fetch B records but not Kent or Scotland records
        self.assertFalse(res.empty)
        fetched_ids = set(res["id"])
        self.assertIn(10, fetched_ids)
        self.assertNotIn(1, fetched_ids)
        self.assertNotIn(100, fetched_ids)

    def test_get_nearby_buffer_points_with_spatial_outlier(self) -> None:
        """Tests spatial buffer query for an area with a distant outlier point (postcode area ME)."""
        df_target = pd.read_sql_query("SELECT * FROM addresses WHERE postcode_area = 'ME'", self.conn)

        # Target ME has 4 points: IDs 1, 2, 3 (Kent) and ID 100 (Scotland)
        self.assertEqual(len(df_target), 4)

        res = get_nearby_buffer_points(df_target, self.conn, buffer_dist=1000.0, grid_size=10000.0)
        fetched_ids = set(res["id"])

        # Kent target points (1, 2, 3) and nearby Kent CT point (4) must be fetched
        self.assertIn(1, fetched_ids)
        self.assertIn(2, fetched_ids)
        self.assertIn(3, fetched_ids)
        self.assertIn(4, fetched_ids)

        # Scotland target ME point (100) and nearby Scotland AB point (101) must be fetched
        self.assertIn(100, fetched_ids)
        self.assertIn(101, fetched_ids)

        # Midlands points (10..49) must NOT be fetched because of grid localization!
        for m_id in range(10, 50):
            self.assertNotIn(m_id, fetched_ids)


if __name__ == "__main__":
    unittest.main()
