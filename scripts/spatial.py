"""
Spatial processing, Voronoi clipping, hierarchy generation, and point pre-clustering algorithms.
"""
import json
import sqlite3
from typing import Any, Optional
import geopandas as gpd
import numpy as np
import pandas as pd
import shapely
from shapely.ops import transform

from config import (
    OUTPUT_DIR,
    TRANSFORMER_TO_4326,
    assign_colours,
    extract_postcode_sector,
    get_city_letter_key,
    get_clean_id,
    get_street_letter_key,
)


def prepare_points_for_tippecanoe(
    all_points: list[dict[str, Any]],
    parent_id_col: str = "parent_id",
    split_zoom: int = 15,
    max_zoom: int = 17
) -> list[tuple[dict[str, Any], dict[str, int], float, float]]:
    """Clusters address points in EPSG:27700 space for mid zoom tiers and returns pre-clustered point tuples.

    This is done here instead of front-end clustering so that points are only clustered by street.

    Args:
        all_points: List of point records containing 'props', 'x_proj', 'y_proj', 'lon', 'lat'.
        parent_id_col: Key in props containing parent street identifier.
        split_zoom: Minimum zoom level at which raw unclustered points are shown.
        max_zoom: Maximum zoom level for tile generation.

    Returns:
        list[tuple[dict[str, Any], dict[str, int], float, float]]: List of (props, tippecanoe_dict, lon, lat) tuples.
    """
    zoom_tiers: tuple[tuple[int, int, float], ...] = (
        (7, 7, 3000.0),
        (8, 8, 2000.0),
        (9, 9, 1300.0),
        (10, 10, 600.0),
        (11, 11, 350.0),
        (12, 12, 200.0),
        (13, 13, 150.0),
        (14, 14, 80.0),
    )

    n_all = len(all_points)
    if n_all == 0:
        return []

    x_coords = np.fromiter((p["x_proj"] for p in all_points), dtype=np.float64, count=n_all)
    y_coords = np.fromiter((p["y_proj"] for p in all_points), dtype=np.float64, count=n_all)
    lons_raw = np.fromiter((p["lon"] for p in all_points), dtype=np.float64, count=n_all)
    lats_raw = np.fromiter((p["lat"] for p in all_points), dtype=np.float64, count=n_all)

    records: list[dict[str, Any]] = [p["props"] for p in all_points]

    parent_id_to_indices: dict[str, list[int]] = {}
    for idx, rec in enumerate(records):
        parent_id_to_indices.setdefault(rec[parent_id_col], []).append(idx)

    pre_computed_bounds: dict[str, tuple[float, np.ndarray, np.ndarray]] = {}
    for parent_id, indices in parent_id_to_indices.items():
        if len(indices) > 2:
            pts_x: np.ndarray = x_coords[indices]
            pts_y: np.ndarray = y_coords[indices]
            min_x, min_y = pts_x.min(), pts_y.min()
            max_x, max_y = pts_x.max(), pts_y.max()
            dx, dy = max_x - min_x, max_y - min_y
            pre_computed_bounds[parent_id] = (dx * dx + dy * dy, pts_x, pts_y)

    output_rows: list[tuple[dict[str, Any], dict[str, int], float, float]] = []

    raw_tippecanoe = {"minzoom": split_zoom, "maxzoom": max_zoom}
    for idx in range(n_all):
        output_rows.append((records[idx], raw_tippecanoe, float(lons_raw[idx]), float(lats_raw[idx])))

    for tier_min, tier_max, eps in zoom_tiers:
        eps_sq: float = eps * eps
        tippecanoe_dict: dict[str, int] = {"minzoom": tier_min, "maxzoom": tier_max}

        tier_cluster_x: list[float] = []
        tier_cluster_y: list[float] = []
        tier_rows_pending_coords: list[tuple[dict[str, Any], dict[str, int]]] = []

        for parent_id, indices in parent_id_to_indices.items():
            n_pts: int = len(indices)
            if n_pts == 1:
                idx: int = indices[0]
                rec: dict[str, Any] = records[idx].copy()
                rec["point_count"] = 1
                rec["is_cluster"] = False
                output_rows.append((rec, tippecanoe_dict, float(lons_raw[idx]), float(lats_raw[idx])))
            elif n_pts == 2:
                idx0, idx1 = indices[0], indices[1]
                x0, y0 = x_coords[idx0], y_coords[idx0]
                x1, y1 = x_coords[idx1], y_coords[idx1]
                dx, dy = x0 - x1, y0 - y1
                if dx * dx + dy * dy <= eps_sq:
                    tier_cluster_x.append((x0 + x1) * 0.5)
                    tier_cluster_y.append((y0 + y1) * 0.5)
                    sample = records[idx0]
                    tier_rows_pending_coords.append(({
                        parent_id_col: parent_id,
                        "point_count": 2,
                        "is_cluster": True,
                        "level": "points",
                        "fillColour": sample.get("fillColour"),
                        "labelColour": sample.get("labelColour")
                    }, tippecanoe_dict))
                else:
                    for idx_i in indices:
                        rec = records[idx_i].copy()
                        rec.update({
                            parent_id_col: parent_id,
                            "point_count": 1,
                            "is_cluster": False,
                            "level": "points"
                        })
                        output_rows.append((rec, tippecanoe_dict, float(lons_raw[idx_i]), float(lats_raw[idx_i])))
            else:
                diag_sq, pts_x, pts_y = pre_computed_bounds[parent_id]
                sample_idx: int = indices[0]
                sample: dict[str, Any] = records[sample_idx]

                if diag_sq <= eps_sq:
                    tier_cluster_x.append(float(np.sum(pts_x) / n_pts))
                    tier_cluster_y.append(float(np.sum(pts_y) / n_pts))
                    tier_rows_pending_coords.append(({
                        parent_id_col: parent_id,
                        "point_count": n_pts,
                        "is_cluster": True,
                        "level": "points",
                        "fillColour": sample.get("fillColour"),
                        "labelColour": sample.get("labelColour")
                    }, tippecanoe_dict))
                else:
                    grid_size = eps
                    grid_x = np.floor(pts_x / grid_size).astype(int)
                    grid_y = np.floor(pts_y / grid_size).astype(int)

                    cell_keys = (grid_x.astype(np.int64) << 32) | (grid_y.astype(np.int64) & 0xFFFFFFFF)
                    sort_idx = np.argsort(cell_keys)
                    sorted_keys = cell_keys[sort_idx]

                    split_pos = np.where(sorted_keys[:-1] != sorted_keys[1:])[0] + 1
                    groups = np.split(sort_idx, split_pos)

                    for cell_indices in groups:
                        count = len(cell_indices)
                        c_sample_idx = indices[cell_indices[0]]
                        c_sample = records[c_sample_idx]

                        if count > 1:
                            tier_cluster_x.append(float(np.sum(pts_x[cell_indices]) / count))
                            tier_cluster_y.append(float(np.sum(pts_y[cell_indices]) / count))
                            tier_rows_pending_coords.append(({
                                parent_id_col: parent_id,
                                "point_count": count,
                                "is_cluster": True,
                                "level": "points",
                                "fillColour": c_sample.get("fillColour"),
                                "labelColour": c_sample.get("labelColour")
                            }, tippecanoe_dict))
                        else:
                            rec = c_sample.copy()
                            rec.update({
                                parent_id_col: parent_id,
                                "point_count": 1,
                                "is_cluster": False,
                                "level": "points"
                            })
                            output_rows.append((rec, tippecanoe_dict, float(lons_raw[c_sample_idx]), float(lats_raw[c_sample_idx])))

        if tier_cluster_x:
            c_lons, c_lats = TRANSFORMER_TO_4326.transform(np.array(tier_cluster_x), np.array(tier_cluster_y))
            for (rec, tip_d), lon_v, lat_v in zip(tier_rows_pending_coords, c_lons, c_lats):
                output_rows.append((rec, tip_d, float(lon_v), float(lat_v)))

    return output_rows


