import unittest
from unittest.mock import patch

import ingest


class UmapMetadataTests(unittest.TestCase):
    def test_layout_reports_full_reprojection(self):
        with patch.object(ingest.coords, "semantic", return_value=[{"x": 1, "y": 2, "z": 3}]):
            points, reprojected = ingest.layout(["new"], [[1, 2]], {"new"}, False, {})
        self.assertTrue(reprojected)
        self.assertEqual(points[0]["x"], 1)

    def test_unchanged_layout_is_not_a_reprojection(self):
        previous = {
            "umap_updated_at": "2026-09-17T00:00:00+00:00",
            "nodes": [{"id": "kept", "coordinates": {"semantic": {"x": 1, "y": 2, "z": 3}}}],
        }
        points, reprojected = ingest.layout(["kept"], [[1, 2]], set(), False, previous)
        self.assertFalse(reprojected)
        self.assertEqual(points, [{"x": 1, "y": 2, "z": 3}])


if __name__ == "__main__":
    unittest.main()
