"""
Renders and compiles static assets (Tailwind CSS, esbuild JavaScript bundle, Jinja HTML template).
"""

from jinja2 import Environment, FileSystemLoader
import os
import sys
import glob
import json
import subprocess
import logging
import requests

BASE_DIR: str = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.join(BASE_DIR, 'scripts'))
from config import PBF_FILE

PUBLIC_DIRECTORY: str = os.path.join(BASE_DIR, 'dist')
CSS_FILE_PATH: str = os.path.join(BASE_DIR, 'input.css')
TEMPLATES_DIR: str = os.path.join(BASE_DIR, 'templates')
STATS_DIR: str = os.path.join(BASE_DIR, 'stats')

logging.basicConfig(level=logging.INFO, format='%(levelname)s - %(message)s')


def download_dependencies() -> None:
    """Downloads remote dependencies (MapLibre GL JS/CSS, PMTiles, Chart.js) and saves them to the public/libs directory."""
    dependencies: dict[str, str] = {
        "maplibre-gl.js": "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.js",
        "maplibre-gl.css": "https://unpkg.com/maplibre-gl@5/dist/maplibre-gl.css",
        "pmtiles.js": "https://unpkg.com/pmtiles@3/dist/pmtiles.js",
        "chart.js": "https://cdn.jsdelivr.net/npm/chart.js"
    }
    os.makedirs(os.path.join(PUBLIC_DIRECTORY, 'libs'), exist_ok=True)
    for filename, url in dependencies.items():
        filepath: str = os.path.join(PUBLIC_DIRECTORY, 'libs', filename)
        if os.path.exists(filepath):
            continue

        try:
            headers: dict[str, str] = {'User-Agent': 'Mozilla/5.0'}
            response = requests.get(url, headers=headers, timeout=15)
            response.raise_for_status()
            with open(filepath, 'wb') as f:
                f.write(response.content)
            logging.info(f"Successfully downloaded {filename}")
        except Exception as e:
            logging.error(f"Failed to download {filename}: {e}")


def build_tailwind() -> None:
    """Builds the minified Tailwind CSS output using Tailwind CLI."""
    logging.info("Building Tailwind CSS...")
    try:
        subprocess.run(
            ["npm", "install", "--no-save", "tailwindcss", "@tailwindcss/cli"],
            capture_output=True,
            text=True,
            check=True
        )
        result = subprocess.run(
            ["npx", "tailwindcss", "-i", CSS_FILE_PATH, "-o", os.path.join(PUBLIC_DIRECTORY, "styles.css"), "--minify"],
            capture_output=True,
            text=True,
            check=True
        )
        logging.info("Tailwind CSS built successfully.")
        if result.stderr:
            logging.debug(f"Tailwind CLI stderr: {result.stderr}")
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to build Tailwind CSS: {e.stderr}")
        raise
    except FileNotFoundError:
        logging.error("npx not found. Please ensure Node.js and npm are installed.")


LAYERS: list[str] = ['postcode_area', 'city', 'suburb', 'street', 'points']


def get_pmtiles_filename_for_layer(layer: str) -> str:
    """Finds the most recently created dated {layer}_*.pmtiles file in dist/pmtiles

    Returns:
        str: Dated filename or fallback default filename.
    """
    pmtiles_dir = os.path.join(PUBLIC_DIRECTORY, 'pmtiles')
    pattern = os.path.join(pmtiles_dir, f'{layer}_*.pmtiles')
    matches = sorted(glob.glob(pattern))
    if matches:
        return os.path.basename(matches[-1])
    return f'{layer}.pmtiles'


def get_initial_bounds() -> list[list[float]] | None:
    """Calculates overall bounding box covering all root features in dist/data/root.json if available.

    Returns:
        list[list[float]] | None: Bounding box [[minLng, minLat], [maxLng, maxLat]] or None.
    """
    root_path = os.path.join(PUBLIC_DIRECTORY, 'data', 'root.json')
    if not os.path.exists(root_path):
        return None
    try:
        with open(root_path, 'r', encoding='utf-8') as f:
            data = json.load(f)
        min_lng, min_lat = float('inf'), float('inf')
        max_lng, max_lat = float('-inf'), float('-inf')
        for item in data:
            if len(item) >= 7 and isinstance(item[6], list) and len(item[6]) == 4:
                b = item[6]
                min_lng = min(min_lng, b[0])
                min_lat = min(min_lat, b[1])
                max_lng = max(max_lng, b[2])
                max_lat = max(max_lat, b[3])
        if min_lng != float('inf'):
            return [[min_lng, min_lat], [max_lng, max_lat]]
    except Exception as e:
        logging.warning(f"Failed to calculate initial bounds from root.json: {e}")
    return None


def get_pmtiles_urls() -> dict[str, str]:
    """Resolves the PMTiles URLs for all layers for template rendering.

    Returns:
        dict[str, str]: Map from layer name to final resolved PMTiles URL.
    """
    return {
        layer: f"pmtiles/{get_pmtiles_filename_for_layer(layer)}"
        for layer in LAYERS
    }


def get_data_timestamp() -> int:
    """Gets the recorded timestamp from pbf_timestamp.txt or PBF file modification time in milliseconds.

    Returns:
        int: Unix timestamp in milliseconds.
    """
    ts_file_path = os.path.join(PUBLIC_DIRECTORY, 'data', 'pbf_timestamp.txt')
    if os.path.exists(ts_file_path):
        try:
            with open(ts_file_path, 'r', encoding='utf-8') as f:
                ts_str = f.read().strip()
                if ts_str:
                    logging.info(f"Using recorded timestamp from {ts_file_path}.")
                    return int(ts_str)
        except Exception as e:
            logging.warning(f"Failed to read {ts_file_path}: {e}")

    pbf_path: str = PBF_FILE
    if os.path.exists(pbf_path):
        mtime: float = os.path.getmtime(pbf_path)
        logging.info(f"Using {pbf_path} modification time.")
        return int(mtime * 1000)

    import time
    mtime = time.time()
    logging.warning(f"No timestamp source found. Using current timestamp as fallback.")
    return int(mtime * 1000)


