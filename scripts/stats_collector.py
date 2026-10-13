"""
Collects and manages address statistics for UK and individual postcode areas.
"""

import json
import logging
import os
import sqlite3
from datetime import datetime, timezone
from typing import Any, Dict

STATS_DIR = "stats"

logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')


def calculate_stats_from_db(db_path: str) -> Dict[str, Any]:
    """Computes summary stats for 'All UK' and each postcode area from SQLite addresses.db.

    Returns:
        Dict[str, Any]: Stats dictionary mapping area keys ('uk' or postcode area ID like 'DH')
                        to metrics dict: {
                            'total_objects': int,
                            'postcode_count': int,
                            'distinct_postcodes': int,
                            'cities': int,
                            'suburbs': int,
                            'streets': int
                        }
    """
    conn = sqlite3.connect(db_path)
    cursor = conn.cursor()

    stats: Dict[str, Any] = {}

    cursor.execute("PRAGMA table_info(addresses)")
    cols = [r[1] for r in cursor.fetchall()]
    where_interp = " WHERE is_interpolation_only = 0" if 'is_interpolation_only' in cols else ""

    # 1. Calculate All UK stats
    cursor.execute(f"""
        SELECT
            COUNT(*),
            SUM(CASE WHEN postcode IS NOT NULL AND postcode != '' AND postcode != 'No postcode' AND postcode != 'Unknown' THEN 1 ELSE 0 END),
            COUNT(DISTINCT CASE WHEN postcode IS NOT NULL AND postcode != '' AND postcode != 'No postcode' AND postcode != 'Unknown' THEN postcode END),
            COUNT(DISTINCT CASE WHEN city IS NOT NULL AND city != '' AND LOWER(TRIM(city)) NOT IN ('no city', 'missing', 'unknown') THEN city END),
            COUNT(DISTINCT CASE WHEN suburb IS NOT NULL AND suburb != '' AND LOWER(TRIM(suburb)) NOT IN ('no suburb', 'missing', 'unknown') THEN suburb_key END),
            COUNT(DISTINCT CASE WHEN street IS NOT NULL AND street != '' AND LOWER(TRIM(street)) NOT IN ('no street', 'missing', 'unknown') THEN street_key END),
            SUM(CASE WHEN is_addressed = 1 THEN 1 ELSE 0 END)
        FROM addresses
        {where_interp}
    """)
    row = cursor.fetchone()
    total = row[0] or 0
    pc_count = row[1] or 0
    distinct_pc = row[2] or 0
    addressed_count = row[6] or 0

    stats['uk'] = {
        'total_objects': total,
        'postcode_count': pc_count,
        'distinct_postcodes': distinct_pc,
        'cities': row[3] or 0,
        'suburbs': row[4] or 0,
        'streets': row[5] or 0,
        'addressed_count': addressed_count
    }

    # 2. Calculate Per-Postcode Area stats
    cursor.execute(f"""
        SELECT
            postcode_area,
            COUNT(*),
            SUM(CASE WHEN postcode IS NOT NULL AND postcode != '' AND postcode != 'No postcode' AND postcode != 'Unknown' THEN 1 ELSE 0 END),
            COUNT(DISTINCT CASE WHEN postcode IS NOT NULL AND postcode != '' AND postcode != 'No postcode' AND postcode != 'Unknown' THEN postcode END),
            COUNT(DISTINCT CASE WHEN city IS NOT NULL AND city != '' AND LOWER(TRIM(city)) NOT IN ('no city', 'missing', 'unknown') THEN city END),
            COUNT(DISTINCT CASE WHEN suburb IS NOT NULL AND suburb != '' AND LOWER(TRIM(suburb)) NOT IN ('no suburb', 'missing', 'unknown') THEN suburb_key END),
            COUNT(DISTINCT CASE WHEN street IS NOT NULL AND street != '' AND LOWER(TRIM(street)) NOT IN ('no street', 'missing', 'unknown') THEN street_key END),
            SUM(CASE WHEN is_addressed = 1 THEN 1 ELSE 0 END)
        FROM addresses
        {where_interp}
        GROUP BY postcode_area
    """)

    for pa, total_pa, pc_count_pa, distinct_pc_pa, cities_pa, suburbs_pa, streets_pa, addressed_pa in cursor.fetchall():
        if not pa:
            continue
        total_pa = total_pa or 0
        pc_count_pa = pc_count_pa or 0
        distinct_pc_pa = distinct_pc_pa or 0
        addressed_pa = addressed_pa or 0

        stats[pa] = {
            'total_objects': total_pa,
            'postcode_count': pc_count_pa,
            'distinct_postcodes': distinct_pc_pa,
            'cities': cities_pa or 0,
            'suburbs': suburbs_pa or 0,
            'streets': streets_pa or 0,
            'addressed_count': addressed_pa
        }

    conn.close()
    return stats


def get_stats_area_filename(area_key: str) -> str:
    """Returns the standardized JSON filename for a given stats area key.

    Args:
        area_key (str): Area key such as 'uk', 'DH', 'No postcode', or 'Unknown'.

    Returns:
        str: Standardized filename string (e.g. 'uk.json', 'DH.json', 'no-postcode.json').
    """
    if area_key == 'uk':
        return 'uk.json'
    elif area_key == 'No postcode':
        return 'no-postcode.json'
    elif area_key.lower() == 'unknown':
        return 'unknown.json'
    else:
        clean = area_key.strip()
        if clean.isupper() and clean.isalnum():
            return f"{clean}.json"
        clean_slug = clean.lower().replace(' ', '-')
        return f"{clean_slug}.json"


def save_stats_snapshot(stats: Dict[str, Any], date_str: str, output_dir: str = STATS_DIR) -> None:
    """Appends/updates calculated stats snapshot for a date into per-area JSON files in output_dir.

    Args:
        stats (Dict[str, Any]): Calculated statistics object mapping area keys to metric dicts.
        date_str (str): Date formatted as YYYY-MM-DD.
        output_dir (str, optional): Target output directory. Defaults to STATS_DIR.
    """
    os.makedirs(output_dir, exist_ok=True)

    for area_key, area_stats in stats.items():
        fname = get_stats_area_filename(area_key)
        filepath = os.path.join(output_dir, fname)

        area_data: Dict[str, Any] = {}
        if os.path.exists(filepath):
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    area_data = json.load(f)
            except Exception as e:
                logging.warning(f"Could not read existing stats file {filepath}: {e}")

        area_data[date_str] = area_stats

        with open(filepath, 'w', encoding='utf-8') as f:
            json.dump(area_data, f, indent=2, sort_keys=True)

    logging.info(f"Updated per-area stats snapshots for {date_str} across {len(stats)} areas in {output_dir}.")


def should_collect_stats(dt: datetime = None) -> bool:
    """Determines whether stats should be updated based on weekday (Saturday = 5).

    Args:
        dt (datetime, optional): Datetime object to test. Defaults to current UTC datetime.

    Returns:
        bool: True if day of week is Saturday, False otherwise.
    """
    if dt is None:
        dt = datetime.now(timezone.utc)
    return dt.weekday() == 5
