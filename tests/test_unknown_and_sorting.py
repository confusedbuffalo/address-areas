"""
Unit tests for 'Unknown' placeholder colouring and sorting priority.
"""

from scripts.config import assign_colours, PALETTE, get_colour_index


def test_assign_colours_unknown_area() -> None:
    """Tests that 'Unknown' area features receive red fill and label colours."""
    props = {"name": "Unknown", "raw_name": "Unknown", "level": "postcode_area"}
    assign_colours(props, is_points_level=False)
    assert props["fillColour"] == "#fee2e2"
    assert props["labelColour"] == "#991b1b"


def test_assign_colours_unknown_point_postcode() -> None:
    """Tests that point features with 'Unknown' postcode receive red fill and label colours."""
    props = {"name": "1 High Street", "postcode": "Unknown", "level": "points"}
    assign_colours(props, is_points_level=True)
    assert props["fillColour"] == "#fee2e2"
    assert props["labelColour"] == "#991b1b"


def test_assign_colours_no_postcode() -> None:
    """Tests that 'No postcode' features receive red fill and label colours."""
    props = {"name": "No postcode", "raw_name": "No postcode", "level": "postcode_area"}
    assign_colours(props, is_points_level=False)
    assert props["fillColour"] == "#fca5a5"
    assert props["labelColour"] == "#7f1d1d"
