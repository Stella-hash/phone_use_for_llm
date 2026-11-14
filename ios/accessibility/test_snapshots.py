import json
import os
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

import snapshots


def source():
    return {"schema_version": 1, "source": "ios-native-ax", "status": "ok", "scope": "app",
            "nodes": [{"id": "n0", "parent_id": None, "label": "exact private source", "value": 0}]}


class SnapshotTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name) / "ax"

    def test_complete_source_round_trip_is_private_and_bound_to_id(self):
        original = source()
        saved = snapshots.save_snapshot(original, self.root)
        self.assertEqual(saved["status"], "saved")
        raw, read = snapshots.read_snapshot(saved["snapshot_id"], self.root)
        self.assertEqual(read, saved)
        self.assertEqual(raw.pop("local_snapshot")["id"], saved["snapshot_id"])
        self.assertEqual(raw, original)
        self.assertNotIn("local_snapshot", original)
        self.assertEqual(self.root.stat().st_mode & 0o777, 0o700)
        self.assertEqual(Path(saved["raw_path"]).stat().st_mode & 0o777, 0o600)

    def test_retention_removes_only_owned_captures_not_existing_evidence(self):
        self.root.mkdir()
        historic = self.root / "prior-evidence.json"
        historic.write_text("preserve me")
        with patch.object(snapshots, "MAX_FILES", 2):
            saved = [snapshots.save_snapshot(source(), self.root) for _ in range(3)]
        self.assertEqual(historic.read_text(), "preserve me")
        with self.assertRaises(snapshots.SnapshotError) as caught:
            snapshots.read_snapshot(saved[0]["snapshot_id"], self.root)
        self.assertEqual(caught.exception.code, "snapshot_unavailable")
        self.assertEqual(len(list(self.root.glob("capture-*.json"))), 2)

    def test_rejects_path_traversal_symlink_and_wrong_binding(self):
        for value in ("../secret", "/tmp/file", "", None):
            with self.assertRaises(snapshots.SnapshotError):
                snapshots.read_snapshot(value, self.root)
        saved = snapshots.save_snapshot(source(), self.root)
        file = Path(saved["raw_path"])
        raw = json.loads(file.read_text())
        raw["local_snapshot"]["id"] = "different"
        file.write_text(json.dumps(raw))
        with self.assertRaises(snapshots.SnapshotError):
            snapshots.read_snapshot(saved["snapshot_id"], self.root)
        file.unlink()
        file.symlink_to(Path(self.temp.name) / "unrelated")
        with self.assertRaises(snapshots.SnapshotError):
            snapshots.read_snapshot(saved["snapshot_id"], self.root)

    def test_failed_write_and_large_source_are_explicit_without_source_echo(self):
        blocked = Path(self.temp.name) / "not-a-directory"
        blocked.write_text("keep")
        result = snapshots.save_snapshot(source(), blocked)
        self.assertEqual(result["status"], "failed")
        self.assertNotIn("private", json.dumps(result))
        with patch.object(snapshots, "MAX_RAW_BYTES", 8):
            result = snapshots.save_snapshot(source(), self.root)
        self.assertEqual(result["error_code"], "archive_size_limit")


if __name__ == "__main__":
    unittest.main()
