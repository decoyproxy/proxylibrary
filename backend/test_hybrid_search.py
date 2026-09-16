import unittest

from hybrid_search import bm25, rank


class HybridSearchTests(unittest.TestCase):
    def test_bm25_prefers_matching_document(self):
        scores = bm25("camera eye", ["camera eye perception", "unrelated archive"])
        self.assertGreater(scores[0], scores[1])

    def test_exact_title_outweighs_clip_only_match(self):
        records = [
            {"id": "exact", "title": "Camera Eye", "document": "notes", "metadata": {}},
            {"id": "visual", "title": "Optics", "document": "light", "metadata": {}},
        ]
        results = rank("Camera Eye", records, {"exact": 0.1, "visual": 0.9}, limit=2)
        self.assertEqual(results[0]["id"], "exact")
        self.assertTrue(results[0]["exact_match"])


if __name__ == "__main__":
    unittest.main()
