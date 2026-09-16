import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient

import app
import routes_presets


class PresetRoutesTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory()
        self.original = routes_presets.PRESETS_FILE
        routes_presets.PRESETS_FILE = Path(self.temporary.name) / "presets.json"
        self.client = TestClient(app.app)

    def tearDown(self):
        routes_presets.PRESETS_FILE = self.original
        self.temporary.cleanup()

    def test_save_list_and_delete(self):
        state = {"nodes": ["CON_UEXKULL", "PRJ_UMWELT"], "view": "semantic"}
        saved = self.client.post("/api/v1/presets", json={"name": "Umwelt set", "state": state})
        self.assertEqual(saved.status_code, 201)
        self.assertEqual(saved.json()["id"], "Umwelt set")
        self.assertEqual(self.client.get("/api/v1/presets").json(), {"presets": {"Umwelt set": state}})
        self.assertFalse(routes_presets.PRESETS_FILE.with_name(".presets.json.writing").exists())

        deleted = self.client.delete("/api/v1/presets/Umwelt%20set")
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.client.get("/api/v1/presets").json(), {"presets": {}})

    def test_rejects_blank_name(self):
        for name in ("  ", "folder/view"):
            response = self.client.post("/api/v1/presets", json={"name": name, "state": {"nodes": []}})
            self.assertEqual(response.status_code, 422)


if __name__ == "__main__":
    unittest.main()
