"""
Unit tests for 'Unknown' placeholder colouring and sorting priority.
"""

import unittest
from scripts.config import assign_colours, PALETTE, get_colour_index


class TestUnknownAndSorting(unittest.TestCase):
    """Tests for 'Unknown' placeholder colour assignment."""

    def test_assign_colours_unknown_area(self) -> None:
        """Tests that 'Unknown' area features receive red fill and label colours."""
        props = {"name": "Unknown", "raw_name": "Unknown", "level": "postcode_area"}
        assign_colours(props, is_points_level=False)
        self.assertEqual(props["fillColour"], "#fee2e2")
        self.assertEqual(props["labelColour"], "#991b1b")

    def test_assign_colours_unknown_point_postcode(self) -> None:
        """Tests that point features with 'Unknown' postcode receive red fill and label colours."""
        props = {"name": "1 High Street", "postcode": "Unknown", "level": "points"}
        assign_colours(props, is_points_level=True)
        self.assertEqual(props["fillColour"], "#fee2e2")
        self.assertEqual(props["labelColour"], "#991b1b")

    def test_assign_colours_no_postcode(self) -> None:
        """Tests that 'No postcode' features receive red fill and label colours."""
        props = {"name": "No postcode", "raw_name": "No postcode", "level": "postcode_area"}
        assign_colours(props, is_points_level=False)
        self.assertEqual(props["fillColour"], "#fca5a5")
        self.assertEqual(props["labelColour"], "#7f1d1d")


if __name__ == "__main__":
    unittest.main()
