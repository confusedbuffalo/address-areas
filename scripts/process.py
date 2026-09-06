"""
Processes OpenStreetMap address data into hierarchical GeoJSON, compact search indices and Tippecanoe PMTiles.
"""
from concurrent.futures import ProcessPoolExecutor, as_completed
from datetime import datetime, timezone
import email.utils
import json
import logging
import os
import requests
import shutil
import sqlite3
import subprocess
from typing import Any, Optional

import osmium
import osmium.filter
import pandas as pd
import shapely

from config import (
    CONSIDERED_TAGS,
    OUTPUT_DIR,
    PBF_FILE,
    PBF_URL,
    PMTILES_OUTPUT_DIR,
    assign_colours,
    get_city_letter_key,
    get_clean_id,
)
from duplicates_detector import extract_duplicates_from_db
from osm_parser import (
    NodeAddressHandler,
    RelationMemberScanner,
    WayAddressHandler,
)
from spatial import create_spatial_chunks
from workers import (
    merge_city_tuples,
    merge_suburb_tuples,
    process_no_postcode_sub_partition_worker,
    process_postcode_area_worker,
)
from stats_collector import (
    calculate_stats_from_db,
    save_stats_snapshot,
    should_collect_stats,
)
from warnings_detector import extract_warnings_from_db

logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')


def compile_single_layer_pmtiles(cfg: dict[str, Any], geojson_path: str, timestamp_str: str, output_dir: str) -> str:
    """Compiles a single layer GeoJSON file into PMTiles using Tippecanoe with parallel speedup options.

    Args:
        cfg: Dictionary with 'level', 'min_zoom', and 'max_zoom'.
        geojson_path: Path to input layer GeoJSON file.
        timestamp_str: Current UTC build timestamp string.
        output_dir: Target output directory path.

    Returns:
        str: Layer level identifier.
    """
    lvl = cfg["level"]
    min_z = cfg["min_zoom"]
    max_z = cfg["max_zoom"]
    pmtiles_filename = f"{lvl}_{timestamp_str}.pmtiles"
    pmtiles_path = os.path.join(output_dir, pmtiles_filename)

    cmd = [
        "tippecanoe",
        "-f",
        "-o", pmtiles_path,
        f"-Z{min_z}",
        f"-z{max_z}",
        "-l", lvl,
        "--drop-rate=0",
        "--no-tile-size-limit",
        "--no-feature-limit",
        "--read-parallel",
        "--no-tile-stats",
        "--progress-interval=30",
        geojson_path
    ]

    try:
        logging.info(f"Compiling {lvl} layer into PMTiles file {pmtiles_filename}...")
        subprocess.run(cmd, check=True)
    except Exception as e:
        logging.warning(f"Tippecanoe compilation failed for {lvl}: {e}. Proceeding without PMTiles...")
        with open(pmtiles_path, 'wb') as f:
            f.write(b"")

    return lvl


