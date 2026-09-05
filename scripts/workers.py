"""
Multiprocessing workers and tuple merging utilities for parallel postcode area processing.
"""
import json
import logging
import os
import sqlite3
from typing import Any
import geopandas as gpd
import pandas as pd
import shapely

from config import get_clean_id
from spatial import (
    get_nearby_buffer_points,
    prepare_points_for_tippecanoe,
    process_hierarchy,
)


def merge_street_tuples(tuples_list: list[list[Any]]) -> list[Any]:
    """Merges multiple street tuples for the same street child_id across spatial chunks."""
    base = list(tuples_list[0])
    display_name, label, g_col, child_id, total_count, addr_p, bbox_val = base[:7]

    total_addressed = int(round(total_count * (addr_p / 100.0)))
    min_x, min_y, max_x, max_y = bbox_val[0], bbox_val[1], bbox_val[2], bbox_val[3]
    all_sector_ids = set(base[7]) if len(base) > 7 and isinstance(base[7], list) else set()

    for t in tuples_list[1:]:
        t_count = t[4]
        t_addr_p = t[5]
        t_bbox = t[6]
        total_count += t_count
        total_addressed += int(round(t_count * (t_addr_p / 100.0)))
        if t_bbox:
            min_x = min(min_x, t_bbox[0])
            min_y = min(min_y, t_bbox[1])
            max_x = max(max_x, t_bbox[2])
            max_y = max(max_y, t_bbox[3])
        if len(t) > 7 and isinstance(t[7], list):
            all_sector_ids.update(t[7])

    merged_addr_p = int(round((total_addressed / total_count) * 100)) if total_count > 0 else 0
    merged_bbox = [round(min_x, 5), round(min_y, 5), round(max_x, 5), round(max_y, 5)]
    merged_display_name = f"{label}\n{merged_addr_p}%"

    return [merged_display_name, label, g_col, child_id, total_count, merged_addr_p, merged_bbox, sorted(list(all_sector_ids))]


def merge_suburb_tuples(tuples_list: list[list[Any]]) -> list[Any]:
    """Merges multiple suburb tuples for the same suburb child_id across spatial chunks."""
    base = list(tuples_list[0])
    display_name, label, g_col, child_id = base[:4]

    street_groups: dict[str, list[list[Any]]] = {}
    total_count = 0
    total_addressed = 0
    min_x, min_y, max_x, max_y = float('inf'), float('inf'), float('-inf'), float('-inf')

    for t in tuples_list:
        t_count = t[4]
        t_addr_p = t[5]
        t_bbox = t[6]
        total_count += t_count
        total_addressed += int(round(t_count * (t_addr_p / 100.0)))
        if t_bbox:
            min_x = min(min_x, t_bbox[0])
            min_y = min(min_y, t_bbox[1])
            max_x = max(max_x, t_bbox[2])
            max_y = max(max_y, t_bbox[3])
        if len(t) > 7 and isinstance(t[7], list):
            for st_tuple in t[7]:
                st_id = st_tuple[3]
                street_groups.setdefault(st_id, []).append(st_tuple)

    merged_streets = []
    for st_id, st_tuples in street_groups.items():
        if len(st_tuples) == 1:
            merged_streets.append(st_tuples[0])
        else:
            merged_streets.append(merge_street_tuples(st_tuples))

    merged_addr_p = int(round((total_addressed / total_count) * 100)) if total_count > 0 else 0
    merged_bbox = [round(min_x, 5), round(min_y, 5), round(max_x, 5), round(max_y, 5)] if min_x != float('inf') else [0, 0, 0, 0]

    return [label, label, g_col, child_id, total_count, merged_addr_p, merged_bbox, merged_streets]


def merge_city_tuples(tuples_list: list[list[Any]]) -> list[Any]:
    """Merges multiple city tuples for the same city child_id across spatial chunks."""
    base = list(tuples_list[0])
    display_name, label, g_col, child_id = base[:4]

    total_count = 0
    total_addressed = 0
    min_x, min_y, max_x, max_y = float('inf'), float('inf'), float('-inf'), float('-inf')

    for t in tuples_list:
        t_count = t[4]
        t_addr_p = t[5]
        t_bbox = t[6]
        total_count += t_count
        total_addressed += int(round(t_count * (t_addr_p / 100.0)))
        if t_bbox:
            min_x = min(min_x, t_bbox[0])
            min_y = min(min_y, t_bbox[1])
            max_x = max(max_x, t_bbox[2])
            max_y = max(max_y, t_bbox[3])

    merged_addr_p = int(round((total_addressed / total_count) * 100)) if total_count > 0 else 0
    merged_bbox = [round(min_x, 5), round(min_y, 5), round(max_x, 5), round(max_y, 5)] if min_x != float('inf') else [0, 0, 0, 0]

    return [label, label, g_col, child_id, total_count, merged_addr_p, merged_bbox]


