"""
Warning detection rules and SQLite extractor for unusual address tags.
"""
from functools import lru_cache
import json
import re
import sqlite3
from typing import Any, Optional
from config import get_clean_id

# Regex definitions for warning checks
NUMBERS_REGEX: re.Pattern[str] = re.compile(r'[0-9]')
PUNCTUATION_REGEX: re.Pattern[str] = re.compile(r'([,:;/\\]|^-| -|- |-$)')
CAPITALISATION_REGEX: re.Pattern[str] = re.compile(r'(^[a-z]|[A-Z][A-Z])')
ABBREVIATIONS_REGEX: re.Pattern[str] = re.compile(r' (Ave|Blvd|Cl|Cresc?|Ct|Gdns?|Grvs?|Ln|Rd|Sq|St|N|S|E|W)(\.?,? |$)', re.IGNORECASE)
WHITESPACE_REGEX: re.Pattern[str] = re.compile(r'([\v\f\n\r\t]|  |^ | $)')
UNUSUAL_CHARS_REGEX: re.Pattern[str] = re.compile(r'[^A-Za-z0-9 âêôŵŷë\'\.,:;()/\\-]')

MISSING_VALUES_SET: set[str] = {
    'no city', 'no suburb', 'no street', 'no postcode', 'missing', 'unknown', ''
}


def is_missing_value(val: Optional[str]) -> bool:
    """Checks if a string is None, empty, or a placeholder missing value.

    Args:
        val: Input string value.

    Returns:
        bool: True if value is missing or a placeholder string.
    """
    if val is None:
        return True
    s = str(val).strip().lower()
    return s in MISSING_VALUES_SET


# Cache regex validation results for recurring city, suburb and street name strings across DB rows
@lru_cache(maxsize=10000)
def get_reasons_for_city_suburb_street(val: str) -> tuple[str, ...]:
    """Extracts reason labels for unusual city, suburb or street strings."""
    if is_missing_value(val):
        return ()
    reasons = []
    if NUMBERS_REGEX.search(val):
        reasons.append("Numbers")
    if PUNCTUATION_REGEX.search(val):
        reasons.append("Punctuation")
    if CAPITALISATION_REGEX.search(val):
        reasons.append("Capitalisation")
    if ABBREVIATIONS_REGEX.search(val):
        reasons.append("Abbreviation")
    if WHITESPACE_REGEX.search(val):
        reasons.append("Whitespace")
    if UNUSUAL_CHARS_REGEX.search(val):
        reasons.append("Unusual characters")
    return tuple(reasons)


def check_unusual_city(city: str) -> bool:
    """Checks if a city string is unusual."""
    return len(get_reasons_for_city_suburb_street(city)) > 0


def check_unusual_suburb(suburb: str) -> bool:
    """Checks if a suburb string is unusual."""
    return len(get_reasons_for_city_suburb_street(suburb)) > 0


def check_unusual_street(street: str) -> bool:
    """Checks if a street string is unusual."""
    return len(get_reasons_for_city_suburb_street(street)) > 0


# Memoize house number and house name validation results across recurring address values
@lru_cache(maxsize=10000)
def get_reasons_for_housenumber(housenumber: str) -> tuple[str, ...]:
    """Extracts reason labels for unusual housenumber strings."""
    if is_missing_value(housenumber):
        return ()
    reasons = []
    if not NUMBERS_REGEX.search(housenumber):
        reasons.append("No numbers")
    if WHITESPACE_REGEX.search(housenumber):
        reasons.append("Whitespace")
    return tuple(reasons)


def check_unusual_housenumber(housenumber: str) -> bool:
    """Checks if a housenumber string is unusual."""
    return len(get_reasons_for_housenumber(housenumber)) > 0


@lru_cache(maxsize=10000)
def get_reasons_for_housename(housename: str) -> tuple[str, ...]:
    """Extracts reason labels for unusual housename strings."""
    if is_missing_value(housename):
        return ()
    reasons = []
    if NUMBERS_REGEX.search(housename):
        reasons.append("Numbers")
    if CAPITALISATION_REGEX.search(housename):
        reasons.append("Capitalisation")
    if WHITESPACE_REGEX.search(housename):
        reasons.append("Whitespace")
    if UNUSUAL_CHARS_REGEX.search(housename):
        reasons.append("Unusual characters")
    return tuple(reasons)


def check_unusual_housename(housename: str) -> bool:
    """Checks if a housename string is unusual."""
    return len(get_reasons_for_housename(housename)) > 0