def compile_stats() -> None:
    """Aggregates all weekly stats snapshot JSON files from stats/ into dist/stats/data.json."""
    dist_stats_dir = os.path.join(PUBLIC_DIRECTORY, 'stats')
    os.makedirs(dist_stats_dir, exist_ok=True)

    dates: list[str] = []
    snapshots: dict[str, dict] = {}

    if os.path.exists(STATS_DIR):
        files = sorted(glob.glob(os.path.join(STATS_DIR, '*.json')))
        for filepath in files:
            filename = os.path.basename(filepath)
            date_key = filename.replace('.json', '')
            try:
                with open(filepath, 'r', encoding='utf-8') as f:
                    data = json.load(f)
                dates.append(date_key)
                snapshots[date_key] = data
            except Exception as e:
                logging.warning(f"Failed to load stats snapshot {filepath}: {e}")

    output_path = os.path.join(dist_stats_dir, 'data.json')
    with open(output_path, 'w', encoding='utf-8') as f:
        json.dump({'dates': dates, 'snapshots': snapshots}, f, separators=(',', ':'))
    logging.info(f"Compiled {len(dates)} stats snapshot(s) to {output_path}.")


def build_js() -> None:
    """Bundles ES modules into minified JavaScript bundles using esbuild."""
    logging.info("Building JavaScript bundles with esbuild...")
    try:
        subprocess.run(
            ["npm", "install", "--no-save", "esbuild"],
            capture_output=True,
            text=True,
            check=True
        )
        main_entry = os.path.join(TEMPLATES_DIR, 'src', 'main.js')
        result_main = subprocess.run(
            ["npx", "esbuild", main_entry, "--bundle", f"--outfile={os.path.join(PUBLIC_DIRECTORY, 'app.js')}", "--minify"],
            capture_output=True,
            text=True,
            check=True
        )

        stats_entry = os.path.join(TEMPLATES_DIR, 'src', 'stats_app.js')
        os.makedirs(os.path.join(PUBLIC_DIRECTORY, 'stats'), exist_ok=True)
        result_stats = subprocess.run(
            ["npx", "esbuild", stats_entry, "--bundle", f"--outfile={os.path.join(PUBLIC_DIRECTORY, 'stats', 'app.js')}", "--minify"],
            capture_output=True,
            text=True,
            check=True
        )

        warnings_entry = os.path.join(TEMPLATES_DIR, 'src', 'warnings_app.js')
        os.makedirs(os.path.join(PUBLIC_DIRECTORY, 'warnings'), exist_ok=True)
        result_warnings = subprocess.run(
            ["npx", "esbuild", warnings_entry, "--bundle", f"--outfile={os.path.join(PUBLIC_DIRECTORY, 'warnings', 'app.js')}", "--minify"],
            capture_output=True,
            text=True,
            check=True
        )
        logging.info("JavaScript bundles built successfully.")
        if result_main.stderr:
            logging.debug(f"esbuild main stderr: {result_main.stderr}")
        if result_stats.stderr:
            logging.debug(f"esbuild stats stderr: {result_stats.stderr}")
        if result_warnings.stderr:
            logging.debug(f"esbuild warnings stderr: {result_warnings.stderr}")
    except subprocess.CalledProcessError as e:
        logging.error(f"Failed to build JS bundle: {e.stderr}")
        raise
    except FileNotFoundError:
        logging.error("npx not found. Please ensure Node.js and npm are installed.")


def render() -> None:
    """Executes asset downloads, CSS/JS bundling, stats compilation and Jinja2 index.html & stats.html rendering."""
    os.makedirs(PUBLIC_DIRECTORY, exist_ok=True)

    download_dependencies()
    build_tailwind()
    build_js()
    compile_stats()

    env = Environment(loader=FileSystemLoader(TEMPLATES_DIR))
    template_index = env.get_template('index.html')

    data_timestamp: int = get_data_timestamp()
    pmtiles_urls: dict[str, str] = get_pmtiles_urls()
    initial_bounds = get_initial_bounds()

    with open(os.path.join(PUBLIC_DIRECTORY, 'index.html'), 'w', encoding='utf-8') as f:
        f.write(template_index.render(data_timestamp=data_timestamp, pmtiles_urls=pmtiles_urls, initial_bounds=initial_bounds))

    stats_template_path = os.path.join(TEMPLATES_DIR, 'stats.html')
    if os.path.exists(stats_template_path):
        template_stats = env.get_template('stats.html')
        os.makedirs(os.path.join(PUBLIC_DIRECTORY, 'stats'), exist_ok=True)
        with open(os.path.join(PUBLIC_DIRECTORY, 'stats', 'index.html'), 'w', encoding='utf-8') as f:
            f.write(template_stats.render(data_timestamp=data_timestamp))

    warnings_template_path = os.path.join(TEMPLATES_DIR, 'warnings.html')
    if os.path.exists(warnings_template_path):
        template_warnings = env.get_template('warnings.html')
        os.makedirs(os.path.join(PUBLIC_DIRECTORY, 'warnings'), exist_ok=True)
        with open(os.path.join(PUBLIC_DIRECTORY, 'warnings', 'index.html'), 'w', encoding='utf-8') as f:
            f.write(template_warnings.render(data_timestamp=data_timestamp))


if __name__ == "__main__":
    render()