def _write_points_geojson_file(output_rows: list[tuple[dict[str, Any], dict[str, int], float, float]], file_path: str) -> None:
    """Helper to stream pre-clustered GeoJSON points directly to disk."""
    with open(file_path, 'w', encoding='utf-8') as f_points:
        for props, tippecanoe_opts, lon, lat in output_rows:
            feature = {
                "type": "Feature",
                "properties": props,
                "geometry": {"type": "Point", "coordinates": [round(lon, 5), round(lat, 5)]}
            }
            if tippecanoe_opts:
                feature["tippecanoe"] = tippecanoe_opts
            f_points.write(json.dumps(feature, separators=(',', ':')) + "\n")


def process_no_postcode_sub_partition_worker(
    args: tuple[str, list[str], int, int, list[tuple[float, float, float, float]], int, int, str, str]
) -> tuple[list[Any], list[Any], str, str, str, dict[str, Any], dict[str, dict[str, list[Any]]]]:
    """Worker task for processing a spatial chunk or sub-partition of the 'No postcode' area by city letter key.

    Args:
        args: Tuple of (letter_key, city_names, chunk_idx, total_chunks, bounds_list, idx, total_tasks, db_path, output_dir).

    Returns:
        tuple: (city_items, search_items, points_part_path, hulls_part_path, letter_key, letter_suburbs_dict, sector_points_dict).
    """
    letter_key, city_names, chunk_idx, total_chunks, bounds_list, idx, total_tasks, db_path, output_dir = args
    pa = 'No postcode'
    pa_id = get_clean_id('root', pa)

    chunk_suffix = f"_chunk{chunk_idx}" if total_chunks > 1 else ""
    points_part_path = os.path.join(output_dir, f"points_{pa_id}_{letter_key}{chunk_suffix}.geojson")
    hulls_part_path = os.path.join(output_dir, f"hulls_{pa_id}_{letter_key}{chunk_suffix}.geojson")

    try:
        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

        where_clauses = ["postcode_area = 'No postcode'"]
        params: list[Any] = []

        if letter_key == 'no-city':
            where_clauses.append("(city IS NULL OR LOWER(TRIM(city)) IN ('', 'no city', 'missing', 'unknown'))")
        else:
            placeholders = ', '.join(['?'] * len(city_names))
            where_clauses.append(f"city IN ({placeholders})")
            params.extend(city_names)

        if bounds_list:
            spatial_ors = []
            for b in bounds_list:
                spatial_ors.append("(x_proj BETWEEN ? AND ? AND y_proj BETWEEN ? AND ?)")
                params.extend([b[0], b[1], b[2], b[3]])
            where_clauses.append(f"({' OR '.join(spatial_ors)})")

        query = f"SELECT * FROM addresses WHERE {' AND '.join(where_clauses)}"

        df_target = pd.read_sql_query(query, conn, params=params)
        if df_target.empty:
            conn.close()
            return [], [], points_part_path, hulls_part_path, letter_key, {}, {}

        df_nearby = get_nearby_buffer_points(df_target, conn, buffer_dist=2000.0, grid_size=10000.0)
        conn.close()

        chunk_label = f" (chunk {chunk_idx + 1}/{total_chunks})" if total_chunks > 1 else ""
        logging.info(f"[{idx}/{total_tasks}] [No postcode - {letter_key}{chunk_label}] Calculating clipped Voronoi cells ({len(df_target)} target points, {len(df_nearby)} nearby spatial buffer points)...")

        gdf_target = gpd.GeoDataFrame(
            df_target,
            geometry=gpd.points_from_xy(df_target.x_proj, df_target.y_proj),
            crs="EPSG:27700"
        )

        df_unique = df_nearby.drop_duplicates(subset=['x_proj', 'y_proj'])
        unique_coords_gdf = gpd.GeoDataFrame(
            df_unique,
            geometry=gpd.points_from_xy(df_unique.x_proj, df_unique.y_proj),
            crs="EPSG:27700"
        )
        unique_coords_list = list(unique_coords_gdf.geometry.values)

        gdf_target['voronoi_cell'] = None

        if len(unique_coords_list) >= 2:
            unique_coords_gdf['pt_x'] = unique_coords_gdf.geometry.x
            unique_coords_gdf['pt_y'] = unique_coords_gdf.geometry.y

            voronoi_collection = shapely.voronoi_polygons(shapely.MultiPoint(unique_coords_list))
            voronoi_gdf = gpd.GeoDataFrame(geometry=list(voronoi_collection.geoms), crs="EPSG:27700")

            joined = gpd.sjoin(voronoi_gdf, unique_coords_gdf, how="inner", predicate="intersects")
            coord_to_cell = dict(zip(zip(joined['pt_x'], joined['pt_y']), joined['geometry']))

            gdf_target['voronoi_cell'] = [
                coord_to_cell.get((x, y)) for x, y in zip(gdf_target.geometry.x, gdf_target.geometry.y)
            ]

        all_points_part = []
        all_hulls_part = []
        pa_search_indices = []
        root_search_indices = []
        sector_points_dict = {}

        # Process hierarchy starting at 'city' level for this partition
        city_items = process_hierarchy(
            gdf_target,
            'city',
            pa_id,
            'suburb',
            parent_trail=[pa],
            all_points_acc=all_points_part,
            all_hulls_acc=all_hulls_part,
            root_search_acc=root_search_indices,
            pa_search_acc=pa_search_indices,
            sector_points_acc=sector_points_dict,
            pa_label=pa
        )

        letter_suburbs_dict = {}
        for item in city_items:
            child_id = item[3]
            suburbs_res = item[7] if len(item) > 7 else []
            letter_suburbs_dict[child_id] = suburbs_res

        hulls_by_lvl: dict[str, list[dict[str, Any]]] = {}
        for hull_feat in all_hulls_part:
            lvl = hull_feat.get("properties", {}).get("level")
            if lvl:
                hulls_by_lvl.setdefault(lvl, []).append(hull_feat)

        hulls_part_paths: dict[str, str] = {}
        for lvl, feats in hulls_by_lvl.items():
            lvl_path = os.path.join(output_dir, f"hulls_{pa_id}_{letter_key}{chunk_suffix}_{lvl}.geojson")
            with open(lvl_path, 'w', encoding='utf-8') as f_hulls:
                for hull_feat in feats:
                    f_hulls.write(json.dumps(hull_feat) + "\n")
            hulls_part_paths[lvl] = lvl_path

        if all_points_part:
            logging.info(f"[No postcode - {letter_key}{chunk_label}] Running point pre-clustering for Tippecanoe ({len(all_points_part)} address points)...")
            processed_rows = prepare_points_for_tippecanoe(
                all_points_part,
                parent_id_col="parent_id",
                split_zoom=15,
                max_zoom=17
            )

            _write_points_geojson_file(processed_rows, points_part_path)

        return city_items, pa_search_indices, points_part_path, hulls_part_paths, letter_key, letter_suburbs_dict, sector_points_dict
    except Exception as e:
        logging.error(f"[No postcode - {letter_key}{chunk_label}] Exception occurred during processing: {e}", exc_info=True)
        raise e