def process() -> None:
    """Main processing pipeline: parses PBF into SQLite, processes postcode areas with clipped Voronoi cells, and compiles PMTiles."""
    pbf_to_download = PBF_FILE

    if not os.path.exists(pbf_to_download):
        pbf_to_download = PBF_FILE
        logging.info(f"Downloading PBF from {PBF_URL}...")
        r = requests.get(PBF_URL, stream=True)
        with open(pbf_to_download, 'wb') as f:
            for chunk in r.iter_content(chunk_size=1024*1024):
                if chunk:
                    f.write(chunk)

        dt: Optional[datetime] = None
        raw_ts: Optional[str] = None
        source: Optional[str] = None

        try:
            reader = osmium.io.Reader(pbf_to_download)
            header = reader.header()
            if raw := header.get("timestamp"):
                dt, raw_ts, source = datetime.fromisoformat(raw), raw, "PBF 'timestamp' header"
            elif raw := header.get("osmosis_replication_timestamp"):
                dt, raw_ts, source = datetime.fromisoformat(raw), raw, "PBF 'osmosis_replication_timestamp' header"
        except Exception as e:
            logging.debug(f"Could not read PBF file header from '{pbf_to_download}': {e}")

        if not dt and (raw := r.headers.get("Last-Modified")):
            try:
                dt, raw_ts, source = email.utils.parsedate_to_datetime(raw), raw, "HTTP 'Last-Modified' header"
            except Exception as e:
                logging.warning(f"Failed to parse HTTP Last-Modified header '{raw}': {e}")

        if dt:
            try:
                mtime: float = dt.timestamp()
                os.utime(pbf_to_download, (mtime, mtime))
                logging.info(f"Set '{pbf_to_download}' modification time to {dt} using {source} ({raw_ts})")
            except Exception as e:
                logging.warning(f"Failed to set modification time on '{pbf_to_download}' using {source}: {e}")

    active_pbf_file = pbf_to_download

    if os.path.exists(OUTPUT_DIR):
        shutil.rmtree(OUTPUT_DIR)
    os.makedirs(OUTPUT_DIR, exist_ok=True)
    if os.path.exists(PMTILES_OUTPUT_DIR):
        shutil.rmtree(PMTILES_OUTPUT_DIR)
    os.makedirs(PMTILES_OUTPUT_DIR, exist_ok=True)

    if os.path.exists(active_pbf_file):
        pbf_mtime_ms = int(os.path.getmtime(active_pbf_file) * 1000)
        with open(os.path.join(OUTPUT_DIR, "pbf_timestamp.txt"), "w", encoding="utf-8") as f:
            f.write(str(pbf_mtime_ms))

    db_path = os.path.join(OUTPUT_DIR, "addresses.db")
    if os.path.exists(db_path):
        os.remove(db_path)

    conn = sqlite3.connect(db_path)
    conn.execute("""
        CREATE TABLE addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lat REAL,
            lon REAL,
            x_proj REAL,
            y_proj REAL,
            postcode TEXT,
            postcode_area TEXT,
            city TEXT,
            suburb TEXT,
            suburb_type TEXT,
            suburb_key TEXT,
            street TEXT,
            street_type TEXT,
            street_key TEXT,
            popup_tags TEXT,
            unusual_addr_tags TEXT,
            osm_id TEXT,
            osm_name TEXT,
            is_addressed INTEGER,
            has_feature_tag INTEGER
        )
    """)

    key_filter = osmium.filter.KeyFilter(*CONSIDERED_TAGS)

    logging.info(f"Scanning relations in {active_pbf_file}...")
    scanner = RelationMemberScanner()
    scanner.apply_file(active_pbf_file, filters=[key_filter])

    logging.info("Extracting address nodes into SQLite...")
    node_handler = NodeAddressHandler(conn=conn, member_node_ids=scanner.member_node_ids)
    node_handler.apply_file(active_pbf_file, filters=[key_filter])
    node_handler.flush()

    logging.info("Extracting address ways and relations into SQLite...")
    way_handler = WayAddressHandler(
        conn=conn,
        member_way_ids=scanner.member_way_ids,
        member_node_ids=scanner.member_node_ids
    )
    way_handler.relation_node_locs = node_handler.relation_node_locs
    way_handler.apply_file(active_pbf_file, locations=True, idx='flex_mem')
    way_handler.flush()

    total_addresses = node_handler.total_addresses + way_handler.total_addresses
    logging.info(f"Extracted {total_addresses} total address records into SQLite.")

    logging.info("Creating SQLite indices...")
    conn.execute("CREATE INDEX idx_postcode_area ON addresses(postcode_area);")
    conn.execute("CREATE INDEX idx_xy ON addresses(x_proj, y_proj);")
    conn.commit()

    pas_df = pd.read_sql_query("SELECT DISTINCT postcode_area FROM addresses", conn)
    postcode_areas = pas_df['postcode_area'].tolist()

    standard_pas = [pa for pa in postcode_areas if pa != 'No postcode']
    has_no_postcode = 'No postcode' in postcode_areas

    # Collect No Postcode city sub-partition tasks if 'No postcode' exists
    no_postcode_tasks = []
    if has_no_postcode:
        no_pc_cities_df = pd.read_sql_query(
            "SELECT DISTINCT city FROM addresses WHERE postcode_area = 'No postcode'", conn
        )
        cities_list = no_pc_cities_df['city'].dropna().tolist()

        letter_map: dict[str, list[str]] = {}
        for cname in cities_list:
            key = get_city_letter_key(cname)
            letter_map.setdefault(key, []).append(cname)

        # Always include 'no-city' letter key partition
        if 'no-city' not in letter_map:
            letter_map['no-city'] = []

        # Calculate spatial chunks for each letter partition to ensure max chunk size <= 40,000 points
        for letter_key, cnames in letter_map.items():
            if letter_key == 'no-city':
                q = "SELECT x_proj, y_proj FROM addresses WHERE postcode_area = 'No postcode' AND (city IS NULL OR LOWER(TRIM(city)) IN ('', 'no city', 'missing', 'unknown'))"
                p = []
            else:
                placeholders = ', '.join(['?'] * len(cnames))
                q = f"SELECT x_proj, y_proj FROM addresses WHERE postcode_area = 'No postcode' AND city IN ({placeholders})"
                p = cnames

            df_summary = pd.read_sql_query(q, conn, params=p)
            chunks_bounds = create_spatial_chunks(df_summary, max_chunk_size=40000, grid_resolution=25000.0)
            total_chunks = len(chunks_bounds)

            for chunk_idx, bounds_list in enumerate(chunks_bounds):
                no_postcode_tasks.append((letter_key, cnames, chunk_idx, total_chunks, bounds_list))

    # Extract warnings and duplicates data from SQLite before closing db
    logging.info("Extracting QA warnings and duplicate address data from SQLite database...")
    try:
        warnings_data = extract_warnings_from_db(db_path)
        duplicates_data = extract_duplicates_from_db(db_path)

        # Merge duplicates as a category key inside warnings_data for each postcode area
        for pa_key, dup_groups in duplicates_data.items():
            if pa_key not in warnings_data:
                warnings_data[pa_key] = {
                    'unusual_city': [],
                    'unusual_suburb': [],
                    'unusual_street': [],
                    'unusual_housenumber': [],
                    'unusual_housename': [],
                    'unusual_address_tag': [],
                    'duplicates': []
                }
            warnings_data[pa_key]['duplicates'] = dup_groups

        for pa_key in warnings_data:
            if 'duplicates' not in warnings_data[pa_key]:
                warnings_data[pa_key]['duplicates'] = []

        warnings_json_path = os.path.join(OUTPUT_DIR, "warnings.json")
        with open(warnings_json_path, 'w', encoding='utf-8') as f:
            json.dump(warnings_data, f, separators=(',', ':'))
        logging.info(f"Saved combined QA warnings & duplicate data to {warnings_json_path}.")
    except Exception as e:
        logging.error(f"Failed to extract QA warnings/duplicates data: {e}")

    # Collect stats if today is Saturday
    now_utc = datetime.now(timezone.utc)
    if should_collect_stats(now_utc):
        if os.path.exists(active_pbf_file):
            pbf_mtime = os.path.getmtime(active_pbf_file)
            pbf_dt = datetime.fromtimestamp(pbf_mtime, tz=timezone.utc)
            date_str = pbf_dt.strftime("%Y-%m-%d")
        else:
            date_str = now_utc.strftime("%Y-%m-%d")

        logging.info(f"Today is Saturday. Calculating and saving stats snapshot for {date_str}...")
        try:
            stats = calculate_stats_from_db(db_path)
            save_stats_snapshot(stats, date_str)
        except Exception as e:
            logging.error(f"Failed to calculate or save stats snapshot: {e}")
    else:
        logging.info("Not Saturday. Skipping stats snapshot collection.")

    conn.close()

    if os.path.exists(active_pbf_file):
        logging.info(f"Removing downloaded PBF file {active_pbf_file} to free up space...")
        os.remove(active_pbf_file)

    total_tasks = len(standard_pas) + len(no_postcode_tasks)
    logging.info(f"Found {len(standard_pas)} standard postcode areas and {len(no_postcode_tasks)} 'No postcode' sub-partition task chunks ({total_tasks} total tasks) to process in parallel...")

    root_tuples = []
    root_search_index = []

    points_files = []
    hulls_files_by_level: dict[str, list[str]] = {
        'postcode_area': [],
        'city': [],
        'suburb': [],
        'street': []
    }

    # Accumulators for No Postcode results across letter keys and chunks
    no_postcode_raw_city_items: dict[str, list[list[Any]]] = {}  # { city_child_id: list of city tuples }
    no_postcode_raw_suburbs_dict: dict[str, dict[str, list[list[Any]]]] = {}  # { letter_key: { city_child_id: list of suburb tuples } }
    no_postcode_search_indices = []
    no_postcode_sector_points_acc: dict[str, dict[str, list[list[Any]]]] = {}  # { sector_id: { street_id: points_tuples } }

    max_workers = min(os.cpu_count() or 2, 4)
    logging.info(f"Processing tasks using ProcessPoolExecutor with {max_workers} workers...")

    task_idx = 1
    with ProcessPoolExecutor(max_workers=max_workers) as executor:
        futures = {}

        for letter_key, city_names, chunk_idx, total_chunks, bounds_list in no_postcode_tasks:
            arg = (letter_key, city_names, chunk_idx, total_chunks, bounds_list, task_idx, total_tasks, db_path, OUTPUT_DIR)
            futures[executor.submit(process_no_postcode_sub_partition_worker, arg)] = ('no_postcode', f"{letter_key}_chunk{chunk_idx}")
            task_idx += 1

        for pa in standard_pas:
            arg = (pa, task_idx, total_tasks, db_path, OUTPUT_DIR)
            futures[executor.submit(process_postcode_area_worker, arg)] = ('standard', pa)
            task_idx += 1

        for future in as_completed(futures):
            task_type, task_label = futures[future]
            try:
                if task_type == 'standard':
                    pa_res, pa_root_search, points_path, hulls_paths = future.result()
                    if pa_res:
                        root_tuples.extend(pa_res)
                    if pa_root_search:
                        root_search_index.extend(pa_root_search)
                    if os.path.exists(points_path):
                        points_files.append(points_path)
                    if isinstance(hulls_paths, dict):
                        for lvl, hp in hulls_paths.items():
                            if os.path.exists(hp):
                                hulls_files_by_level[lvl].append(hp)
                else:
                    city_items, search_items, points_path, hulls_paths, letter_key, letter_suburbs_dict, sector_points_dict = future.result()

                    for item in city_items:
                        c_id = item[3]
                        no_postcode_raw_city_items.setdefault(c_id, []).append(item)

                    if letter_suburbs_dict:
                        letter_entry = no_postcode_raw_suburbs_dict.setdefault(letter_key, {})
                        for c_id, suburbs_tuples in letter_suburbs_dict.items():
                            letter_entry.setdefault(c_id, []).extend(suburbs_tuples)

                    if search_items:
                        no_postcode_search_indices.extend(search_items)

                    if sector_points_dict:
                        for sector_id, streets_dict in sector_points_dict.items():
                            sec_acc = no_postcode_sector_points_acc.setdefault(sector_id, {})
                            for street_id, pt_tuples in streets_dict.items():
                                sec_acc.setdefault(street_id, []).extend(pt_tuples)

                    if os.path.exists(points_path):
                        points_files.append(points_path)
                    if isinstance(hulls_paths, dict):
                        for lvl, hp in hulls_paths.items():
                            if os.path.exists(hp):
                                hulls_files_by_level[lvl].append(hp)
            except Exception as exc:
                logging.error(f"Task {task_type}:{task_label} generated an exception: {exc}")
                raise exc

    if os.path.exists(db_path):
        logging.info(f"Removing temporary SQLite database {db_path} to free up space...")
        os.remove(db_path)

    if has_no_postcode and no_postcode_raw_city_items:
        no_postcode_id = get_clean_id('root', 'No postcode')

        # Merge city tuples across spatial chunks
        merged_city_items = []
        for c_id, tuples_list in no_postcode_raw_city_items.items():
            if len(tuples_list) == 1:
                merged_city_items.append(tuples_list[0])
            else:
                merged_city_items.append(merge_city_tuples(tuples_list))

        no_postcode_cities_for_root_json = []
        total_count = 0
        total_addressed = 0
        min_x, min_y, max_x, max_y = float('inf'), float('inf'), float('-inf'), float('-inf')

        for item in merged_city_items:
            display_name, label, g_col, child_id, grp_total, addr_p, bbox_val = item[:7]
            total_count += grp_total
            total_addressed += int(round(grp_total * (addr_p / 100.0)))
            if bbox_val:
                min_x = min(min_x, bbox_val[0])
                min_y = min(min_y, bbox_val[1])
                max_x = max(max_x, bbox_val[2])
                max_y = max(max_y, bbox_val[3])
            no_postcode_cities_for_root_json.append([display_name, label, g_col, child_id, grp_total, addr_p, bbox_val])

        pa_addr_perc = int(round((total_addressed / total_count) * 100)) if total_count > 0 else 0
        pa_bbox = [round(min_x, 5), round(min_y, 5), round(max_x, 5), round(max_y, 5)] if min_x != float('inf') else [0, 0, 0, 0]

        no_postcode_pa_tuple = [
            "No postcode",
            "No postcode",
            "postcode_area",
            no_postcode_id,
            total_count,
            pa_addr_perc,
            pa_bbox
        ]
        root_tuples.append(no_postcode_pa_tuple)

        # Write data/{no_postcode_id}.json
        with open(f"{OUTPUT_DIR}/{no_postcode_id}.json", 'w', encoding='utf-8') as f:
            json.dump(no_postcode_cities_for_root_json, f, separators=(',', ':'))

        # Merge suburb tuples and write per-letter JSON files: data/{no_postcode_id}_{letter_key}.json
        for letter_key, city_suburbs_map in no_postcode_raw_suburbs_dict.items():
            merged_letter_dict = {}
            for c_id, raw_suburb_tuples in city_suburbs_map.items():
                suburb_groups: dict[str, list[list[Any]]] = {}
                for sub_tuple in raw_suburb_tuples:
                    sub_id = sub_tuple[3]
                    suburb_groups.setdefault(sub_id, []).append(sub_tuple)

                merged_suburbs = []
                for sub_id, sub_tuples in suburb_groups.items():
                    if len(sub_tuples) == 1:
                        merged_suburbs.append(sub_tuples[0])
                    else:
                        merged_suburbs.append(merge_suburb_tuples(sub_tuples))

                merged_letter_dict[c_id] = merged_suburbs

            with open(f"{OUTPUT_DIR}/{no_postcode_id}_{letter_key}.json", 'w', encoding='utf-8') as f:
                json.dump(merged_letter_dict, f, separators=(',', ':'))

        # Write aggregated sector points files for No postcode
        for sector_id, streets_dict in no_postcode_sector_points_acc.items():
            with open(os.path.join(OUTPUT_DIR, f"{sector_id}_points.json"), 'w', encoding='utf-8') as f:
                json.dump(streets_dict, f, separators=(',', ':'))

        # Write search index file for No postcode: search_index_{no_postcode_id}.json
        if no_postcode_search_indices:
            with open(f"{OUTPUT_DIR}/search_index_{no_postcode_id}.json", 'w', encoding='utf-8') as f:
                json.dump({"prefix": ["No postcode"], "items": no_postcode_search_indices}, f, separators=(',', ':'))

    geojson_level_paths = {
        'postcode_area': os.path.join(OUTPUT_DIR, "postcode_area.geojson"),
        'city': os.path.join(OUTPUT_DIR, "city.geojson"),
        'suburb': os.path.join(OUTPUT_DIR, "suburb.geojson"),
        'street': os.path.join(OUTPUT_DIR, "street.geojson"),
        'points': os.path.join(OUTPUT_DIR, "points.geojson")
    }

    # Aggregating top-level postcode_area hull feature for No postcode if present
    if has_no_postcode and no_postcode_raw_city_items:
        no_postcode_id = get_clean_id('root', 'No postcode')
        no_pc_pa_hulls_files = [hf for hf in hulls_files_by_level['postcode_area'] if os.path.basename(hf).startswith(f"hulls_{no_postcode_id}_")]
        no_pc_pa_geoms = []
        for hf in no_pc_pa_hulls_files:
            if os.path.exists(hf):
                with open(hf, 'r', encoding='utf-8') as f:
                    for line in f:
                        if line.strip():
                            feat = json.loads(line)
                            geom = shapely.geometry.shape(feat["geometry"])
                            no_pc_pa_geoms.append(geom)

        if no_pc_pa_geoms:
            logging.info(f"Combining {len(no_pc_pa_geoms)} city partition PA hulls to create top-level 'No postcode' postcode_area hull...")
            no_pc_union_geom = shapely.union_all(no_pc_pa_geoms)
            no_pc_union_geom = shapely.make_valid(no_pc_union_geom)

            pm_props = {
                "name": "No postcode",
                "raw_name": "No postcode",
                "level": "postcode_area",
                "child_id": no_postcode_id,
                "parent_id": "root"
            }
            assign_colours(pm_props, is_points_level=False)

            no_pc_pa_hull_feature = {
                "type": "Feature",
                "properties": pm_props,
                "geometry": no_pc_union_geom.__geo_interface__
            }

            # Filter out per-partition postcode_area hull files from hulls_files_by_level['postcode_area']
            hulls_files_by_level['postcode_area'] = [
                hf for hf in hulls_files_by_level['postcode_area'] if hf not in no_pc_pa_hulls_files
            ]

            # Write to a temporary hull file and add to postcode_area level files
            no_pc_pa_hull_file = os.path.join(OUTPUT_DIR, f"hulls_{no_postcode_id}_top_level_postcode_area.geojson")
            with open(no_pc_pa_hull_file, 'w', encoding='utf-8') as f:
                f.write(json.dumps(no_pc_pa_hull_feature) + "\n")
            hulls_files_by_level['postcode_area'].append(no_pc_pa_hull_file)

            for hf in no_pc_pa_hulls_files:
                if os.path.exists(hf):
                    os.remove(hf)

    logging.info("Combining points GeoJSON files...")
    with open(geojson_level_paths['points'], "w", encoding="utf-8") as f_out:
        for pf in points_files:
            if os.path.exists(pf):
                with open(pf, "r", encoding="utf-8") as f_in:
                    shutil.copyfileobj(f_in, f_out, 1024*1024)
                os.remove(pf)

    logging.info("Splitting and combining hull GeoJSON files by level...")
    for lvl in ('postcode_area', 'city', 'suburb', 'street'):
        target_path = geojson_level_paths[lvl]
        with open(target_path, "w", encoding="utf-8") as f_out:
            for hf in hulls_files_by_level.get(lvl, []):
                if os.path.exists(hf):
                    with open(hf, "r", encoding="utf-8") as f_in:
                        shutil.copyfileobj(f_in, f_out, 1024*1024)
                    os.remove(hf)

    logging.info("Saving root hierarchy and search index...")
    with open(f"{OUTPUT_DIR}/root.json", 'w', encoding='utf-8') as f:
        json.dump(root_tuples, f, separators=(',', ':'))

    with open(f"{OUTPUT_DIR}/search_index_root.json", 'w', encoding='utf-8') as f:
        json.dump(root_search_index, f, separators=(',', ':'))

    logging.info("Compiling layer PMTiles using tippecanoe...")
    timestamp_str = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")

    layer_configs = [
        {"level": "points", "min_zoom": 0, "max_zoom": 15},
        {"level": "postcode_area", "min_zoom": 0, "max_zoom": 14},
        {"level": "city", "min_zoom": 5, "max_zoom": 15},
        {"level": "suburb", "min_zoom": 5, "max_zoom": 15},
        {"level": "street", "min_zoom": 9, "max_zoom": 16},
    ]

    max_tp_workers = 5
    logging.info(f"Compiling 5 PMTiles layers in parallel using ProcessPoolExecutor ({max_tp_workers} workers)...")
    with ProcessPoolExecutor(max_workers=max_tp_workers) as executor:
        futures = [
            executor.submit(compile_single_layer_pmtiles, cfg, geojson_level_paths[cfg["level"]], timestamp_str, PMTILES_OUTPUT_DIR)
            for cfg in layer_configs
        ]
        for future in as_completed(futures):
            try:
                completed_lvl = future.result()
                logging.info(f"Completed PMTiles compilation for layer: {completed_lvl}")
            except Exception as e:
                logging.error(f"Failed PMTiles compilation task: {e}")

    logging.info("Cleaning up temporary GeoJSON files...")
    for path in geojson_level_paths.values():
        if os.path.exists(path):
            os.remove(path)

    logging.info("Done!")


if __name__ == "__main__":
    process()
