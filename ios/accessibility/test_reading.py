from copy import deepcopy
import json
from pathlib import Path
import unittest

from compact import compact_snapshot, MAX_OUTPUT_BYTES
from reading import reading_snapshot, FORMAT
from test_compact import ARCHIVE, node, raw, wire_size


def expand(rows, defaults=None, fieldsets=()):
    return [{**(defaults or {}), "id": row[0], "parent_id": row[1],
             **(fieldsets[row[2]] if len(row) == 3 and type(row[2]) is int
                else row[2] if len(row) == 3 else {})} for row in rows]


class ReadingTests(unittest.TestCase):
    def test_portable_native_shape_fixtures_keep_text_flags_and_every_parent_edge(self):
        file = Path(__file__).with_name("fixtures") / "reading-contract.json"
        fixture = json.loads(file.read_text())
        self.assertEqual(fixture["fixture_kind"], "synthetic")
        self.assertEqual(set(fixture["cases"]), {"form", "keyboard", "webkit", "dense_rows", "unavailable"})
        for name, source in fixture["cases"].items():
            with self.subTest(fixture=name):
                self.assert_equivalent(source)

    def assert_equivalent(self, source):
        before = deepcopy(source)
        compact = compact_snapshot(source, ARCHIVE)
        view = reading_snapshot(source, ARCHIVE)
        self.assertEqual(source, before)
        self.assertEqual(view["format"], FORMAT)
        self.assertEqual(expand(view["nodes"], view.get("defaults")),
                         [{**compact.get("node_defaults", {}), **n} for n in compact["nodes"]])
        self.assertEqual(expand(view["parents"], fieldsets=view.get("parent_fields", [])), compact["ancestors"])
        self.assertEqual(view["next_offset"], compact["page"]["next_offset"])
        self.assertLessEqual(wire_size(view), MAX_OUTPUT_BYTES)
        return view

    def test_webkit_and_dense_custom_rows_have_native_grouping_without_inferred_table_roles(self):
        for kind in ("WKWebView", "CustomContainer"):
            nodes = [node("root", native_type=kind)]
            for i in range(60):
                nodes.extend([node(f"r{i}", "root"), node(f"s{i}", f"r{i}", label=f"Symbol {i}"),
                              node(f"v{i}", f"r{i}", value=f"{i}.25")])
            view = self.assert_equivalent(raw(nodes))
            self.assertIsNotNone(view["next_offset"])
            seen = {n[0] for n in view["nodes"]}
            offset = view["next_offset"]
            while offset is not None:
                page = compact_snapshot(raw(nodes), ARCHIVE, offset=offset)
                seen.update(n["id"] for n in page["nodes"])
                offset = page["page"]["next_offset"]
            self.assertEqual(seen, {f"{prefix}{i}" for prefix in ("s", "v") for i in range(60)})

    def test_absent_null_empty_hidden_foreign_and_truncated_are_not_collapsed(self):
        source = raw([node("root", native_visible=False),
                      node("a", "root", label="Name", value=None),
                      node("b", "root", label="Name", value="", foreign_process=True),
                      node("c", "root", label="Name"),
                      node("d", "root", label="长" * 1000)])
        view = self.assert_equivalent(source)
        nodes = {n["id"]: n for n in expand(view["nodes"], view.get("defaults"))}
        self.assertIsNone(nodes["a"]["value"])
        self.assertEqual(nodes["b"]["value"], "")
        self.assertNotIn("value", nodes["c"])
        self.assertTrue(nodes["b"]["foreign_process"])
        self.assertIn("ancestor_visibility_conflict", nodes["a"]["warnings"])
        self.assertGreater(view["counts"]["preview_truncated_field_count"], 0)
        detail = compact_snapshot(source, ARCHIVE, node_id="d")
        self.assertEqual(detail["nodes"][0]["label"], "长" * 1000)

    def test_unavailable_archive_failure_and_cleanup_warning_are_explicit(self):
        source = {"source": "ios-native-ax", "status": "unavailable", "scope": "app",
                  "reason": {"code": "timeout", "message": "Timed out"},
                  "cleanup": {"status": "partial", "errors": [{"stage": "stop", "type": "TimeoutError"}]}}
        view = self.assert_equivalent(source)
        self.assertEqual(view["status"], "unavailable")
        self.assertEqual(view["reason"]["code"], "timeout")
        self.assertIsNone(view["counts"]["source_node_count"])
        self.assertEqual(view["cleanup"], "partial")
        self.assertEqual(view["cleanup_detail"]["errors"][0]["stage"], "stop")
        view = reading_snapshot(raw([node(f"n{i}", label="Text") for i in range(150)]),
                                {"status": "failed", "raw_path": None})
        self.assertNotIn("reader", view)
        self.assertIsNone(view["next_offset"])
        self.assertGreater(view["counts"]["remaining_view_node_count"], 0)

    def test_repeated_hidden_parent_fields_share_exact_sparse_values(self):
        nodes = [node("root")]
        for i in range(12):
            nodes.extend([node(f"p{i}", "root", native_visible=False),
                          node(f"n{i}", f"p{i}", label=f"Text {i}")])
        # Missing and explicitly-null attributes must not reuse the same set.
        del nodes[1]["process_id"]
        nodes[3]["process_id"] = None
        nodes[5]["foreign_process"] = 0
        view = self.assert_equivalent(raw(nodes))
        self.assertIn("parent_fields", view)
        self.assertTrue(any(len(row) == 3 and type(row[2]) is int for row in view["parents"]))
        parents = {n["id"]: n for n in expand(view["parents"], fieldsets=view["parent_fields"])}
        self.assertNotIn("process_id", parents["p0"])
        self.assertIsNone(parents["p1"]["process_id"])
        self.assertIs(type(parents["p2"]["foreign_process"]), int)


if __name__ == "__main__":
    unittest.main()
