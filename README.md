# UK Address QA ([uk-addresses.pages.dev](https://uk-addresses.pages.dev/))

An interactive quality assurance tool for OpenStreetMap address data across the United Kingdom.

## Overview

This project processes OpenStreetMap data to help identify and visualise address coverage and hierarchy across the UK.

1. **Address Extraction**: Address points (nodes, ways, and relations with address tags) are extracted from OpenStreetMap data.
2. **Hierarchical Grouping**: Addresses are grouped into spatial regions across multi-level spatial hierarchies: Postcode Area, City, Suburb and Street. Voronoi cells and bounding polygons are generated for each level to visualise spatial coverage.
3. **Map Tiles**: The resulting vector geometries and address points are compiled into individual `.pmtiles` vector tile files for each hierarchy layer (`postcode_area`, `city`, `suburb`, `street`, `points`).
4. **Web Interface**: A lightweight MapLibre GL JS web application bundles static metadata and vector tiles into a browsable QA dashboard.

## Local Development

### System Requirements

Building the dataset and web application locally requires:

- **Python 3.10+** and `pip`
- **Node.js** and `npm` (for Tailwind CSS and esbuild JS bundling)
- **Tippecanoe** (for generating PMTiles vector tiles)
- C++ build tools and development libraries: `build-essential`, `libosmium2-dev`, `libprotozero-dev`, `libboost-dev`, `libsqlite3-dev`, `zlib1g-dev`

On Ubuntu/Debian systems, system dependencies can be installed via:

```bash
sudo apt-get install -y build-essential libosmium2-dev libprotozero-dev libboost-dev libsqlite3-dev zlib1g-dev tippecanoe python3 python3-pip nodejs npm
```

_Note: tippecanoe >= 2.52.0 is required, if your distribution's package manager provides an older version of Tippecanoe, it can be compiled from source from [felt/tippecanoe](https://github.com/felt/tippecanoe)._

### Setup & Running

1. **Install Python dependencies:**

    ```bash
    pip install -r requirements.txt
    ```

2. **Using a smaller extract (Recommended for local testing):**

    By default, the pipeline downloads the full UK extract from Geofabrik. For faster local testing, update `PBF_URL` in `scripts/config.py` to point to a smaller region extract (e.g., Isle of Wight or Greater London) from [Geofabrik Downloads](https://download.geofabrik.de/europe/united-kingdom.html):

    ```python
    # scripts/config.py
    PBF_URL: str = "https://download.geofabrik.de/europe/united-kingdom/isle-of-wight-latest.osm.pbf"
    ```

3. **Process OpenStreetMap data:**

    ```bash
    python scripts/process.py
    ```

4. **Build the static site and JS/CSS bundles:**

    ```bash
    python scripts/render.py
    ```