def get_nearby_buffer_points(
    df_target: pd.DataFrame,
    conn: sqlite3.Connection,
    buffer_dist: float = 2000.0,
    grid_size: float = 10000.0
) -> pd.DataFrame:
    """Queries SQLite for nearby spatial buffer points using localized grid bounding boxes.

    Prevents spatial query explosion when a postcode area contains distant outlier address points.

    Args:
        df_target: Target area addresses DataFrame containing 'x_proj' and 'y_proj'.
        conn: SQLite database connection.
        buffer_dist: Spatial buffer distance in EPSG:27700 meters.
        grid_size: Grid cell size for grouping target points.

    Returns:
        pd.DataFrame: DataFrame of nearby address records ('id', 'x_proj', 'y_proj').
    """
    if df_target.empty:
        return pd.DataFrame(columns=['id', 'x_proj', 'y_proj'])

    grid_x = np.floor(df_target['x_proj'] / grid_size).astype(int)
    grid_y = np.floor(df_target['y_proj'] / grid_size).astype(int)

    grid_df = df_target[['x_proj', 'y_proj']].copy()
    grid_df['gx'] = grid_x
    grid_df['gy'] = grid_y

    cell_bounds = grid_df.groupby(['gx', 'gy']).agg(
        x_min=('x_proj', 'min'),
        x_max=('x_proj', 'max'),
        y_min=('y_proj', 'min'),
        y_max=('y_proj', 'max')
    )

    query_results: list[pd.DataFrame] = []
    for row in cell_bounds.itertuples(index=False):
        x_min_b = row.x_min - buffer_dist
        x_max_b = row.x_max + buffer_dist
        y_min_b = row.y_min - buffer_dist
        y_max_b = row.y_max + buffer_dist

        df_sub = pd.read_sql_query(
            "SELECT id, x_proj, y_proj FROM addresses WHERE x_proj BETWEEN ? AND ? AND y_proj BETWEEN ? AND ?",
            conn,
            params=[x_min_b, x_max_b, y_min_b, y_max_b]
        )
        if not df_sub.empty:
            query_results.append(df_sub)

    if not query_results:
        return pd.DataFrame(columns=['id', 'x_proj', 'y_proj'])

    return pd.concat(query_results, ignore_index=True).drop_duplicates(subset=['id'])


