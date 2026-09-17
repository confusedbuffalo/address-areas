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
WHITESPACE_REGEX: re.Pattern[str] = re.compile(r'([\v\f\n\r\t]|  |^ | $)')
UNUSUAL_CHARS_REGEX: re.Pattern[str] = re.compile(r'[^A-Za-z0-9 âêôŵŷë\'\.,:;()/\\-]')

OTHER_ABBREVIATIONS_REGEX: re.Pattern[str] = re.compile(
    r'(?:^| )(Ave|Blvd|Cl|Cresc?|Ct|Gdns?|Grvs?|Ln|Rd|Sq|N|S|E|W)(\.?,?)(?: |$)',
    re.IGNORECASE
)

ST_ABBREVIATION_REGEX: re.Pattern[str] = re.compile(
    r'(?:^| )St\.?,?(?:$| (?:North|South|East|West|N|S|E|W|NE|NW|SE|SW)(\.?,?)(?: |$))',
    re.IGNORECASE
)

MISSING_VALUES_SET: set[str] = {
    'no city', 'no suburb', 'no street', 'no postcode', 'missing', 'unknown', ''
}

VALID_BASE_ADDR_TAGS: set[str] = {
    'addr:unit',
    'addr:flats',
    'addr:floor',
    'addr:housename',
    'addr:housenumber',
    'addr:street',
    'addr:place',
    'addr:parentstreet',
    'addr:locality',
    'addr:hamlet',
    'addr:village',
    'addr:suburb',
    'addr:town',
    'addr:city',
    'addr:county',
    'addr:postcode',
    'addr:country',
    'addr:full',
    'addr:interpolation',
    'addr:inclusion',
    'addr:subdistrict',
    'addr:district',
    'addr:substreet',
    'addr:state',
}

VALID_LANG_CODES: set[str] = {'en', 'cy', 'gd', 'ga'}


def is_valid_address_tag(key: str) -> bool:
    """Checks if an addr:* tag key is one of the standard accepted address tags or ends with an allowed language code (en, cy, gd, ga).

    Args:
        key: Tag key string (e.g. 'addr:housename', 'addr:housename:en').

    Returns:
        bool: True if key is a standard valid address tag.
    """
    if key in VALID_BASE_ADDR_TAGS:
        return True

    # Check for valid base tag followed by allowed language code
    if ':' in key:
        parts = key.rsplit(':', 1)
        base = parts[0]
        lang = parts[1]
        if base in VALID_BASE_ADDR_TAGS and lang in VALID_LANG_CODES:
            return True

    return False


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
def get_reasons_for_city_suburb(val: str) -> tuple[str, ...]:
    """Extracts reason labels for unusual city or suburb strings (no abbreviation checks)."""
    if is_missing_value(val):
        return ()
    reasons = []
    if NUMBERS_REGEX.search(val):
        reasons.append("Numbers")
    if PUNCTUATION_REGEX.search(val):
        reasons.append("Punctuation")
    if CAPITALISATION_REGEX.search(val):
        reasons.append("Capitalisation")
    if WHITESPACE_REGEX.search(val):
        reasons.append("Whitespace")
    if UNUSUAL_CHARS_REGEX.search(val):
        reasons.append("Unusual characters")
    return tuple(reasons)


@lru_cache(maxsize=10000)
def get_reasons_for_street(val: str) -> tuple[str, ...]:
    """Extracts reason labels for unusual street strings (including street abbreviation checks)."""
    if is_missing_value(val):
        return ()
    reasons = []
    if NUMBERS_REGEX.search(val):
        reasons.append("Numbers")
    if PUNCTUATION_REGEX.search(val):
        reasons.append("Punctuation")
    if CAPITALISATION_REGEX.search(val):
        reasons.append("Capitalisation")
    if OTHER_ABBREVIATIONS_REGEX.search(val) or ST_ABBREVIATION_REGEX.search(val):
        reasons.append("Abbreviation")
    if WHITESPACE_REGEX.search(val):
        reasons.append("Whitespace")
    if UNUSUAL_CHARS_REGEX.search(val):
        reasons.append("Unusual characters")
    return tuple(reasons)


def get_reasons_for_city_suburb_street(val: str) -> tuple[str, ...]:
    """Backwards-compatible wrapper: alias for get_reasons_for_street."""
    return get_reasons_for_street(val)


def check_unusual_city(city: str) -> bool:
    """Checks if a city string is unusual."""
    return len(get_reasons_for_city_suburb(city)) > 0


def check_unusual_suburb(suburb: str) -> bool:
    """Checks if a suburb string is unusual."""
    return len(get_reasons_for_city_suburb(suburb)) > 0


