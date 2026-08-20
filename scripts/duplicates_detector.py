"""
Duplicate address detection rules and SQLite extractor.
"""
import json
import sqlite3
from typing import Any, Optional
from config import FEATURE_TAG_KEYS

SUBURB_TAG_KEYS = ['addr:suburb', 'addr:locality', 'addr:hamlet', 'addr:village', 'addr:town']
SUB_UNIT_TAG_KEYS = ['addr:unit', 'addr:flats', 'addr:floor']


class DisjointSet:
    """Disjoint Set Union (DSU) for grouping matching items."""

    def __init__(self, n: int) -> None:
        self.parent = list(range(n))

    def find(self, i: int) -> int:
        if self.parent[i] == i:
            return i
        self.parent[i] = self.find(self.parent[i])
        return self.parent[i]

    def union(self, i: int, j: int) -> None:
        root_i = self.find(i)
        root_j = self.find(j)
        if root_i != root_j:
            self.parent[root_i] = root_j


def format_duplicate_title(
    housenumber: str,
    housename: str,
    street: str,
    unit: str,
    flats: str,
    floor: str
) -> str:
    """Formats a human-readable address title for a duplicate address group."""
    parts: list[str] = []

    if floor:
        parts.append(f"Floor {floor}")
    if unit:
        parts.append(unit)
    if flats:
        parts.append(f"Flat {flats}")

    name_num_part = ""
    if housename and housenumber:
        name_num_part = f"{housename}, {housenumber}"
    elif housename:
        name_num_part = housename
    elif housenumber:
        name_num_part = housenumber

    if name_num_part:
        parts.append(name_num_part)

    if street:
        parts.append(street)

    return ", ".join(parts) if parts else "Unknown Address"


def is_duplicate_pair(item_a: dict[str, Any], item_b: dict[str, Any]) -> bool:
    """Checks if two candidate address items match as duplicates based on house number/name rules.

    Rules:
    - If house number is tagged on both, numbers must match.
    - If house name is tagged on both, names must match.
    - At least one tag (house number or house name) must be tagged on both items and match.
    """
    hn_a = item_a['hn']
    hn_b = item_b['hn']
    hname_a = item_a['hname']
    hname_b = item_b['hname']

    if hn_a and hn_b and hn_a != hn_b:
        return False

    if hname_a and hname_b and hname_a != hname_b:
        return False

    has_shared_match = (hn_a and hn_b and hn_a == hn_b) or (hname_a and hname_b and hname_a == hname_b)
    return bool(has_shared_match)


