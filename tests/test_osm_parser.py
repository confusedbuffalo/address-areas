import sqlite3
import pytest
from osm_parser import WayAddressHandler


class DummyTag:
    def __init__(self, k, v):
        self.k = k
        self.v = v


class DummyTags(list):
    def __init__(self, tag_dict):
        super().__init__([DummyTag(k, v) for k, v in tag_dict.items()])
        self._dict = tag_dict

    def __contains__(self, item):
        return item in self._dict

    def __getitem__(self, item):
        return self._dict[item]

    def get(self, item, default=None):
        return self._dict.get(item, default)


class DummyLocation:
    def __init__(self, lat, lon):
        self._lat = lat
        self._lon = lon

    def valid(self):
        return True

    @property
    def lat(self):
        return self._lat

    @property
    def lon(self):
        return self._lon


class DummyNodeRef:
    def __init__(self, lat, lon):
        self.location = DummyLocation(lat, lon)


class DummyWay:
    def __init__(self, way_id, tag_dict, nodes=None):
        self.id = way_id
        self.tags = DummyTags(tag_dict) if tag_dict is not None else None
        self.nodes = nodes or [DummyNodeRef(51.5, -0.1), DummyNodeRef(51.51, -0.11)]


@pytest.fixture
def db_conn():
    conn = sqlite3.connect(":memory:")
    conn.execute("""
        CREATE TABLE addresses (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            lat REAL, lon REAL, x_proj REAL, y_proj REAL,
            postcode TEXT, postcode_area TEXT, city TEXT,
            suburb TEXT, suburb_type TEXT, suburb_key TEXT,
            street TEXT, street_type TEXT, street_key TEXT,
            popup_tags TEXT, unusual_addr_tags TEXT, osm_id TEXT, osm_name TEXT,
            is_addressed INTEGER, has_feature_tag INTEGER, is_interpolation_only INTEGER
        )
    """)
    conn.execute("""
        CREATE TABLE physical_highways (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            osm_id TEXT, name TEXT, highway_type TEXT, surface TEXT,
            lit TEXT, maxspeed TEXT, lanes TEXT, sidewalk TEXT,
            etymology_wikidata TEXT, length_m REAL, geom_wkt TEXT,
            min_x REAL, max_x REAL, min_y REAL, max_y REAL
        )
    """)
    yield conn
    conn.close()


def test_way_with_only_addr_interpolation_flagged_as_interpolation_only(db_conn):
    handler = WayAddressHandler(conn=db_conn)
    way = DummyWay(101, {'addr:interpolation': 'even'})
    handler.way(way)
    handler.flush()

    cursor = db_conn.cursor()
    cursor.execute("SELECT osm_id, is_interpolation_only FROM addresses")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'w101'
    assert rows[0][1] == 1


def test_way_with_interpolation_and_inclusion_flagged_as_interpolation_only(db_conn):
    handler = WayAddressHandler(conn=db_conn)
    way = DummyWay(102, {'addr:interpolation': 'odd', 'addr:inclusion': 'actual'})
    handler.way(way)
    handler.flush()

    cursor = db_conn.cursor()
    cursor.execute("SELECT osm_id, is_interpolation_only FROM addresses")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'w102'
    assert rows[0][1] == 1


def test_way_with_interpolation_and_invalid_tag_flagged_as_interpolation_only(db_conn):
    handler = WayAddressHandler(conn=db_conn)
    way = DummyWay(103, {'addr:interpolation': 'all', 'addr:invalid_custom_tag': 'value'})
    handler.way(way)
    handler.flush()

    cursor = db_conn.cursor()
    cursor.execute("SELECT osm_id, is_interpolation_only FROM addresses")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'w103'
    assert rows[0][1] == 1


def test_way_with_interpolation_and_valid_address_tag_not_flagged(db_conn):
    handler = WayAddressHandler(conn=db_conn)
    way = DummyWay(104, {'addr:interpolation': 'even', 'addr:housenumber': '1-10', 'addr:street': 'High Street'})
    handler.way(way)
    handler.flush()

    cursor = db_conn.cursor()
    cursor.execute("SELECT osm_id, street, is_interpolation_only FROM addresses")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'w104'
    assert rows[0][1] == 'High Street'
    assert rows[0][2] == 0


def test_standard_address_way_not_flagged(db_conn):
    handler = WayAddressHandler(conn=db_conn)
    way = DummyWay(105, {'addr:housenumber': '5', 'addr:street': 'Main Road', 'addr:postcode': 'SW1A 1AA'})
    handler.way(way)
    handler.flush()

    cursor = db_conn.cursor()
    cursor.execute("SELECT osm_id, street, postcode, is_interpolation_only FROM addresses")
    rows = cursor.fetchall()
    assert len(rows) == 1
    assert rows[0][0] == 'w105'
    assert rows[0][1] == 'Main Road'
    assert rows[0][2] == 'SW1A 1AA'
    assert rows[0][3] == 0
