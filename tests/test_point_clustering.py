"""
Unit tests for prepare_points_for_tippecanoe and _write_points_geojson_file in scripts/spatial.py and scripts/workers.py.
"""

import json
import os
import pytest
from scripts.spatial import prepare_points_for_tippecanoe
from scripts.workers import _write_points_geojson_file


def test_prepare_points_for_tippecanoe_empty() -> None:
    """Tests that empty points list returns empty list."""
    res = prepare_points_for_tippecanoe([])
    assert res == []


def test_prepare_points_for_tippecanoe_and_write_geojson(tmp_path) -> None:
    """Tests point pre-clustering tiers and GeoJSON output file writing."""
    all_points = [
        {
            "props": {
                "name": "1 High St",
                "postcode": "SW1A 1AA",
                "level": "points",
                "parent_id": "st_main",
                "osm_id": "n1",
                "fillColour": "#000000",
                "labelColour": "#ffffff"
            },
            "x_proj": 530000.0,
            "y_proj": 180000.0,
            "lon": -0.12,
            "lat": 51.50
        },
        {
            "props": {
                "name": "2 High St",
                "postcode": "SW1A 1AA",
                "level": "points",
                "parent_id": "st_main",
                "osm_id": "n2",
                "fillColour": "#000000",
                "labelColour": "#ffffff"
            },
            "x_proj": 530010.0,
            "y_proj": 180005.0,
            "lon": -0.119,
            "lat": 51.501
        }
    ]

    processed_rows = prepare_points_for_tippecanoe(all_points, parent_id_col="parent_id")
    assert len(processed_rows) > len(all_points)

    # Check raw points output tier
    raw_row = processed_rows[0]
    assert raw_row[0]["parent_id"] == "st_main"
    assert raw_row[1] == {"minzoom": 15, "maxzoom": 17}
    assert raw_row[2] == -0.12
    assert raw_row[3] == 51.50

    # Stream to temporary file and verify line-delimited GeoJSON structure
    out_file = tmp_path / "points.geojson"
    out_path = str(out_file)

    _write_points_geojson_file(processed_rows, out_path)
    assert os.path.exists(out_path) is True

    lines = []
    with open(out_path, "r", encoding="utf-8") as f:
        for line in f:
            if line.strip():
                feat = json.loads(line)
                lines.append(feat)

    assert len(lines) == len(processed_rows)
    first_feat = lines[0]
    assert first_feat["type"] == "Feature"
    assert "geometry" in first_feat
    assert first_feat["geometry"]["type"] == "Point"
    assert first_feat["geometry"]["coordinates"] == [-0.12, 51.5]
    assert "properties" in first_feat
    assert first_feat["properties"]["name"] == "1 High St"