def process_postcode_area_worker(args: tuple[str, int, int, str, str]) -> tuple[list[Any], list[Any], str, str]:
    """Worker task for processing a single standard postcode area in a separate process.

    Args:
        args: Tuple of (pa, idx, total_pas, db_path, output_dir).

    Returns:
        tuple: (pa_tuples, pa_root_search, points_pa_path, hulls_pa_path).
    """
    pa, idx, total_pas, db_path, output_dir = args

    try:
        pa_id = get_clean_id('root', pa)

        points_pa_path = os.path.join(output_dir, f"points_{pa_id}.geojson")
        hulls_pa_path = os.path.join(output_dir, f"hulls_{pa_id}.geojson")

        conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)

        df_target = pd.read_sql_query("SELECT * FROM addresses WHERE postcode_area = ?", conn, params=[pa])
        if df_target.empty:
            conn.close()
            return [], [], points_pa_path, hulls_pa_path

        df_nearby = get_nearby_buffer_points(df_target, conn, buffer_dist=2000.0, grid_size=10000.0)
        conn.close()

        logging.info(f"[{idx}/{total_pas}] [{pa}] Calculating clipped Voronoi cells ({len(df_target)} target points, {len(df_nearby)} nearby spatial buffer points)...")

        gdf_target = gpd.GeoDataFrame(
            df_target,
            geometry=gpd.points_from_xy(df_target.x_proj, df_target.y_proj),
            crs="EPSG:27700"
        )

        df_unique = df_nearby.drop_duplicates(subset=['x_proj', 'y_proj'])
        unique_coords_gdf = gpd.GeoDataFrame(
            df_unique,
            geometry=gpd.points_from_xy(df_unique.x_proj, df_unique.y_proj),
            crs="EPSG:27700"
        )
        unique_coords_list = list(unique_coords_gdf.geometry.values)

        gdf_target['voronoi_cell'] = None

        if len(unique_coords_list) >= 2:
            unique_coords_gdf['pt_x'] = unique_coords_gdf.geometry.x
            unique_coords_gdf['pt_y'] = unique_coords_gdf.geometry.y

            voronoi_collection = shapely.voronoi_polygons(shapely.MultiPoint(unique_coords_list))
            voronoi_gdf = gpd.GeoDataFrame(geometry=list(voronoi_collection.geoms), crs="EPSG:27700")

            joined = gpd.sjoin(voronoi_gdf, unique_coords_gdf, how="inner", predicate="intersects")
            coord_to_cell = dict(zip(zip(joined['pt_x'], joined['pt_y']), joined['geometry']))

            gdf_target['voronoi_cell'] = [
                coord_to_cell.get((x, y)) for x, y in zip(gdf_target.geometry.x, gdf_target.geometry.y)
            ]

        all_points_pa = []
        all_hulls_pa = []
        pa_search_indices = []
        root_search_indices = []
        sector_points_dict = {}

        pa_res = process_hierarchy(
            gdf_target,
            'postcode_area',
            'root',
            'city',
            parent_trail=[],
            all_points_acc=all_points_pa,
            all_hulls_acc=all_hulls_pa,
            root_search_acc=root_search_indices,
            pa_search_acc=pa_search_indices,
            sector_points_acc=sector_points_dict,
            pa_label=pa
        )

        if pa_search_indices:
            with open(os.path.join(output_dir, f"search_index_{pa_id}.json"), 'w', encoding='utf-8') as f:
                json.dump({"prefix": [pa], "items": pa_search_indices}, f, separators=(',', ':'))

        for sector_id, streets_dict in sector_points_dict.items():
            with open(os.path.join(output_dir, f"{sector_id}_points.json"), 'w', encoding='utf-8') as f:
                json.dump(streets_dict, f, separators=(',', ':'))

        hulls_by_lvl: dict[str, list[dict[str, Any]]] = {}
        for hull_feat in all_hulls_pa:
            lvl = hull_feat.get("properties", {}).get("level")
            if lvl:
                hulls_by_lvl.setdefault(lvl, []).append(hull_feat)

        hulls_pa_paths: dict[str, str] = {}
        for lvl, feats in hulls_by_lvl.items():
            lvl_path = os.path.join(output_dir, f"hulls_{pa_id}_{lvl}.geojson")
            with open(lvl_path, 'w', encoding='utf-8') as f_hulls:
                for hull_feat in feats:
                    f_hulls.write(json.dumps(hull_feat) + "\n")
            hulls_pa_paths[lvl] = lvl_path

        if all_points_pa:
            logging.info(f"[{pa}] Running point pre-clustering for Tippecanoe ({len(all_points_pa)} address points)...")
            processed_rows = prepare_points_for_tippecanoe(
                all_points_pa,
                parent_id_col="parent_id",
                split_zoom=15,
                max_zoom=17
            )

            _write_points_geojson_file(processed_rows, points_pa_path)

        return pa_res, root_search_indices, points_pa_path, hulls_pa_paths
    except Exception as e:
        logging.error(f"[{pa}] Exception occurred during processing: {e}", exc_info=True)
        raise e
