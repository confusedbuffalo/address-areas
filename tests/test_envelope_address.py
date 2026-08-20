"""
Tests for envelope address configuration and backend tag extraction.
"""
from scripts.config import CONSIDERED_TAGS, CONSIDERED_TAGS_SET
from scripts.warnings_detector import format_object_title
from scripts.duplicates_detector import format_duplicate_title


def test_considered_tags_include_parentstreet():
    """Verify addr:parentstreet is included in CONSIDERED_TAGS and CONSIDERED_TAGS_SET."""
    assert 'addr:parentstreet' in CONSIDERED_TAGS
    assert 'addr:parentstreet' in CONSIDERED_TAGS_SET


def test_considered_tags_include_floor():
    """Verify addr:floor is included in CONSIDERED_TAGS and CONSIDERED_TAGS_SET."""
    assert 'addr:floor' in CONSIDERED_TAGS
    assert 'addr:floor' in CONSIDERED_TAGS_SET


def test_object_display_title_with_floor():
    """Verify format_object_title formats addr:floor as Floor <val> before unit/flats/number."""
    tags = {
        'addr:floor': '1',
        'addr:flats': '2A',
        'addr:housenumber': '10',
    }
    title = format_object_title('', tags, 'High Street', 'n123')
    assert title == 'Floor 1, Flats 2A, 10, High Street'


def test_duplicate_group_title_with_floor():
    """Verify format_duplicate_title formats addr:floor with Floor <val> first."""
    title = format_duplicate_title(
        housenumber='10',
        housename='',
        unit='Suite A',
        flats='1',
        floor='2',
        street='High Street'
    )
    assert title == 'Floor 2, Unit Suite A, Flat 1, 10, High Street'