def create_spatial_chunks(df_summary: pd.DataFrame, max_chunk_size: int = 40000, grid_resolution: float = 25000.0) -> list[list[tuple[float, float, float, float]]]:
    """Partitions spatial points into bounding box chunks of at most `max_chunk_size` points.

    Args:
        df_summary: DataFrame containing 'x_proj' and 'y_proj'.
        max_chunk_size: Maximum target points per spatial chunk task.
        grid_resolution: Size of 2D grid cells in projected EPSG:27700 meters.

    Returns:
        list[list[tuple[float, float, float, float]]]: List of chunk bounds lists.
    """
    if len(df_summary) <= max_chunk_size:
        return [[]]

    df_grid = df_summary[['x_proj', 'y_proj']].copy()
    df_grid['gx'] = np.floor(df_grid['x_proj'] / grid_resolution).astype(int)
    df_grid['gy'] = np.floor(df_grid['y_proj'] / grid_resolution).astype(int)

    cell_counts = df_grid.groupby(['gy', 'gx']).size().reset_index(name='count')

    chunks: list[list[tuple[float, float, float, float]]] = []
    current_chunk_bounds: list[tuple[float, float, float, float]] = []
    current_chunk_count = 0

    for row in cell_counts.itertuples(index=False):
        gy, gx, count = row.gy, row.gx, row.count
        b_box = (gx * grid_resolution, (gx + 1) * grid_resolution, gy * grid_resolution, (gy + 1) * grid_resolution)

        if current_chunk_count > 0 and current_chunk_count + count > max_chunk_size:
            chunks.append(current_chunk_bounds)
            current_chunk_bounds = []
            current_chunk_count = 0

        current_chunk_bounds.append(b_box)
        current_chunk_count += count

    if current_chunk_bounds:
        chunks.append(current_chunk_bounds)

    return chunks


