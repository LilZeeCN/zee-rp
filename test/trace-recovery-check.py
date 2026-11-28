"""Horizontal segments use thickness instead of h; recovery must mask them."""
import sys
from pathlib import Path
import unittest
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))
import numpy as np
from PIL import Image, ImageDraw
from trace import audit_proxy_vs_host, thickseg_from_line, recover_uncovered_icons_and_badges


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

    def test_font_drift_is_separate_from_a_real_stroke(self):
        spec = {"frames": [{"children": [{"kind": "text", "id": "title",
                 "x": 20, "y": 20, "w": 150, "h": 24, "fontSize": 16}]}]}
        proxy = Image.new("RGB", (230, 140), "white")
        actual = proxy.copy()
        draw = ImageDraw.Draw(actual)
        draw.rectangle((50, 23, 55, 29), fill="black")  # localized glyph drift
        draw.line((30, 106, 190, 106), fill="black", width=2)
        anomalies, noise, clusters = audit_proxy_vs_host(spec, proxy, actual)
        self.assertEqual(noise["subpixelFontDriftCount"], 1)
        self.assertEqual(len(anomalies), 1)
        self.assertEqual(clusters[0]["type"], "SPURIOUS_HOST_INK")
        retained, noise, _ = audit_proxy_vs_host(spec, proxy, actual, [anomalies[0]["id"]])
        self.assertEqual(retained, [])
        self.assertEqual(noise["exemptedHostAnomalies"], 1)


if __name__ == "__main__":
    unittest.main()