def extract_duplicates_from_db(db_path: str) -> dict[str, list[list[Any]]]:
    """Scans SQLite database addresses table and returns duplicate address groups by postcode area as compact tuples.

    Args:
        db_path: Path to SQLite addresses.db.

    Returns:
        dict: Mapping of { postcode_area: [ [ title, [osm_ids] ] ] }.
    """
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    cursor = conn.cursor()

    # Check if has_feature_tag column exists in table schema
    cursor.execute("PRAGMA table_info(addresses)")
    columns = [row[1] for row in cursor.fetchall()]
    has_feature_col = 'has_feature_tag' in columns

    query = "SELECT postcode_area, postcode, city, suburb, suburb_type, street, street_type, popup_tags, osm_id, osm_name"
    if has_feature_col:
        query += ", has_feature_tag"
    query += " FROM addresses"

    cursor.execute(query)

    # Candidate buckets: key -> list of item dicts
    candidate_buckets: dict[tuple, list[dict[str, Any]]] = {}

    for row in cursor:
        if has_feature_col:
            pa, db_pc, db_city, db_suburb, db_suburb_type, db_street, db_street_type, popup_tags_json, osm_id, osm_name, feature_flag = row
            if feature_flag == 1:
                continue
        else:
            pa, db_pc, db_city, db_suburb, db_suburb_type, db_street, db_street_type, popup_tags_json, osm_id, osm_name = row

        tags: dict[str, str] = {}
        if popup_tags_json:
            try:
                tags = json.loads(popup_tags_json)
            except Exception:
                tags = {}

        # Exclude objects containing feature tags if feature_flag wasn't set or as fallback check
        if any(k in tags for k in FEATURE_TAG_KEYS):
            continue

        hn = tags.get('addr:housenumber', '').strip().lower()
        hname = tags.get('addr:housename', '').strip().lower()

        # At least one of house number or house name must be present
        if not hn and not hname:
            continue

        # Street tag matching: must use exact tag key ('addr:street' or 'addr:place')
        street_tag_key = None
        street_val = None
        if 'addr:street' in tags and tags['addr:street'].strip():
            street_tag_key = 'addr:street'
            street_val = tags['addr:street'].strip()
        elif 'addr:place' in tags and tags['addr:place'].strip():
            street_tag_key = 'addr:place'
            street_val = tags['addr:place'].strip()

        if not street_tag_key or not street_val:
            continue

        # Sub-unit tags matching ('addr:unit', 'addr:flats', 'addr:floor')
        unit_val = tags.get('addr:unit', '').strip().lower() or 'none'
        flats_val = tags.get('addr:flats', '').strip().lower() or 'none'
        floor_val = tags.get('addr:floor', '').strip().lower() or 'none'

        pa_key = pa if pa else 'No postcode'

        # Do not calculate duplicates when there's no postcode
        if pa_key == 'No postcode':
            continue

        item = {
            'osm_id': str(osm_id),
            'hn': hn,
            'hname': hname,
            'hn_orig': tags.get('addr:housenumber', '').strip(),
            'hname_orig': tags.get('addr:housename', '').strip(),
            'street_orig': street_val,
            'unit_orig': tags.get('addr:unit', '').strip(),
            'flats_orig': tags.get('addr:flats', '').strip(),
            'floor_orig': tags.get('addr:floor', '').strip()
        }

        pc_norm = tags.get('addr:postcode', db_pc or '').strip().lower()
        if not pc_norm or pc_norm in ('no postcode', 'missing', 'unknown'):
            continue

        bucket_key = (
            pa_key,
            pc_norm,
            street_tag_key,
            street_val.lower(),
            unit_val,
            flats_val,
            floor_val
        )

        candidate_buckets.setdefault(bucket_key, []).append(item)

    conn.close()

    duplicates_by_pa: dict[str, list[dict[str, Any]]] = {}

    # Process candidate buckets and extract duplicate groups
    for bucket_key, items in candidate_buckets.items():
        if len(items) < 2:
            continue

        n = len(items)
        dsu = DisjointSet(n)

        # Index items by index in candidate bucket
        # Build sub-groups for non-empty hn and non-empty hname to avoid O(N^2) checks across unmatching items
        hn_groups: dict[str, list[int]] = {}
        hname_groups: dict[str, list[int]] = {}

        for idx, item in enumerate(items):
            if item['hn']:
                hn_groups.setdefault(item['hn'], []).append(idx)
            if item['hname']:
                hname_groups.setdefault(item['hname'], []).append(idx)

        for idxs in hn_groups.values():
            m = len(idxs)
            if m > 1:
                for i in range(m):
                    for j in range(i + 1, m):
                        idx1, idx2 = idxs[i], idxs[j]
                        if is_duplicate_pair(items[idx1], items[idx2]):
                            dsu.union(idx1, idx2)

        for idxs in hname_groups.values():
            m = len(idxs)
            if m > 1:
                for i in range(m):
                    for j in range(i + 1, m):
                        idx1, idx2 = idxs[i], idxs[j]
                        if is_duplicate_pair(items[idx1], items[idx2]):
                            dsu.union(idx1, idx2)

        clusters: dict[int, list[dict[str, Any]]] = {}
        for i in range(n):
            root = dsu.find(i)
            clusters.setdefault(root, []).append(items[i])

        pa_key = bucket_key[0]
        if pa_key not in duplicates_by_pa:
            duplicates_by_pa[pa_key] = []

        for group_items in clusters.values():
            if len(group_items) < 2:
                continue

            # Select representative title attributes from group
            rep_hn = ""
            rep_hname = ""
            rep_street = group_items[0]['street_orig']
            rep_unit = group_items[0]['unit_orig']
            rep_flats = group_items[0]['flats_orig']
            rep_floor = group_items[0]['floor_orig']

            for it in group_items:
                if it['hname_orig'] and not rep_hname:
                    rep_hname = it['hname_orig']
                if it['hn_orig'] and not rep_hn:
                    rep_hn = it['hn_orig']

            title = format_duplicate_title(
                housenumber=rep_hn,
                housename=rep_hname,
                street=rep_street,
                unit=rep_unit,
                flats=rep_flats,
                floor=rep_floor
            )

            osm_ids = sorted([it['osm_id'] for it in group_items])
            duplicates_by_pa[pa_key].append([
                title,
                osm_ids
            ])

    # Sort groups within each postcode area by title
    for pa_key in duplicates_by_pa:
        duplicates_by_pa[pa_key].sort(key=lambda g: g[0])

    return duplicates_by_pa
