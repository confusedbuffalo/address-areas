"""
Configuration constants, transformers, regex patterns, and general utility helpers.
"""
import hashlib
import re
from typing import Any
from pyproj import Transformer
from slugify import slugify

# Configuration
PBF_URL: str = "https://download.geofabrik.de/europe/united-kingdom-latest.osm.pbf"
PBF_FILE: str = "united-kingdom.osm.pbf"
OUTPUT_DIR: str = "dist/data"
PMTILES_OUTPUT_DIR = "dist/pmtiles"

# Global transformers for coordinate projections
TRANSFORMER_TO_27700: Transformer = Transformer.from_crs("EPSG:4326", "EPSG:27700", always_xy=True)
TRANSFORMER_TO_4326: Transformer = Transformer.from_crs("EPSG:27700", "EPSG:4326", always_xy=True)

CONSIDERED_TAGS: list[str] = [
    'addr:unit', 'addr:flats', 'addr:floor', 'addr:housename',
    'addr:housenumber', 'addr:street', 'addr:place', 'addr:parentstreet',
    'addr:suburb', 'addr:locality', 'addr:hamlet', 'addr:village',
    'addr:town', 'addr:city', 'addr:postcode'
]

BASE_FEATURE_TAG_KEYS: set[str] = {
    'shop', 'amenity', 'office', 'craft', 'tourism', 'leisure',
    'healthcare', 'historic', 'emergency', 'military', 'man_made',
    'power', 'landuse', 'highway', 'railway', 'public_transport',
    'education', 'club', 'aeroway', 'waterway', 'barrier'
}

LIFECYCLE_PREFIXES: list[str] = ['disused', 'historic', 'was', 'abandoned']

FEATURE_TAG_KEYS: set[str] = set(BASE_FEATURE_TAG_KEYS)
for _prefix in LIFECYCLE_PREFIXES:
    for _k in BASE_FEATURE_TAG_KEYS:
        FEATURE_TAG_KEYS.add(f"{_prefix}:{_k}")

CONSIDERED_TAGS_SET: set[str] = set(CONSIDERED_TAGS)

POSTCODE_AREA_REGEX: re.Pattern[str] = re.compile(r'^([A-Z]+)')
FULL_POSTCODE_REGEX: re.Pattern[str] = re.compile(r'^[A-Z][A-Z]?[0-9][0-9A-Z]?\s+[0-9][A-Z][A-Z]$')
POSTCODE_SECTOR_REGEX: re.Pattern[str] = re.compile(r'^([A-Z][A-Z]?[0-9][0-9A-Z]?\s+[0-9])')

PALETTE: list[dict[str, str]] = [
    { 'fill': '#f3e8ff', 'label': '#6b21a8' }, # Purple
    { 'fill': '#e0e7ff', 'label': '#3730a3' }, # Indigo
    { 'fill': '#dbeafe', 'label': '#1e40af' }, # Blue
    { 'fill': '#e0f2fe', 'label': '#075985' }, # Sky
    { 'fill': '#ccfbf1', 'label': '#115e59' }, # Teal
    { 'fill': '#dcfce7', 'label': '#166534' }, # Emerald
    { 'fill': '#fef9c3', 'label': '#854d0e' }, # Yellow
    { 'fill': '#fef3c7', 'label': '#92400e' }, # Amber
    { 'fill': '#ffedd5', 'label': '#9a3412' }  # Orange
]


def _get_letter_partition_key(name: Any, placeholder: str, missing_key: str) -> str:
    """Helper to derive letter key partition for entity names.

    Args:
        name: Name string (e.g. city or street name).
        placeholder: Expected placeholder string for missing entity (e.g. 'no city').
        missing_key: Partition key returned for missing entities (e.g. 'no-city').

    Returns:
        str: Letter partition key ('a'-'z', missing_key, or 'other').
    """
    if not name or str(name).strip().lower() in (placeholder, 'missing', 'unknown'):
        return missing_key
    clean_name = str(name).strip()
    first_char = clean_name[0].lower() if clean_name else ''
    if 'a' <= first_char <= 'z':
        return first_char
    return 'other'


def get_city_letter_key(city_name: str) -> str:
    """Returns the letter key partition for a city name.

    Returns 'no-city' if missing/no city, 'a'-'z' if starts with letter, else 'other'.
    """
    return _get_letter_partition_key(city_name, 'no city', 'no-city')


def get_street_letter_key(street_name: str) -> str:
    """Returns the letter key partition for a street name.

    Returns 'no-street' if missing/no street, 'a'-'z' if starts with letter, else 'other'.
    """
    return _get_letter_partition_key(street_name, 'no street', 'no-street')


def extract_postcode_sector(postcode: str) -> str:
    """Extracts postcode sector (e.g., 'DH1 1') from a full postcode string.

    Args:
        postcode: Input postcode string.

    Returns:
        str: Sector string or 'No postcode'.
    """
    if not postcode or postcode in ('No postcode', 'unknown', 'missing'):
        return 'No postcode'
    clean = " ".join(str(postcode).strip().upper().split())
    if ' ' not in clean and len(clean) >= 5 and clean[-3].isdigit():
        clean = f"{clean[:-3]} {clean[-3:]}"
    if FULL_POSTCODE_REGEX.match(clean):
        match = POSTCODE_SECTOR_REGEX.match(clean)
        if match:
            return match.group(1)
    return 'No postcode'


def get_colour_index(s: str, num_colours: int) -> int:
    """Computes a deterministic palette colour index from an MD5 hash of an input string.

    Args:
        s: Input key string.
        num_colours: Total palette size.

    Returns:
        int: Deterministic index in range [0, num_colours - 1].
    """
    h = hashlib.md5(s.encode('utf-8')).hexdigest()
    return int(h, 16) % num_colours


def assign_colours(properties: dict[str, Any], is_points_level: bool) -> None:
    """Assigns `fillColour` and `labelColour` hex code properties based on entity category and postcode.

    Args:
        properties: Properties dictionary to mutate with colour keys.
        is_points_level: True if assigning colours for point-level features.
    """
    raw_name: str = properties.get('raw_name') or properties.get('name') or 'No city'
    colour_key: str = properties.get('postcode') or 'No postcode' if is_points_level else raw_name
    lower: str = colour_key.lower()

    if lower in ('no city', 'no street', 'no postcode'):
        fill_colour = '#fca5a5'
        label_colour = '#7f1d1d'
    elif lower in ('no suburb', 'missing', 'unknown'):
        fill_colour = '#fee2e2'
        label_colour = '#991b1b'
    else:
        idx = get_colour_index(colour_key, len(PALETTE))
        fill_colour = PALETTE[idx]['fill']
        label_colour = PALETTE[idx]['label']

    properties['fillColour'] = fill_colour
    properties['labelColour'] = label_colour


def get_clean_id(parent_id: str, label_key: Any) -> str:
    """Generates a unique slugified ID segment joined with parent ID using an underscore.

    Args:
        parent_id: Identifier of the parent level (or 'root').
        label_key: Segment label string or key.

    Returns:
        str: Composite identifier string.
    """
    slug: str = slugify(str(label_key), replacements=[('_', '-')])
    if not slug:
        slug = "empty"

    label_hash: str = hashlib.md5(str(label_key).encode('utf-8')).hexdigest()[:4]
    segment: str = f"{slug}-{label_hash}"

    if parent_id == 'root':
        return segment
    return f"{parent_id}_{segment}"
