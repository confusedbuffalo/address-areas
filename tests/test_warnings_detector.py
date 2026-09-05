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
    is_valid_address_tag,
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


def test_is_valid_address_tag():
    # Valid base tags
    assert is_valid_address_tag("addr:unit")
    assert is_valid_address_tag("addr:flats")
    assert is_valid_address_tag("addr:floor")
    assert is_valid_address_tag("addr:housename")
    assert is_valid_address_tag("addr:housenumber")
    assert is_valid_address_tag("addr:street")
    assert is_valid_address_tag("addr:place")
    assert is_valid_address_tag("addr:parentstreet")
    assert is_valid_address_tag("addr:locality")
    assert is_valid_address_tag("addr:hamlet")
    assert is_valid_address_tag("addr:village")
    assert is_valid_address_tag("addr:suburb")
    assert is_valid_address_tag("addr:town")
    assert is_valid_address_tag("addr:city")
    assert is_valid_address_tag("addr:county")
    assert is_valid_address_tag("addr:postcode")
    assert is_valid_address_tag("addr:country")
    assert is_valid_address_tag("addr:full")
    assert is_valid_address_tag("addr:interpolation")
    assert is_valid_address_tag("addr:inclusion")
    assert is_valid_address_tag("addr:subdistrict")
    assert is_valid_address_tag("addr:district")
    assert is_valid_address_tag("addr:substreet")
    assert is_valid_address_tag("addr:state")

    # Valid tags with allowed language suffixes (en, cy, gd, ga)
    assert is_valid_address_tag("addr:housename:en")
    assert is_valid_address_tag("addr:street:cy")
    assert is_valid_address_tag("addr:city:gd")
    assert is_valid_address_tag("addr:place:ga")

    # Invalid tag keys / disallowed language suffixes
    assert not is_valid_address_tag("addr:housename:de")
    assert not is_valid_address_tag("addr:island")
    assert not is_valid_address_tag("addr:door")
    assert not is_valid_address_tag("addr:street_name")


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
                unusual_addr_tags TEXT,
                osm_id TEXT,
                osm_name TEXT
            )
        """)

        records = [
            ("DH", "Durham", "City Center", "High St", json.dumps({}), json.dumps({}), "w1", ""),
            ("DH", "Durham", "City Center", "High St", json.dumps({}), json.dumps({}), "w2", "")
        ]

        conn.executemany("""
            INSERT INTO addresses (
                postcode_area, city, suburb, street, popup_tags, unusual_addr_tags, osm_id, osm_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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


def test_extract_unusual_address_tags_from_db():
    with tempfile.TemporaryDirectory() as temp_dir:
        db_path = os.path.join(temp_dir, "test_warnings_tags.db")
        conn = sqlite3.connect(db_path)
        conn.execute("""
            CREATE TABLE addresses (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                postcode_area TEXT,
                city TEXT,
                suburb TEXT,
                street TEXT,
                popup_tags TEXT,
                unusual_addr_tags TEXT,
                osm_id TEXT,
                osm_name TEXT
            )
        """)

        records = [
            ("SW", "London", "Westminster", "Victoria St", json.dumps({"addr:housenumber": "10"}), json.dumps({"addr:island": "North Island"}), "n100", ""),
            ("SW", "London", "Westminster", "Victoria St", json.dumps({"addr:housenumber": "12"}), json.dumps({"addr:housename:de": "Haus"}), "n101", "")
        ]

        conn.executemany("""
            INSERT INTO addresses (
                postcode_area, city, suburb, street, popup_tags, unusual_addr_tags, osm_id, osm_name
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """, records)
        conn.commit()
        conn.close()

        results = extract_warnings_from_db(db_path)
        assert "SW" in results
        assert "unusual_address_tag" in results["SW"]
        assert len(results["SW"]["unusual_address_tag"]) == 2
        items = results["SW"]["unusual_address_tag"]
        assert items[0] == ["North Island", "addr:island", "n100"]
        assert items[1] == ["Haus", "addr:housename:de", "n101"]
