"""
Unit tests for duplicate address detection rules and SQLite database extraction.
"""
import json
import os
import sqlite3
import tempfile
from scripts.duplicates_detector import (
    extract_duplicates_from_db,
    format_duplicate_title,
    is_duplicate_pair
)


def test_format_duplicate_title():
    assert format_duplicate_title("1", "", "High Street", "", "", "") == "1, High Street"
    assert format_duplicate_title("1", "Rose Cottage", "High Street", "", "", "") == "Rose Cottage, 1, High Street"
    assert format_duplicate_title("", "Rose Cottage", "High Street", "", "", "") == "Rose Cottage, High Street"
    assert format_duplicate_title("1", "", "High Street", "1", "", "") == "Unit 1, 1, High Street"
    assert format_duplicate_title("1", "", "High Street", "", "Flat 2", "") == "Flat 2, 1, High Street"


def test_is_duplicate_pair():
    # Matching numbers, no names
    item1 = {'hn': '1', 'hname': ''}
    item2 = {'hn': '1', 'hname': ''}
    assert is_duplicate_pair(item1, item2) is True

    # Matching numbers, name on item 1 only
    item3 = {'hn': '1', 'hname': 'rose cottage'}
    assert is_duplicate_pair(item1, item3) is True

    # Different numbers, matching names
    item4 = {'hn': '2', 'hname': 'rose cottage'}
    assert is_duplicate_pair(item3, item4) is False

    # Matching numbers, different names
    item5 = {'hn': '1', 'hname': 'lily cottage'}
    assert is_duplicate_pair(item3, item5) is False

    # No shared tags (item 1 has only hn, item 6 has only hname)
    item6 = {'hn': '', 'hname': 'rose cottage'}
    assert is_duplicate_pair(item1, item6) is False


def test_extract_duplicates_from_db_standard_postcode():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "test_dup.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                postcode TEXT,
                postcode_area TEXT,
                city TEXT,
                suburb TEXT,
                suburb_type TEXT,
                street TEXT,
                street_type TEXT,
                popup_tags TEXT,
                osm_id TEXT,
                osm_name TEXT,
                has_feature_tag INTEGER
            )
        """)

        # Add records
        records = [
            # Group 1: DH1 1AA, 1 High Street (w101, w102) -> duplicate pair
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "street",
             json.dumps({"addr:housenumber": "1", "addr:street": "High Street", "addr:postcode": "DH1 1AA"}),
             "w101", "", 0),
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "street",
             json.dumps({"addr:housenumber": "1", "addr:street": "High Street", "addr:postcode": "DH1 1AA"}),
             "w102", "", 0),

            # Excluded: w103 has shop tag (has_feature_tag = 1)
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "street",
             json.dumps({"addr:housenumber": "1", "addr:street": "High Street", "addr:postcode": "DH1 1AA", "shop": "bakery"}),
             "w103", "", 1),

            # Excluded: w106 has disused:shop tag
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "street",
             json.dumps({"addr:housenumber": "1", "addr:street": "High Street", "addr:postcode": "DH1 1AA", "disused:shop": "bakery"}),
             "w106", "", 1),

            # Excluded: w104 has unit=1 (doesn't match unit=none on w101/w102)
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "street",
             json.dumps({"addr:housenumber": "1", "addr:street": "High Street", "addr:postcode": "DH1 1AA", "addr:unit": "1"}),
             "w104", "", 0),

            # Excluded: w105 uses addr:place instead of addr:street
            ("DH", "DH1 1AA", "Durham", "City", "suburb", "High Street", "place",
             json.dumps({"addr:housenumber": "1", "addr:place": "High Street", "addr:postcode": "DH1 1AA"}),
             "w105", "", 0)
        ]

        conn.executemany("""
            INSERT INTO addresses (
                postcode_area, postcode, city, suburb, suburb_type,
                street, street_type, popup_tags, osm_id, osm_name, has_feature_tag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()
        conn.close()

        results = extract_duplicates_from_db(db_path)
        assert "DH" in results
        assert len(results["DH"]) == 1
        group = results["DH"][0]
        # Schema tuple: [title, [osm_ids]]
        assert group[0] == "1, High Street"
        assert group[1] == ["w101", "w102"]


def test_extract_duplicates_from_db_no_postcode():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "test_dup_no_pc.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                postcode TEXT,
                postcode_area TEXT,
                city TEXT,
                suburb TEXT,
                suburb_type TEXT,
                street TEXT,
                street_type TEXT,
                popup_tags TEXT,
                osm_id TEXT,
                osm_name TEXT,
                has_feature_tag INTEGER
            )
        """)

        records = [
            # Potential group in No postcode: City Durham, Suburb Gilesgate (addr:suburb), 10 Church Lane (n201, n202)
            ("No postcode", "No postcode", "Durham", "Gilesgate", "suburb", "Church Lane", "street",
             json.dumps({"addr:housenumber": "10", "addr:street": "Church Lane", "addr:city": "Durham", "addr:suburb": "Gilesgate"}),
             "n201", "", 0),
            ("No postcode", "No postcode", "Durham", "Gilesgate", "suburb", "Church Lane", "street",
             json.dumps({"addr:housenumber": "10", "addr:street": "Church Lane", "addr:city": "Durham", "addr:suburb": "Gilesgate"}),
             "n202", "", 0),
        ]

        conn.executemany("""
            INSERT INTO addresses (
                postcode_area, postcode, city, suburb, suburb_type,
                street, street_type, popup_tags, osm_id, osm_name, has_feature_tag
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()
        conn.close()

        results = extract_duplicates_from_db(db_path)
        assert "No postcode" not in results
