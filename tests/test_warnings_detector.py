"""
Unit tests for warnings detector rules and database extraction.
"""
import json
import os
import sqlite3
import tempfile
from warnings_detector import (
    check_unusual_city,
    check_unusual_suburb,
    check_unusual_street,
    check_unusual_housenumber,
    check_unusual_housename,
    get_reasons_for_city_suburb_street,
    get_reasons_for_housenumber,
    get_reasons_for_housename,
    format_object_title,
    extract_warnings_from_db
)


def test_check_unusual_city():
    assert not check_unusual_city("Manchester")
    assert not check_unusual_city("Newcastle upon Tyne")
    assert not check_unusual_city("No city")
    assert not check_unusual_city("missing")
    assert not check_unusual_city("")

    # Warning triggers
    assert check_unusual_city("MANCHESTER") # All caps / double caps
    assert check_unusual_city("manchester") # Starts lowercase
    assert check_unusual_city("London123") # Numbers
    assert check_unusual_city("City, Name") # Punctuation comma
    assert check_unusual_city(" City") # Leading space
    assert check_unusual_city("City ") # Trailing space
    assert check_unusual_city("City  Name") # Double space


def test_reasons_extraction():
    reasons = get_reasons_for_city_suburb_street("MANCHESTER 123")
    assert "Capitalisation" in reasons
    assert "Numbers" in reasons

    hn_reasons = get_reasons_for_housenumber("Twenty One ")
    assert "No numbers" in hn_reasons
    assert "Whitespace" in hn_reasons

    hname_reasons = get_reasons_for_housename("Cottage 21")
    assert "Numbers" in hname_reasons


def test_check_unusual_suburb():
    assert not check_unusual_suburb("Headingley")
    assert not check_unusual_suburb("No suburb")

    assert check_unusual_suburb("HEADINGLEY")
    assert check_unusual_suburb("headingley")
    assert check_unusual_suburb("Area 51")


def test_check_unusual_street():
    assert not check_unusual_street("High Street")
    assert not check_unusual_street("St. John's Road")
    assert not check_unusual_street("No street")

    assert check_unusual_street("High St") # Abbreviation
    assert check_unusual_street("1st Avenue") # Numbers in street name
    assert check_unusual_street("HIGH STREET") # All caps
    assert check_unusual_street("high street") # Lowercase start
    assert check_unusual_street("High  Street") # Double space


def test_check_unusual_housenumber():
    assert not check_unusual_housenumber("21")
    assert not check_unusual_housenumber("21A")
    assert not check_unusual_housenumber("1-3")
    assert not check_unusual_housenumber("") # missing

    assert check_unusual_housenumber("Twenty One") # No numbers
    assert check_unusual_housenumber(" 21") # Leading space
    assert check_unusual_housenumber("21 ") # Trailing space


def test_check_unusual_housename():
    assert not check_unusual_housename("The Cottage")
    assert not check_unusual_housename("Rose Cottage")
    assert not check_unusual_housename("") # missing

    assert check_unusual_housename("Cottage 21") # Numbers
    assert check_unusual_housename("THE COTTAGE") # All caps
    assert check_unusual_housename("the cottage") # Lowercase start
    assert check_unusual_housename("The  Cottage") # Double space


def test_format_object_title():
    popup_tags = {"addr:housenumber": "21"}
    assert format_object_title("", popup_tags, "High Street", "w1234") == "21, High Street"

    popup_tags_2 = {"addr:housename": "Rose Cottage", "addr:housenumber": "21"}
    assert format_object_title("", popup_tags_2, "High Street", "w1234") == "Rose Cottage, 21, High Street"

    assert format_object_title("My Shop", {}, "", "n5678") == "My Shop"
    assert format_object_title("", {}, "", "n5678") == "n5678"


def test_extract_warnings_from_db():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "test_warnings.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                postcode_area TEXT,
                city TEXT,
                suburb TEXT,
                street TEXT,
                popup_tags TEXT,
                osm_id TEXT,
                osm_name TEXT
            )
        """)

        records = [
            ("DH", "Durham", "City Center", "High St", json.dumps({}), "w1", ""),
            ("DH", "Durham", "City Center", "High St", json.dumps({}), "w2", "")
        ]

        conn.executemany("""
            INSERT INTO addresses (
                postcode_area, city, suburb, street, popup_tags, osm_id, osm_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()
        conn.close()

        results = extract_warnings_from_db(db_path)
        assert "DH" in results
        assert "unusual_street" in results["DH"]
        assert len(results["DH"]["unusual_street"]) == 2
        for item in results["DH"]["unusual_street"]:
            # Schema tuple: [value, reason, osm_id]
            assert item[0] == "High St"
            assert "Abbreviation" in item[1]
