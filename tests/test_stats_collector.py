"""
Tests for stats_collector module.
"""

import os
import sqlite3
import tempfile
from datetime import datetime, timezone
from scripts.stats_collector import (
    calculate_stats_from_db,
    save_stats_snapshot,
    should_collect_stats,
)


def test_should_collect_stats():
    # Saturday is weekday 5 (2026-08-29 was a Saturday)
    saturday = datetime(2026, 8, 29, 12, 0, 0, tzinfo=timezone.utc)
    assert should_collect_stats(saturday) is True

    # Friday is weekday 4 (2026-08-28)
    friday = datetime(2026, 8, 28, 12, 0, 0, tzinfo=timezone.utc)
    assert should_collect_stats(friday) is False


def test_calculate_stats_from_db():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "test.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                postcode TEXT,
                postcode_area TEXT,
                city TEXT,
                suburb TEXT,
                suburb_key TEXT,
                street TEXT,
                street_key TEXT,
                is_addressed INTEGER
            )
        """)

        test_records = [
            ("DH1 1AA", "DH", "Durham", "City Centre", "suburb:Durham", "Market Place", "street:Market Place", 1),
            ("DH1 1AB", "DH", "Durham", "City Centre", "suburb:Durham", "Silver Street", "street:Silver Street", 0),
            ("SW1A 1AA", "SW", "London", "Westminster", "suburb:Westminster", "Whitehall", "street:Whitehall", 1),
            ("No postcode", "No postcode", "No city", "No suburb", "missing:No suburb", "No street", "missing:No street", 0)
        ]

        conn.executemany("""
            INSERT INTO addresses (postcode, postcode_area, city, suburb, suburb_key, street, street_key, is_addressed)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, test_records)
        conn.commit()

        stats = calculate_stats_from_db(db_path)
        conn.close()

        assert 'uk' in stats
        assert stats['uk']['total_objects'] == 4
        assert stats['uk']['postcode_count'] == 3
        assert stats['uk']['distinct_postcodes'] == 3
        assert stats['uk']['addressed_count'] == 2

        assert 'DH' in stats
        assert stats['DH']['total_objects'] == 2
        assert stats['DH']['postcode_count'] == 2
        assert stats['DH']['distinct_postcodes'] == 2
        assert stats['DH']['cities'] == 1
        assert stats['DH']['streets'] == 2
        assert stats['DH']['addressed_count'] == 1


def test_save_stats_snapshot():
    with tempfile.TemporaryDirectory() as temp_dir:
        stats_data = {
            "uk": {"total_objects": 10},
            "DH": {"total_objects": 5},
            "No postcode": {"total_objects": 2}
        }
        save_stats_snapshot(stats_data, "2026-08-29", output_dir=temp_dir)

        uk_file = os.path.join(temp_dir, "uk.json")
        dh_file = os.path.join(temp_dir, "DH.json")
        np_file = os.path.join(temp_dir, "no-postcode.json")

        assert os.path.exists(uk_file)
        assert os.path.exists(dh_file)
        assert os.path.exists(np_file)

        import json
        with open(uk_file, 'r') as f:
            data = json.load(f)
            assert "2026-08-29" in data
            assert data["2026-08-29"]["total_objects"] == 10

        # Test appending a second date
        stats_data2 = {"uk": {"total_objects": 15}}
        save_stats_snapshot(stats_data2, "2026-09-05", output_dir=temp_dir)

        with open(uk_file, 'r') as f:
            data = json.load(f)
            assert "2026-08-29" in data
            assert "2026-09-05" in data
            assert data["2026-08-29"]["total_objects"] == 10
            assert data["2026-09-05"]["total_objects"] == 15
