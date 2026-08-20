"""
Unit tests for dated PMTiles rendering and Cloudflare R2 cleanup logic.
"""

import os
import tempfile
import unittest
from datetime import datetime, timezone, timedelta
from unittest.mock import patch

from scripts.cleanup_r2 import (
    parse_file_timestamp,
    filter_files_for_deletion
)
from scripts.render import (
    get_pmtiles_filename_for_layer,
    get_pmtiles_urls
)


class TestCleanupR2(unittest.TestCase):
    """Tests for Cloudflare R2 cleanup and retention logic."""

    def test_parse_file_timestamp_from_filename(self) -> None:
        filename = "address_data_20250226_143000.pmtiles"
        mod_time = "2025-02-01T00:00:00Z"
        dt = parse_file_timestamp(filename, mod_time)
        self.assertEqual(dt, datetime(2025, 2, 26, 14, 30, 0, tzinfo=timezone.utc))

    def test_parse_file_timestamp_fallback(self) -> None:
        filename = "address_data_invalid.pmtiles"
        mod_time = "2025-02-26T14:30:00Z"
        dt = parse_file_timestamp(filename, mod_time)
        self.assertEqual(dt, datetime(2025, 2, 26, 14, 30, 0, tzinfo=timezone.utc))

    def test_filter_files_for_deletion(self) -> None:
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
        self.assertNotIn(f"address_data_{file1_time}.pmtiles", to_delete)
        self.assertNotIn(f"address_data_{file2_time}.pmtiles", to_delete)

        # File 3 (36h ago) and File 4 (48h ago) should be deleted
        self.assertIn(f"address_data_{file3_time}.pmtiles", to_delete)
        self.assertIn(f"address_data_{file4_time}.pmtiles", to_delete)

    def test_filter_files_retains_minimum_two(self) -> None:
        now = datetime.now(timezone.utc)

        # Two old files (> 24h)
        file1_time = (now - timedelta(days=5)).strftime("%Y%m%d_%H%M%S")
        file2_time = (now - timedelta(days=10)).strftime("%Y%m%d_%H%M%S")

        files = [
            {"Path": f"address_data_{file1_time}.pmtiles"},
            {"Path": f"address_data_{file2_time}.pmtiles"},
        ]

        to_delete = filter_files_for_deletion(files)
        self.assertEqual(to_delete, [])


class TestRenderPMTilesURL(unittest.TestCase):
    """Tests for PMTiles filename resolution and URL formatting."""

    def test_get_pmtiles_filename_for_layer(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = os.path.join(temp_dir, 'pmtiles')
            os.makedirs(data_dir, exist_ok=True)

            f1 = os.path.join(data_dir, 'city_20250101_100000.pmtiles')
            f2 = os.path.join(data_dir, 'city_20250226_150000.pmtiles')

            open(f1, 'w').close()
            open(f2, 'w').close()

            with patch('scripts.render.PUBLIC_DIRECTORY', temp_dir):
                filename = get_pmtiles_filename_for_layer('city')
                self.assertEqual(filename, 'city_20250226_150000.pmtiles')

    def test_get_pmtiles_urls_default(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            data_dir = os.path.join(temp_dir, 'pmtiles')
            os.makedirs(data_dir, exist_ok=True)
            f1 = os.path.join(data_dir, 'city_20250226_120000.pmtiles')
            open(f1, 'w').close()

            with patch('scripts.render.PUBLIC_DIRECTORY', temp_dir), \
                 patch.dict(os.environ, {}, clear=True):
                urls = get_pmtiles_urls()
                self.assertEqual(urls['city'], 'pmtiles/city_20250226_120000.pmtiles')



if __name__ == '__main__':
    unittest.main()
