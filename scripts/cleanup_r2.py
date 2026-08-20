"""
Cleans up old PMTiles files on Cloudflare R2 while retaining files within 24 hours and at least the 2 most recent files.
"""

import os
import sys
import json
import logging
import subprocess
from datetime import datetime, timezone, timedelta

logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')


def get_r2_bucket_files(bucket_name: str) -> list[dict[str, str]]:
    """Lists JSON file objects from Cloudflare R2 bucket using rclone.

    Args:
        bucket_name: Cloudflare R2 bucket name.

    Returns:
        list[dict[str, str]]: List of object dicts containing 'Path' and 'ModTime'.
    """
    cmd = ["rclone", "lsjson", f"r2:{bucket_name}"]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, check=True)
        files = json.loads(result.stdout)
        return files
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to list files from R2 bucket {bucket_name}: {e.stderr}")
        raise
    except json.JSONDecodeError as e:
        logging.error(f"Failed to parse JSON output from rclone lsjson: {e}")
        raise


import re

TIMESTAMP_REGEX = re.compile(r'(\d{8}_\d{6})\.pmtiles$')


def parse_file_timestamp(filename: str, mod_time_str: str) -> datetime:
    """Parses datetime from filename timestamp ({layer}_YYYYMMDD_HHMMSS.pmtiles) or fallbacks to ModTime.

    Args:
        filename: Name of the PMTiles file.
        mod_time_str: ISO modification time string from rclone.

    Returns:
        datetime: UTC datetime object.
    """
    base_name = os.path.basename(filename)
    match = TIMESTAMP_REGEX.search(base_name)
    if match:
        try:
            return datetime.strptime(match.group(1), "%Y%m%d_%H%M%S").replace(tzinfo=timezone.utc)
        except ValueError:
            pass

    # Fallback to ISO mod time
    try:
        clean_time = mod_time_str.split('.')[0] if '.' in mod_time_str else mod_time_str.rstrip('Z')
        return datetime.strptime(clean_time, "%Y-%m-%dT%H:%M:%S").replace(tzinfo=timezone.utc)
    except Exception as e:
        logging.warning(f"Failed to parse timestamp for {filename}: {e}. Using current time as fallback.")
        return datetime.now(timezone.utc)


def filter_files_for_deletion(files: list[dict[str, str]]) -> list[str]:
    """Identifies old PMTiles files eligible for deletion.

    Retention rule:
    - Group files by build timestamp.
    - Keep any build set created/dated within the previous 24 hours.
    - Keep at least the 2 most recent full build sets.
    - Delete files belonging to builds older than 24 hours that are not among the top 2 newest builds.

    Args:
        files: List of file dictionaries from R2 bucket listing.

    Returns:
        list[str]: File paths marked for deletion.
    """
    pmtiles_files = [f for f in files if f.get("Path", "").endswith(".pmtiles")]

    build_groups: dict[datetime, list[str]] = {}
    for f in pmtiles_files:
        path = f["Path"]
        mod_time_str = f.get("ModTime", "")
        dt = parse_file_timestamp(path, mod_time_str)
        build_groups.setdefault(dt, []).append(path)

    unique_timestamps = sorted(build_groups.keys(), reverse=True)
    if len(unique_timestamps) <= 2 and len(pmtiles_files) <= 10:
        logging.info("Two or fewer PMTiles build sets found on R2. No cleanup required.")
        return []

    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=1)

    to_delete = []

    for idx, dt in enumerate(unique_timestamps):
        paths = build_groups[dt]
        # Keep at least the 2 most recent build sets
        if idx < 2:
            logging.info(f"Retaining {len(paths)} file(s) for recent build timestamp {dt.isoformat()} (build #{idx + 1}).")
            continue

        # Keep builds within the 24-hour window
        if dt >= cutoff:
            logging.info(f"Retaining {len(paths)} file(s) for build timestamp {dt.isoformat()} (within 24-hour window).")
            continue

        # Otherwise mark all files in this build for deletion
        to_delete.extend(paths)

    return to_delete


def delete_r2_file(bucket_name: str, file_path: str) -> None:
    """Deletes a file from Cloudflare R2 bucket using rclone deletefile.

    Args:
        bucket_name: Cloudflare R2 bucket name.
        file_path: Path of file inside the bucket.
    """
    cmd = ["rclone", "deletefile", f"r2:{bucket_name}/{file_path}"]
    logging.info(f"Deleting old PMTiles file from R2: {file_path}")
    try:
        subprocess.run(cmd, check=True)
        logging.info(f"Successfully deleted {file_path}")
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to delete {file_path} from R2: {e}")


def cleanup() -> None:
    """Main execution function to list, filter and delete expired R2 PMTiles files."""
    bucket_name = os.getenv("R2_BUCKET_NAME")
    if not bucket_name:
        logging.warning("R2_BUCKET_NAME environment variable not set. Skipping R2 cleanup.")
        return

    logging.info(f"Scanning Cloudflare R2 bucket '{bucket_name}' for PMTiles cleanup...")
    files = get_r2_bucket_files(bucket_name)
    to_delete = filter_files_for_deletion(files)

    if not to_delete:
        logging.info("No expired PMTiles files to clean up.")
        return

    logging.info(f"Found {len(to_delete)} expired PMTiles file(s) to delete.")
    for file_path in to_delete:
        delete_r2_file(bucket_name, file_path)

    logging.info("R2 cleanup complete.")


if __name__ == "__main__":
    cleanup()
