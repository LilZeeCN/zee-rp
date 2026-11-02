"""Horizontal segments use thickness instead of h; recovery must mask them."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import numpy as np
from trace import thickseg_from_line, recover_uncovered_icons_and_badges


class PolylineRecovery(unittest.TestCase):
    def test_horizontal_segment_is_occupied_at_both_scales(self):
        for scale in (1, 2):
            with self.subTest(scale=scale):
                arr = np.full((100 * scale, 200 * scale, 3), 255, dtype=np.uint8)
                arr[19 * scale:22 * scale, 10 * scale:81 * scale] = 50
                segment = thickseg_from_line({"x1": 10, "y1": 20, "x2": 80, "y2": 20, "thickness": 2})
                self.assertEqual(segment["kind"], "hline")
                self.assertNotIn("h", segment)
                vectors, images = recover_uncovered_icons_and_badges(
                    arr, [], [], [], [], [segment], [], scale=scale, true_bg_hex="#FFFFFF")
                self.assertEqual(vectors, [])
                self.assertEqual(images, [])


if __name__ == "__main__":
    unittest.main()
