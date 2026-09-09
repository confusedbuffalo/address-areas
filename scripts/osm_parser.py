"""
PyOsmium handlers and database helpers for extracting address data into SQLite.
"""
import json
import sqlite3
from typing import Any, Optional
import osmium

import math
from config import (
    CONSIDERED_TAGS_SET,
    FEATURE_TAG_KEYS,
    POSTCODE_AREA_REGEX,
    TRANSFORMER_TO_27700,
)
from warnings_detector import is_valid_address_tag

PHYSICAL_HIGHWAY_TYPES: set[str] = {
    'residential', 'unclassified', 'tertiary', 'secondary', 'primary',
    'trunk', 'motorway', 'living_street', 'service', 'pedestrian',
    'footway', 'cycleway', 'path'
}


class RelationMemberScanner(osmium.SimpleHandler):
    """Fast initial pass handler to extract node and way IDs referenced by address relations."""

    def __init__(self) -> None:
        super(RelationMemberScanner, self).__init__()
        self.member_way_ids: set[int] = set()
        self.member_node_ids: set[int] = set()

    def relation(self, r: osmium.osm.Relation) -> None:
        """Collects member node and way IDs from relations containing address tags."""
        if r.tags and any(tag.k.startswith('addr:') for tag in r.tags):
            for m in r.members:
                if m.type == 'w':
                    self.member_way_ids.add(m.ref)
                elif m.type == 'n':
                    self.member_node_ids.add(m.ref)


