import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient

import app
import routes_health


class SystemStatusTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.graph_file = Path(self.temporary.name) / "graph.json"
        self.graph_file.write_text("{}", encoding="utf-8")
        routes_health.status_snapshot.cache_clear()
        self.client = TestClient(app.app)

    def tearDown(self):
        routes_health.status_snapshot.cache_clear()
        self.temporary.cleanup()

    def test_reports_geometry_vectors_and_uses_cache(self):
        graph = {
            "nodes": [{"coordinates": {"semantic": {"x": 1, "y": 2, "z": 3}}}],
            "edges": [{"source": "a", "target": "b"}],
        }
        text, clips = Mock(), Mock()
        text.count.return_value = clips.count.return_value = 1
        with (
            patch.object(routes_health.store, "DATA", self.graph_file),
            patch.object(routes_health.store, "load", return_value=graph),
            patch.object(routes_health.ingest, "collection", return_value=text),
            patch.object(routes_health.ingest, "clip_collection", return_value=clips),
        ):
            first = self.client.get("/api/v1/system/status")
            second = self.client.get("/api/v1/system/status")

        self.assertEqual(first.status_code, 200)
        self.assertEqual(first.json()["status"], "ok")
        self.assertEqual(first.json()["node_count"], 1)
        self.assertEqual(first.json()["geometry_3d_nodes"], 1)
        self.assertTrue(first.json()["chromadb"]["synced"])
        self.assertTrue(first.json()["hybrid_search"]["index_warmed"])
        self.assertEqual(second.json(), first.json())
        text.count.assert_called_once()
        clips.count.assert_called_once()

    def test_chroma_failure_is_degraded_not_an_exception(self):
        with (
            patch.object(routes_health.store, "DATA", self.graph_file),
            patch.object(routes_health.store, "load", return_value={"nodes": [], "edges": []}),
            patch.object(routes_health.ingest, "collection", side_effect=RuntimeError),
        ):
            payload = self.client.get("/api/v1/system/status").json()
        self.assertEqual(payload["status"], "degraded")
        self.assertFalse(payload["chromadb"]["healthy"])
        self.assertEqual(payload["errors"], ["chromadb: RuntimeError"])


if __name__ == "__main__":
    unittest.main()