def process_hierarchy(
    data_proj: gpd.GeoDataFrame,
    group_col: str,
    filename: str,
    next_col: Optional[str],
    parent_trail: Optional[list[str]] = None,
    all_points_acc: Optional[list[dict[str, Any]]] = None,
    all_hulls_acc: Optional[list[dict[str, Any]]] = None,
    root_search_acc: Optional[list[list[Any]]] = None,
    pa_search_acc: Optional[list[list[Any]]] = None,
    sector_points_acc: Optional[dict[str, dict[str, list[list[Any]]]]] = None,
    pa_label: str = ""
) -> list[dict[str, Any]]:
    """Recursive concave hull generation with buffer and Voronoi overlap clipping in EPSG:27700.

    Args:
        data_proj: Sub-selection GeoDataFrame in EPSG:27700.
        group_col: Column name to group features by at this level.
        filename: Target output file base identifier.
        next_col: Column name to group features by at child level.
        parent_trail: List of parent display labels for breadcrumbs/search indexing.
        all_points_acc: Accumulator list for point features.
        all_hulls_acc: Accumulator list for hull features.
        root_search_acc: Accumulator list for root search index.
        pa_search_acc: Accumulator list for postcode area search index.
        sector_points_acc: Accumulator dict for postcode sector points.
        pa_label: Postcode area display label for logging.

    Returns:
        list[dict[str, Any]]: List of feature property dictionaries.
    """
    if parent_trail is None:
        parent_trail = []
    if all_points_acc is None:
        all_points_acc = []
    if all_hulls_acc is None:
        all_hulls_acc = []
    if root_search_acc is None:
        root_search_acc = []
    if pa_search_acc is None:
        pa_search_acc = []
    if sector_points_acc is None:
        sector_points_acc = {}

    if group_col == 'street':
        groups = data_proj.groupby('street_key')
    elif group_col == 'suburb':
        groups = data_proj.groupby('suburb_key')
    else:
        groups = data_proj.groupby(group_col)

    features_for_json: list[dict[str, Any]] = []

    for label_key, group_data_proj in groups:
        if group_col in ('street', 'suburb'):
            label = label_key.split(':', 1)[1] if ':' in label_key else label_key
        else:
            label = label_key

        group_pts = shapely.MultiPoint(group_data_proj.geometry.values)

        hull = shapely.concave_hull(group_pts, ratio=0.5)

        buffer_dist = 1000.0
        if group_col == 'city':
            buffer_dist = 750.0
        if group_col == 'suburb':
            buffer_dist = 500.0
        if group_col == 'street':
            buffer_dist = 25.0

        buffered_hull = hull.buffer(buffer_dist)

        max_extent = shapely.union_all(shapely.buffer(group_data_proj.geometry.values, buffer_dist))

        if 'voronoi_cell' in group_data_proj.columns:
            cells = [c for c in group_data_proj['voronoi_cell'].values if c is not None]
            if cells:
                voronoi_region = shapely.union_all(cells)
                final_hull = buffered_hull.intersection(voronoi_region)
            else:
                final_hull = buffered_hull
        else:
            final_hull = buffered_hull

        final_hull = final_hull.intersection(max_extent)

        if final_hull.is_empty:
            final_hull = max_extent

        final_hull_4326 = transform(TRANSFORMER_TO_4326.transform, final_hull)
        final_hull_4326 = shapely.make_valid(final_hull_4326)

        if final_hull_4326.geom_type == 'GeometryCollection':
            polys = [g for g in final_hull_4326.geoms if g.geom_type in ('Polygon', 'MultiPolygon')]
            if polys:
                final_hull_4326 = shapely.unary_union(polys)
            else:
                final_hull_4326 = transform(TRANSFORMER_TO_4326.transform, max_extent)
        elif final_hull_4326.geom_type not in ('Polygon', 'MultiPolygon'):
            final_hull_4326 = transform(TRANSFORMER_TO_4326.transform, max_extent)

        final_hull_4326 = shapely.make_valid(final_hull_4326)

        group_total: int = len(group_data_proj)
        group_addressed: int = int(group_data_proj['is_addressed'].sum())
        addr_perc: int = int(round((group_addressed / group_total) * 100)) if group_total > 0 else 0

        current_trail: list[str] = parent_trail + [str(label)]

        child_id: Optional[str] = None
        child_res: Optional[list[dict[str, Any]]] = None
        street_sector_ids: set[str] = set()

        if next_col and next_col != 'points':
            next_map = {
                'city': 'suburb',
                'suburb': 'street',
                'street': 'points',
                'points': None
            }
            child_id = get_clean_id(filename, label_key)
            child_res = process_hierarchy(
                group_data_proj,
                next_col,
                child_id,
                next_map.get(next_col),
                parent_trail=current_trail,
                all_points_acc=all_points_acc,
                all_hulls_acc=all_hulls_acc,
                root_search_acc=root_search_acc,
                pa_search_acc=pa_search_acc,
                sector_points_acc=sector_points_acc,
                pa_label=pa_label
            )
        elif next_col == 'points':
            child_id = get_clean_id(filename, label_key)

            for row in group_data_proj.itertuples(index=False):
                pt_tags = json.loads(row.popup_tags) if isinstance(row.popup_tags, str) else (row.popup_tags if isinstance(row.popup_tags, dict) else {})
                floor = pt_tags.get('addr:floor', '').strip() if isinstance(pt_tags, dict) else ''
                unit = pt_tags.get('addr:unit', '').strip() if isinstance(pt_tags, dict) else ''
                flats = pt_tags.get('addr:flats', '').strip() if isinstance(pt_tags, dict) else ''
                name = pt_tags.get('addr:housename', '').strip() if isinstance(pt_tags, dict) else ''
                number = pt_tags.get('addr:housenumber', '').strip() if isinstance(pt_tags, dict) else ''

                name_num_part = ""
                if name and number:
                    name_num_part = f"{name}, {number}"
                elif name:
                    name_num_part = name
                elif number:
                    name_num_part = number

                addr_parts = []
                if floor:
                    addr_parts.append(f"Floor {floor}")
                if unit:
                    addr_parts.append(unit)
                if flats:
                    addr_parts.append(f"Flats {flats}")
                if name_num_part:
                    addr_parts.append(name_num_part)

                addr_label = ", ".join(addr_parts) if addr_parts else ""

                osm_name_val = str(getattr(row, 'osm_name', '') or '').strip()
                if osm_name_val:
                    if addr_label:
                        final_label = f"{osm_name_val}\n{addr_label}"
                    else:
                        final_label = osm_name_val
                else:
                    final_label = addr_label

                lon: float = row.lon
                lat: float = row.lat

                pt_tuple: list[Any] = [
                    final_label,
                    str(row.postcode),
                    str(row.osm_id),
                    [round(lon, 5), round(lat, 5)]
                ]

                if pa_label == 'No postcode':
                    city_name = current_trail[1] if len(current_trail) > 1 else ''
                    letter_key = get_city_letter_key(city_name)
                    if letter_key == 'no-city':
                        st_letter_key = get_street_letter_key(getattr(row, 'street', ''))
                        sector_id = f"{filename.split('_')[0]}_no-city_{st_letter_key}"
                    else:
                        sector_id = f"{filename.split('_')[0]}_{letter_key}"
                else:
                    sector_label = extract_postcode_sector(str(row.postcode))
                    sector_id = get_clean_id('root', sector_label)

                street_sector_ids.add(sector_id)

                if sector_id not in sector_points_acc:
                    sector_points_acc[sector_id] = {}
                if child_id not in sector_points_acc[sector_id]:
                    sector_points_acc[sector_id][child_id] = []

                sector_points_acc[sector_id][child_id].append(pt_tuple)

                pm_props: dict[str, Any] = {
                    "name": final_label,
                    "postcode": str(row.postcode),
                    "level": "points",
                    "parent_id": child_id,
                    "osm_id": str(row.osm_id),
                    "osm_name": osm_name_val,
                    "popup_tags": row.popup_tags if isinstance(row.popup_tags, str) else json.dumps(row.popup_tags)
                }
                assign_colours(pm_props, is_points_level=True)

                all_points_acc.append({
                    "props": pm_props,
                    "x_proj": float(row.x_proj),
                    "y_proj": float(row.y_proj),
                    "lon": lon,
                    "lat": lat
                })

        display_name: str = str(label)
        if group_col == 'street':
            display_name = f"{label}\n{addr_perc}%"

        bbox: list[float] = list(final_hull_4326.bounds)

        rounded_bbox = [round(x, 5) for x in bbox]
        item_tuple: list[Any] = [
            display_name,
            str(label),
            group_col,
            child_id,
            group_total,
            addr_perc,
            rounded_bbox
        ]

        if child_res is not None and group_col != 'postcode_area':
            item_tuple.append(child_res)
        elif group_col == 'street':
            item_tuple.append(sorted(list(street_sector_ids)))

        features_for_json.append(item_tuple)

        lower_label = str(label).strip().lower()
        if lower_label not in ('no postcode', 'no city', 'no suburb', 'no street', 'missing', 'unknown'):
            rounded_bbox = [round(x, 5) for x in bbox]

            if group_col in ('postcode_area', 'city'):
                root_search_acc.append([
                    child_id,
                    group_total,
                    current_trail,
                    rounded_bbox
                ])

            if child_id:
                pa_search_acc.append([
                    child_id,
                    group_total,
                    current_trail[1:],
                    rounded_bbox
                ])

        pm_props = {
            "name": display_name,
            "raw_name": str(label),
            "level": group_col,
            "child_id": child_id,
            "parent_id": filename
        }
        assign_colours(pm_props, is_points_level=False)

        all_hulls_acc.append({
            "type": "Feature",
            "properties": pm_props,
            "geometry": final_hull_4326.__geo_interface__
        })

    if group_col == 'city' and pa_label != 'No postcode':
        with open(f"{OUTPUT_DIR}/{filename}.json", 'w', encoding='utf-8') as f:
            json.dump(features_for_json, f, separators=(',', ':'))

    return features_for_json