class BaseAddressHandler(osmium.SimpleHandler):
    """Base handler providing helper functions and SQLite buffer writing."""

    def __init__(
        self,
        conn: sqlite3.Connection,
        member_way_ids: Optional[set[int]] = None,
        member_node_ids: Optional[set[int]] = None
    ) -> None:
        super(BaseAddressHandler, self).__init__()
        self.conn: sqlite3.Connection = conn
        self.cursor: sqlite3.Cursor = conn.cursor()
        self.batch: list[tuple[Any, ...]] = []
        self.highway_batch: list[tuple[Any, ...]] = []
        self.member_way_ids: set[int] = member_way_ids if member_way_ids is not None else set()
        self.member_node_ids: set[int] = member_node_ids if member_node_ids is not None else set()
        self.relation_node_locs: dict[int, tuple[float, float]] = {}
        self.way_locs: dict[int, tuple[float, float]] = {}
        self.total_addresses: int = 0
        self.total_highways: int = 0

    def add_address(self, loc: tuple[float, float], tags: Any, osm_type: str, osm_id: int) -> None:
        """Extracts and normalises address attributes from OSM tags and buffers for SQLite insertion."""
        lat, lon = loc
        postcode: str = tags.get('addr:postcode', 'No postcode')
        if postcode == 'No postcode':
            area: str = 'No postcode'
        else:
            match = POSTCODE_AREA_REGEX.match(postcode)
            area = match.group(1) if match else "Unknown"

        popup_tags: dict[str, str] = {}
        popup_keys: list[str] = [
            'addr:unit', 'addr:flats', 'addr:floor', 'addr:housename',
            'addr:housenumber', 'addr:street', 'addr:place', 'addr:parentstreet',
            'addr:suburb', 'addr:locality', 'addr:hamlet', 'addr:village',
            'addr:town', 'addr:city', 'addr:postcode'
        ]
        for key in popup_keys:
            if key in tags:
                popup_tags[key] = tags[key]

        unusual_addr_tags: dict[str, str] = {}
        for tag in tags:
            if tag.k.startswith('addr:') and not is_valid_address_tag(tag.k):
                unusual_addr_tags[tag.k] = tags[tag.k]

        suburb_val: Optional[str] = None
        suburb_type: str = 'missing'
        for key in ['addr:suburb', 'addr:locality', 'addr:hamlet', 'addr:village', 'addr:town']:
            if key in tags:
                suburb_val = tags[key]
                suburb_type = key.split(':')[1]
                break
        if not suburb_val:
            suburb_val = 'No suburb'
            suburb_type = 'missing'

        street_val: str = tags.get('addr:street', '')
        street_type: str = 'street'
        if not street_val:
            street_val = tags.get('addr:place', 'No street')
            street_type = 'place' if 'addr:place' in tags else 'missing'

        has_address_info: bool = (
            'addr:unit' in tags or
            'addr:housenumber' in tags or
            'addr:housename' in tags or
            'addr:flats' in tags or
            'addr:floor' in tags or
            tags.get('nohousenumber') == 'yes'
        )
        has_feature_tag: int = 1 if any(k in tags for k in FEATURE_TAG_KEYS) else 0

        street_key: str = street_val if street_type == 'missing' else f"{street_type}:{street_val}"
        suburb_key: str = suburb_val if suburb_type == 'missing' else f"{suburb_type}:{suburb_val}"

        x_proj, y_proj = TRANSFORMER_TO_27700.transform(lon, lat)

        self.batch.append((
            lat, lon, float(x_proj), float(y_proj),
            postcode, area,
            tags.get('addr:city', 'No city'),
            suburb_val, suburb_type, suburb_key,
            street_val, street_type, street_key,
            json.dumps(popup_tags) if popup_tags else "{}",
            json.dumps(unusual_addr_tags) if unusual_addr_tags else "{}",
            f"{osm_type}{osm_id}",
            tags.get('name', ''),
            1 if has_address_info else 0,
            has_feature_tag
        ))

        if len(self.batch) >= 10000:
            self.flush()

    def flush(self) -> None:
        """Flushes buffered address and physical highway records to SQLite database."""
        if self.batch:
            self.cursor.executemany("""
                INSERT INTO addresses (
                    lat, lon, x_proj, y_proj,
                    postcode, postcode_area, city,
                    suburb, suburb_type, suburb_key,
                    street, street_type, street_key,
                    popup_tags, unusual_addr_tags, osm_id, osm_name, is_addressed, has_feature_tag
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, self.batch)
            self.conn.commit()
            self.total_addresses += len(self.batch)
            self.batch.clear()

        if self.highway_batch:
            self.cursor.executemany("""
                INSERT INTO physical_highways (
                    osm_id, name, highway_type, surface, lit, maxspeed, lanes, sidewalk,
                    etymology_wikidata, length_m, geom_wkt, min_x, max_x, min_y, max_y
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, self.highway_batch)
            self.conn.commit()
            self.total_highways += len(self.highway_batch)
            self.highway_batch.clear()


class NodeAddressHandler(BaseAddressHandler):
    """Fast node-only handler filtered by key filter."""

    def node(self, n: osmium.osm.Node) -> None:
        """Processes an OSM node and extracts address tags if present."""
        if n.location.valid():
            loc: tuple[float, float] = (n.location.lat, n.location.lon)
            if n.id in self.member_node_ids:
                self.relation_node_locs[n.id] = loc
            if n.tags and any(tag.k.startswith('addr:') for tag in n.tags):
                self.add_address(loc, n.tags, 'n', n.id)


class WayAddressHandler(BaseAddressHandler):
    """Way and relation handler with full location indexing in C++."""

    def way(self, w: osmium.osm.Way) -> None:
        """Processes an OSM way, calculates node centroid and extracts address tags if present."""
        is_member: bool = w.id in self.member_way_ids
        if not is_member and not w.tags:
            return

        has_tags: bool = any(tag.k.startswith('addr:') for tag in w.tags) if w.tags else False
        highway_names: set[str] = set()
        if w.tags and 'highway' in w.tags and w.tags['highway'] in PHYSICAL_HIGHWAY_TYPES:
            for tag_k in ('name', 'name:left', 'name:right'):
                if tag_k in w.tags:
                    val = w.tags[tag_k].strip()
                    if val:
                        highway_names.add(val)

        is_physical_highway: bool = len(highway_names) > 0

        if has_tags or is_member or is_physical_highway:
            lats: list[float] = []
            lons: list[float] = []
            xs: list[float] = []
            ys: list[float] = []

            for node_ref in w.nodes:
                if node_ref.location.valid():
                    lat_val = node_ref.location.lat
                    lon_val = node_ref.location.lon
                    lats.append(lat_val)
                    lons.append(lon_val)
                    if is_physical_highway:
                        x_proj, y_proj = TRANSFORMER_TO_27700.transform(lon_val, lat_val)
                        xs.append(float(x_proj))
                        ys.append(float(y_proj))

            if lats and lons:
                avg_lat: float = sum(lats) / len(lats)
                avg_lon: float = sum(lons) / len(lons)
                self.way_locs[w.id] = (avg_lat, avg_lon)
                if has_tags:
                    self.add_address((avg_lat, avg_lon), w.tags, 'w', w.id)

                if is_physical_highway and len(lats) >= 2 and len(xs) >= 2:
                    length_m = 0.0
                    for i in range(len(xs) - 1):
                        length_m += math.hypot(xs[i + 1] - xs[i], ys[i + 1] - ys[i])

                    min_x, max_x = min(xs), max(xs)
                    min_y, max_y = min(ys), max(ys)

                    geom_wkt = "LINESTRING (" + ", ".join(f"{lon:.7f} {lat:.7f}" for lat, lon in zip(lats, lons)) + ")"

                    for h_name in highway_names:
                        self.highway_batch.append((
                            f"w{w.id}",
                            h_name,
                            w.tags['highway'].strip(),
                            w.tags.get('surface', '').strip(),
                            w.tags.get('lit', '').strip(),
                            parse_maxspeed(w.tags),
                            parse_lanes(w.tags),
                            parse_sidewalk(w.tags),
                            w.tags.get('name:etymology:wikidata', '').strip(),
                            float(length_m),
                            geom_wkt,
                            float(min_x),
                            float(max_x),
                            float(min_y),
                            float(max_y)
                        ))

                        if len(self.highway_batch) >= 10000:
                            self.flush()

    def relation(self, r: osmium.osm.Relation) -> None:
        """Processes an OSM relation, calculates member centroid and extracts address tags if present."""
        if r.tags and any(tag.k.startswith('addr:') for tag in r.tags):
            lats: list[float] = []
            lons: list[float] = []
            for m in r.members:
                if m.type == 'n' and m.ref in self.relation_node_locs:
                    lat, lon = self.relation_node_locs[m.ref]
                    lats.append(lat)
                    lons.append(lon)
                elif m.type == 'w' and m.ref in self.way_locs:
                    lat, lon = self.way_locs[m.ref]
                    lats.append(lat)
                    lons.append(lon)
            if lats and lons:
                self.add_address((sum(lats)/len(lats), sum(lons)/len(lons)), r.tags, 'r', r.id)

def parse_lanes(tags):
    lanes_val = tags.get('lanes', '').strip()
    if lanes_val:
        return lanes_val
    lane_markings_val = tags.get('lane_markings', '').strip()
    if lane_markings_val and lane_markings_val == 'no':
        return 'unmarked'
        # Marked but without a value is not useful information so should count as unknown
    
    return None

def parse_sidewalk(tags):
    """Basic sidewalk tagging parser, to determine if sidewalk is both, left, right, separate or no"""
    sw = tags.get('sidewalk', '').strip()
    sw_both = tags.get('sidewalk:both', '').strip()
    sw_left = tags.get('sidewalk:left', '').strip()
    sw_right = tags.get('sidewalk:right', '').strip()

    if sw:
        return sw
    if sw_both:
        return sw_both
    if sw_left and sw_right:
        if sw_left == 'yes' and sw_right == 'yes':
            return 'both'
        if sw_left == 'yes' and sw_right == 'no':
            return 'left'
        if sw_left == 'no' and sw_right == 'yes':
            return 'right'
        if sw_left == 'no' and sw_right == 'no':
            return 'no'
        if sw_left == 'separate' and sw_right == 'separate':
            return 'separate'
        if sw_left == 'separate' and sw_right == 'no':
            return 'separate'
        if sw_left == 'no' and sw_right == 'separate':
            return 'separate'
    # Incomplete tagging treat as not tagged
    return None

def parse_maxspeed(tags):
    maxspeed_val = tags.get('maxspeed', '').strip()
    maxspeed_type = tags.get('maxspeed:type', '').strip()

    if maxspeed_type:
        if maxspeed_type == 'sign':
            pass
        if maxspeed_type == 'GB:zone20':
            return '20 mph zone'
        if maxspeed_type == 'GB:zone40':
            return '40 mph zone'
        if maxspeed_type == 'GB:nsl_single':
            return 'NSL (single carriageway)'
        if maxspeed_type == 'GB:nsl_dual':
            return 'NSL (dual carriageway)'
        if maxspeed_type == 'GB:motorway':
            return 'NSL (motorway)'
        if maxspeed_type == 'GB-WLS:nsl_restricted':
            return 'Implicit 20 mph'
        if maxspeed_type == 'GB:nsl_restricted':
            return 'Implicit 30 mph'

    if maxspeed_val:
        return maxspeed_val

    return None