def check_unusual_street(street: str) -> bool:
    """Checks if a street string is unusual."""
    return len(get_reasons_for_street(street)) > 0


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
        'unusual_housename',
        'duplicates',
        'duplicate_suburb_value',
        'unusual_address_tag',
        'missing_physical_road',
        'place_with_street'
    ]

    query = "SELECT postcode_area, city, suburb, street, popup_tags, osm_id, osm_name, unusual_addr_tags FROM addresses"
    cursor.execute(query)

    for row in cursor:
        pa, city, suburb, street, popup_tags_json, osm_id, osm_name, unusual_tags_json = row

        pa_key = pa if pa else 'No postcode'

        housenumber = ''
        housename = ''
        place_val = ''
        street_tag_val = ''
        suburb_tag_matches: dict[str, list[str]] = {}

        if popup_tags_json:
            try:
                tags = json.loads(popup_tags_json)
                housenumber = tags.get('addr:housenumber', '')
                housename = tags.get('addr:housename', '')
                place_val = str(tags.get('addr:place') or '').strip()
                street_tag_val = str(tags.get('addr:street') or '').strip()

                suburb_keys = ['addr:locality', 'addr:hamlet', 'addr:suburb', 'addr:village', 'addr:town']
                for sk in suburb_keys:
                    sv = str(tags.get(sk) or '').strip()
                    if sv and not is_missing_value(sv):
                        suburb_tag_matches.setdefault(sv, []).append(sk)
            except Exception:
                pass

        unusual_tags: dict[str, str] = {}
        if unusual_tags_json:
            try:
                unusual_tags = json.loads(unusual_tags_json)
            except Exception:
                pass

        # Check each warning category
        flags: list[tuple[str, str, str]] = []

        # Check for unusual addr:* tags
        if unusual_tags:
            for k, v in unusual_tags.items():
                if k.startswith('addr:') and not is_valid_address_tag(k):
                    tag_val = str(v or '').strip()
                    if tag_val:
                        flags.append(('unusual_address_tag', tag_val, k))

        if city:
            city_reasons = get_reasons_for_city_suburb(city)
            if city_reasons:
                flags.append(('unusual_city', city, ", ".join(city_reasons)))

        if suburb:
            suburb_reasons = get_reasons_for_city_suburb(suburb)
            if suburb_reasons:
                flags.append(('unusual_suburb', suburb, ", ".join(suburb_reasons)))

        if street:
            street_reasons = get_reasons_for_street(street)
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

        if place_val and street_tag_val:
            flags.append(('place_with_street', place_val, street_tag_val))

        for sub_val, matching_keys in suburb_tag_matches.items():
            if len(matching_keys) > 1:
                flags.append(('duplicate_suburb_value', sub_val, ", ".join(matching_keys)))

        if flags:
            if pa_key not in warnings_by_pa:
                warnings_by_pa[pa_key] = {cat: [] for cat in categories}

            for cat, val, reason in flags:
                warnings_by_pa[pa_key][cat].append([
                    str(val),
                    reason,
                    str(osm_id)
                ])

    # Check if x_proj exists in addresses table and physical_highways table exists
    cursor.execute("PRAGMA table_info(addresses)")
    add_cols = [r[1] for r in cursor.fetchall()]

    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='physical_highways'")
    has_highways_table = bool(cursor.fetchone())

    if 'x_proj' in add_cols and has_highways_table:
        cursor.execute("""
            SELECT postcode_area, street, GROUP_CONCAT(osm_id, ','), MIN(x_proj), MAX(x_proj), MIN(y_proj), MAX(y_proj)
            FROM addresses
            WHERE street IS NOT NULL AND TRIM(street) != ''
              AND street NOT IN ('No street', 'no street', 'missing', 'unknown')
              AND (street_type IS NULL OR street_type != 'place')
            GROUP BY postcode_area, street
        """)

        missing_road_rows = cursor.fetchall()

        for row in missing_road_rows:
            pa, street_val, concat_osm_ids, min_x, max_x, min_y, max_y = row
            pa_key = pa if pa else 'No postcode'

            if min_x is None or max_x is None or min_y is None or max_y is None:
                continue

            b_min_x = min_x - 250.0
            b_min_y = min_y - 250.0
            b_max_x = max_x + 250.0
            b_max_y = max_y + 250.0

            cursor.execute("""
                SELECT 1 FROM physical_highways
                WHERE name = ?
                  AND max_x >= ? AND min_x <= ? AND max_y >= ? AND min_y <= ?
                LIMIT 1
            """, (street_val, b_min_x, b_max_x, b_min_y, b_max_y))

            has_match = cursor.fetchone() is not None

            if not has_match:
                raw_ids = [s.strip() for s in str(concat_osm_ids or '').split(',') if s.strip()]
                unique_ids = list(dict.fromkeys(raw_ids))
                ids_str = ",".join(unique_ids)

                if pa_key not in warnings_by_pa:
                    warnings_by_pa[pa_key] = {cat: [] for cat in categories}
                warnings_by_pa[pa_key]['missing_physical_road'].append([
                    str(street_val),
                    "No physical highway with matching name within 250m",
                    ids_str
                ])

    conn.close()
    return warnings_by_pa
