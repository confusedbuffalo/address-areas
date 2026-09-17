"""
Unit tests for dated PMTiles rendering and Cloudflare R2 cleanup logic.
"""

import os
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from scripts.cleanup_r2 import (
    parse_file_timestamp,
    filter_files_for_deletion,
    is_main_branch,
    cleanup,
)
from scripts.render import (
    get_pmtiles_filename_for_layer,
    get_pmtiles_urls,
)


def test_parse_file_timestamp_from_filename() -> None:
    filename = "address_data_20250226_143000.pmtiles"
    mod_time = "2025-02-01T00:00:00Z"
    dt = parse_file_timestamp(filename, mod_time)
    assert dt == datetime(2025, 2, 26, 14, 30, 0, tzinfo=timezone.utc)


def test_parse_file_timestamp_fallback() -> None:
    filename = "address_data_invalid.pmtiles"
    mod_time = "2025-02-26T14:30:00Z"
    dt = parse_file_timestamp(filename, mod_time)
    assert dt == datetime(2025, 2, 26, 14, 30, 0, tzinfo=timezone.utc)


def test_filter_files_for_deletion() -> None:
    now = datetime.now(timezone.utc)

    # Dates:
    # File 1: current (0 hours ago)
    # File 2: 12 hours ago (within 24h)
    # File 3: 36 hours ago (older than 24h, but top 3) -> should be deleted if top 2 kept
    # File 4: 48 hours ago -> should be deleted
    file1_time = now.strftime("%Y%m%d_%H%M%S")
    file2_time = (now - timedelta(hours=12)).strftime("%Y%m%d_%H%M%S")
    file3_time = (now - timedelta(hours=36)).strftime("%Y%m%d_%H%M%S")
    file4_time = (now - timedelta(hours=48)).strftime("%Y%m%d_%H%M%S")

    files = [
        {"Path": f"address_data_{file4_time}.pmtiles", "ModTime": (now - timedelta(hours=48)).isoformat()},
        {"Path": f"address_data_{file1_time}.pmtiles", "ModTime": now.isoformat()},
        {"Path": f"address_data_{file3_time}.pmtiles", "ModTime": (now - timedelta(hours=36)).isoformat()},
        {"Path": f"address_data_{file2_time}.pmtiles", "ModTime": (now - timedelta(hours=12)).isoformat()},
    ]

    to_delete = filter_files_for_deletion(files)

    # File 1 (newest) and File 2 (2nd newest) must be retained
    assert f"address_data_{file1_time}.pmtiles" not in to_delete
    assert f"address_data_{file2_time}.pmtiles" not in to_delete

    # File 3 (36h ago) and File 4 (48h ago) should be deleted
    assert f"address_data_{file3_time}.pmtiles" in to_delete
    assert f"address_data_{file4_time}.pmtiles" in to_delete


def test_filter_files_retains_minimum_two() -> None:
    now = datetime.now(timezone.utc)

    # Two old files (> 24h)
    file1_time = (now - timedelta(days=5)).strftime("%Y%m%d_%H%M%S")
    file2_time = (now - timedelta(days=10)).strftime("%Y%m%d_%H%M%S")

    files = [
        {"Path": f"address_data_{file1_time}.pmtiles"},
        {"Path": f"address_data_{file2_time}.pmtiles"},
    ]

    to_delete = filter_files_for_deletion(files)
    assert to_delete == []


def test_is_main_branch_with_ref_name(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_REF_NAME", "main")
    assert is_main_branch() is True

    monkeypatch.setenv("GITHUB_REF_NAME", "feature-branch")
    assert is_main_branch() is False


def test_is_main_branch_with_github_ref(monkeypatch) -> None:
    monkeypatch.setenv("GITHUB_REF_NAME", "")
    monkeypatch.setenv("GITHUB_REF", "refs/heads/main")
    assert is_main_branch() is True

    monkeypatch.setenv("GITHUB_REF_NAME", "")
    monkeypatch.setenv("GITHUB_REF", "refs/heads/feature")
    assert is_main_branch() is False


def test_cleanup_skips_on_non_main_branch() -> None:
    with patch("scripts.cleanup_r2.is_main_branch", return_value=False), \
         patch("scripts.cleanup_r2.get_r2_bucket_files") as mock_get_files:
        cleanup()
        mock_get_files.assert_not_called()


def test_get_pmtiles_filename_for_layer(tmp_path) -> None:
    data_dir = tmp_path / "pmtiles"
    data_dir.mkdir(parents=True, exist_ok=True)

    f1 = data_dir / "city_20250101_100000.pmtiles"
    f2 = data_dir / "city_20250226_150000.pmtiles"

    f1.write_text("data", encoding="utf-8")
    f2.write_text("data", encoding="utf-8")

    with patch("scripts.render.PUBLIC_DIRECTORY", str(tmp_path)):
        filename = get_pmtiles_filename_for_layer("city")
        assert filename == "city_20250226_150000.pmtiles"


def test_get_pmtiles_filename_for_street_layer_ignores_street_geom(tmp_path) -> None:
    data_dir = tmp_path / "pmtiles"
    data_dir.mkdir(parents=True, exist_ok=True)

    f1 = data_dir / "street_area_20250226_100000.pmtiles"
    f2 = data_dir / "street_geom_20250226_120000.pmtiles"

    f1.write_text("data", encoding="utf-8")
    f2.write_text("data", encoding="utf-8")

    with patch("scripts.render.PUBLIC_DIRECTORY", str(tmp_path)):
        street_fn = get_pmtiles_filename_for_layer("street_area")
        street_geom_fn = get_pmtiles_filename_for_layer("street_geom")
        assert street_fn == "street_area_20250226_100000.pmtiles"
        assert street_geom_fn == "street_geom_20250226_120000.pmtiles"


def test_get_pmtiles_urls_default(tmp_path, monkeypatch) -> None:
    data_dir = tmp_path / "pmtiles"
    data_dir.mkdir(parents=True, exist_ok=True)
    f1 = data_dir / "city_20250226_120000.pmtiles"
    f1.write_text("data", encoding="utf-8")

    monkeypatch.delenv("PMTILES_URL_PREFIX", raising=False)
    with patch("scripts.render.PUBLIC_DIRECTORY", str(tmp_path)):
        urls = get_pmtiles_urls()
        assert urls["city"] == "pmtiles/city_20250226_120000.pmtiles"