def format_object_title(
    osm_name: str,
    popup_tags: dict[str, str],
    street_val: str,
    osm_id: str
) -> str:
    """Formats display title for an address object.

    Args:
        osm_name: OpenStreetMap object name tag if present.
        popup_tags: Parsed dictionary of address tags.
        street_val: Street attribute from database.
        osm_id: OSM element identifier (e.g., 'n123', 'w456').

    Returns:
        str: Object display title string.
    """
    floor = str(popup_tags.get('addr:floor', '')).strip()
    unit = str(popup_tags.get('addr:unit', '')).strip()
    flats = str(popup_tags.get('addr:flats', '')).strip()
    name = str(popup_tags.get('addr:housename', '')).strip()
    number = str(popup_tags.get('addr:housenumber', '')).strip()

    name_num_part = ""
    if name and number:
        name_num_part = f"{name}, {number}"
    elif name:
        name_num_part = name
    elif number:
        name_num_part = number

    addr_parts: list[str] = []
    if floor:
        addr_parts.append(f"Floor {floor}")
    if unit:
        addr_parts.append(unit)
    if flats:
        addr_parts.append(f"Flats {flats}")
    if name_num_part:
        addr_parts.append(name_num_part)

    addr_label = ", ".join(addr_parts) if addr_parts else ""

    clean_osm_name = str(osm_name or '').strip()
    if clean_osm_name:
        final_label = f"{clean_osm_name} - {addr_label}" if addr_label else clean_osm_name
    else:
        final_label = addr_label

    street_name = str(street_val or '').strip()
    if is_missing_value(street_name):
        street_name = ""

    if street_name:
        if final_label:
            return f"{final_label}, {street_name}"
        return street_name

    if final_label:
        return final_label

    return osm_id


def extract_warnings_from_db(db_path: str) -> dict[str, dict[str, list[list[str]]]]:
    """Scans SQLite database addresses table and returns all warning items grouped by postcode area and category as compact tuples.

    Args:
        db_path: Path to SQLite addresses.db.

    Returns:
        dict: Mapping of { postcode_area: { category_name: [ [ value, reason, osm_id ] ] } }.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cursor = conn.cursor()

    warnings_by_pa: dict[str, dict[str, list[list[str]]]] = {}

    categories = [
        'unusual_city',
        'unusual_suburb',
        'unusual_street',
        'unusual_housenumber',
        'unusual_housename'
    ]

    query = "SELECT postcode_area, city, suburb, street, popup_tags, osm_id, osm_name FROM addresses"
    cursor.execute(query)

    for row in cursor:
        pa, city, suburb, street, popup_tags_json, osm_id, osm_name = row
        pa_key = pa if pa else 'No postcode'

        housenumber = ''
        housename = ''

        # Fast-path check for house number/name tags prior to invoking expensive json.loads parsing
        if popup_tags_json and ('addr:housenumber' in popup_tags_json or 'addr:housename' in popup_tags_json):
            try:
                tags = json.loads(popup_tags_json)
                housenumber = tags.get('addr:housenumber', '')
                housename = tags.get('addr:housename', '')
            except Exception:
                pass

        # Check each warning category
        flags: list[tuple[str, str, str]] = []

        if city:
            city_reasons = get_reasons_for_city_suburb_street(city)
            if city_reasons:
                flags.append(('unusual_city', city, ", ".join(city_reasons)))

        if suburb:
            suburb_reasons = get_reasons_for_city_suburb_street(suburb)
            if suburb_reasons:
                flags.append(('unusual_suburb', suburb, ", ".join(suburb_reasons)))

        if street:
            street_reasons = get_reasons_for_city_suburb_street(street)
            if street_reasons:
                flags.append(('unusual_street', street, ", ".join(street_reasons)))

        if housenumber:
            hn_reasons = get_reasons_for_housenumber(housenumber)
            if hn_reasons:
                flags.append(('unusual_housenumber', housenumber, ", ".join(hn_reasons)))

        if housename:
            hname_reasons = get_reasons_for_housename(housename)
            if hname_reasons:
                flags.append(('unusual_housename', housename, ", ".join(hname_reasons)))

        if flags:
            if pa_key not in warnings_by_pa:
                warnings_by_pa[pa_key] = {cat: [] for cat in categories}

            for cat, val, reason in flags:
                warnings_by_pa[pa_key][cat].append([
                    str(val),
                    reason,
                    str(osm_id)
                ])

    conn.close()
    return warnings_by_pa
