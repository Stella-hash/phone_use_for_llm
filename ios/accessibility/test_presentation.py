import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch

import compact
import reading
import snapshots
import tree


def source():
    return {"schema_version": 1, "source": "ios-native-ax", "status": "ok", "scope": "app",
            "atomic": False, "coverage": {"complete": False},
            "nodes": [{"id": "n0", "parent_id": None, "native_type": "UILabel",
                       "label": "Quote", "value": "123.45", "frame": {"x": 1, "y": 2},
                       "native_class": "PRIVATE-RAW-ONLY"}]}


class PresentationTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = {**os.environ, "IPHONE_USE_STATE_DIR": str(self.root / "state")}
        self.env.pop("IPHONE_USE_USB_DEVICE_ID", None)

    def run_reader(self, arguments, request=None):
        result = subprocess.run([sys.executable, tree.__file__, *arguments],
                                input=json.dumps(request or {}).encode(), capture_output=True,
                                env=self.env, timeout=5, check=True)
        self.assertEqual(result.stderr, b"")
        return result.stdout, json.loads(result.stdout)

    def test_local_snapshot_cli_reads_same_source_without_device_configuration(self):
        saved = snapshots.save_snapshot(source(), self.root / "ax")
        before = Path(saved["raw_path"]).read_bytes()
        data, result = self.run_reader(["--snapshot-id", saved["snapshot_id"]])
        self.assertEqual(result["format"], compact.FORMAT)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["nodes"][0]["value"], "123.45")
        self.assertNotIn(b"PRIVATE-RAW-ONLY", data)
        self.assertLessEqual(len(data.rstrip()), compact.MAX_OUTPUT_BYTES)
        _, detail = self.run_reader(["--snapshot-id", saved["snapshot_id"], "--node-id", "n0"])
        self.assertEqual(detail["nodes"][0]["native_class"], "PRIVATE-RAW-ONLY")
        self.assertEqual(Path(saved["raw_path"]).read_bytes(), before)

    def test_default_unavailable_is_compact_and_display_only_does_not_use_ax_archive(self):
        _, result = self.run_reader([])
        self.assertEqual(result["format"], reading.FORMAT)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"]["code"], "not_configured")
        files = list((self.root / "ax").iterdir())
        _, display = self.run_reader(["--display-only"])
        self.assertEqual(display["source"], "ios-native-display")
        self.assertNotIn("format", display)
        self.assertEqual(list((self.root / "ax").iterdir()), files)

    def test_near_limit_native_source_replays_with_its_added_local_stamp(self):
        raw = source()
        raw["native_extra"] = ""
        size = len(json.dumps(raw, ensure_ascii=False, separators=(",", ":")).encode())
        raw["native_extra"] = "x" * (tree.MAX_OUTPUT_BYTES - 8 - size)
        self.assertEqual(json.loads(tree.encoded_result(raw))["status"], "ok")
        saved = snapshots.save_snapshot(raw, self.root / "ax")
        self.assertGreater(saved["raw_bytes"], tree.MAX_OUTPUT_BYTES)
        _, result = self.run_reader(["--snapshot-id", saved["snapshot_id"]])
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["nodes"][0]["value"], "123.45")

    def test_presentation_failure_and_archive_failure_never_return_raw(self):
        with patch.object(snapshots, "save_snapshot", return_value={"status": "failed", "raw_path": None}):
            data = tree.present_ax(source())
            self.assertEqual(json.loads(data)["archive"]["status"], "failed")
            self.assertNotIn(b"PRIVATE-RAW-ONLY", data)
        with patch.object(compact, "compact_snapshot", side_effect=ValueError("PRIVATE-RAW-ONLY")):
            data = tree.present_ax(source(), {"status": "failed", "raw_path": None})
        result = json.loads(data)
        self.assertEqual(result["reason"]["code"], "compact_presentation_failed")
        self.assertEqual(result["native_status"], "ok")
        self.assertNotIn(b"PRIVATE-RAW-ONLY", data)
        self.assertNotIn("nodes", result)
        self.assertLessEqual(len(data), compact.MAX_OUTPUT_BYTES)

    def test_missing_snapshot_and_invalid_selectors_fail_without_recapture(self):
        _, result = self.run_reader(["--snapshot-id", "00000000-0000-0000-0000-000000000000"])
        self.assertEqual(result["reason"]["code"], "snapshot_unavailable")
        for arguments in (["--offset", "3"], ["--snapshot-id", "../private"],
                          ["--snapshot-id", "x", "--offset", "-1"], ["--unknown", "x"]):
            _, result = self.run_reader(arguments)
            self.assertEqual(result["status"], "unavailable")
            self.assertEqual(result["archive"]["status"], "failed")
        self.assertFalse((self.root / "ax").exists())


if __name__ == "__main__":
    unittest.main()
