import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app
import routes_nodes


class NodeOcrRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.image = Path(self.temporary.name) / "scan.jpg"
        self.image.write_bytes(b"image")
        self.client = TestClient(app.app)

    def tearDown(self):
        self.temporary.cleanup()

    def test_returns_clean_sidecar_ocr(self):
        self.image.with_name("scan.jpg.md").write_text(
            "---\ndomain: Art\n---\n<!-- ocr -->\n  첫 줄  \nsecond line\n<!-- /ocr -->\n",
            encoding="utf-8",
        )
        with patch.object(routes_nodes, "node_file", return_value=self.image):
            response = self.client.get("/api/v1/nodes/SRC_SCAN/ocr")
        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {"id": "SRC_SCAN", "has_ocr": True, "ocr_text": "첫 줄\nsecond line"},
        )

    def test_returns_empty_when_ocr_is_absent(self):
        with patch.object(routes_nodes, "node_file", return_value=self.image):
            response = self.client.get("/api/v1/nodes/SRC_SCAN/ocr")
        self.assertEqual(response.json(), {"id": "SRC_SCAN", "has_ocr": False, "ocr_text": ""})


if __name__ == "__main__":
    unittest.main()
