import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import app
import routes_nodes
import routes_presets


ORIGIN = "http://localhost:5173"


class ApiErrorTests(unittest.TestCase):
    def setUp(self):
        self.client = TestClient(app.app, raise_server_exceptions=False)
        self.headers = {"Origin": ORIGIN}

    def assert_cors_json(self, response, status):
        self.assertEqual(response.status_code, status)
        self.assertEqual(response.headers.get("access-control-allow-origin"), ORIGIN)
        self.assertTrue(response.headers.get("content-type", "").startswith("application/json"))

    def test_preflight_and_expected_client_errors_have_cors(self):
        preflight = self.client.options(
            "/api/v1/presets",
            headers={**self.headers, "Access-Control-Request-Method": "POST"},
        )
        self.assertEqual(preflight.status_code, 200)
        self.assertEqual(preflight.headers.get("access-control-allow-origin"), ORIGIN)

        self.assert_cors_json(
            self.client.get("/api/v1/nodes/NO_SUCH_NODE/ocr", headers=self.headers), 404
        )
        self.assert_cors_json(
            self.client.delete("/api/v1/presets/NO_SUCH_PRESET", headers=self.headers), 404
        )
        self.assert_cors_json(
            self.client.post(
                "/api/v1/presets", headers=self.headers, json={"name": " ", "state": {}}
            ),
            422,
        )

    def test_data_failures_are_json_500_with_cors(self):
        with patch.object(routes_nodes.store, "load", side_effect=ValueError("bad graph")):
            ocr = self.client.get("/api/v1/nodes/X/ocr", headers=self.headers)
        self.assert_cors_json(ocr, 500)
        self.assertEqual(ocr.json(), {"detail": "node index is unavailable"})

        with tempfile.TemporaryDirectory() as folder:
            damaged = Path(folder) / "presets.json"
            damaged.write_text("{bad", encoding="utf-8")
            with patch.object(routes_presets, "PRESETS_FILE", damaged):
                presets = self.client.get("/api/v1/presets", headers=self.headers)
        self.assert_cors_json(presets, 500)
        self.assertEqual(presets.json(), {"detail": "invalid preset store"})

        with tempfile.TemporaryDirectory() as folder:
            target = Path(folder) / "presets.json"
            with (
                patch.object(routes_presets, "PRESETS_FILE", target),
                patch.object(routes_presets.ingest, "write_atomic", side_effect=OSError),
            ):
                saving = self.client.post(
                    "/api/v1/presets",
                    headers=self.headers,
                    json={"name": "safe", "state": {"nodes": []}},
                )
        self.assert_cors_json(saving, 500)
        self.assertEqual(saving.json(), {"detail": "could not write preset store"})


if __name__ == "__main__":
    unittest.main()
