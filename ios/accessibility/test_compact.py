from copy import deepcopy
import json
import unittest

import compact


ARCHIVE = {"status": "saved", "raw_path": "/tmp/ax/fixture.json", "snapshot_id": "fixture-123"}


def node(node_id, parent=None, **values):
    return {"id": node_id, "parent_id": parent, "native_type": "UIView", "process_id": 41,
            "native_visible": True, "ancestor_native_hidden": False, "foreign_process": False, **values}


def raw(nodes, **extras):
    return {"source": "ios-native-ax", "schema_version": 1, "status": "ok", "scope": "point", "nodes": nodes,
            "selection": {"request_process_id": 41},
            "coverage": {"complete": False, "native_node_count": len(nodes) + 3, "hidden_nodes_omitted": 3,
                         "text_truncated_field_count": 0}, **extras}


def wire_size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode())


def expanded_nodes(result):
    return [{**result.get("node_defaults", {}), **record} for record in result["nodes"]]


class CompactTests(unittest.TestCase):
    def assert_bounded(self, result):
        self.assertLessEqual(wire_size(result), 12288)
        self.assertLessEqual(len(result["nodes"]) + len(result["ancestors"]), 128)
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(result["actionability"], "not_established")

    def test_shared_fields_roundtrip_source_records_with_explicit_overrides(self):
        nodes = [node(f"n{i}", native_type="UILabel", label=f"Price {i}", value=i) for i in range(16)]
        nodes[-1].update(native_type="UIButton", native_visible=False, process_id=99, foreign_process=True)
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertEqual(result["format"], "ios-ax-compact-v2")
        self.assertEqual(result["node_defaults_scope"], "nodes_only")
        self.assertEqual(result["node_defaults"]["native_type"], "UILabel")
        self.assertEqual(result["node_defaults"]["native_visible"], True)
        self.assertNotIn("native_visible", result["nodes"][0])
        self.assertIs(result["nodes"][-1]["native_visible"], False)
        self.assertEqual(expanded_nodes(result), nodes)
        self.assertIn("override node_defaults", result["read_hint"])
        self.assertIn("ancestors do not inherit", result["read_hint"])
        self.assert_bounded(result)

    def test_a_missing_source_field_disables_only_that_field_default(self):
        for field in ("native_type", "native_visible", "ancestor_native_hidden", "foreign_process", "process_id"):
            with self.subTest(field=field):
                nodes = [node(f"n{i}", native_type="UILabel", label="Text") for i in range(12)]
                del nodes[0][field]
                result = compact.compact_snapshot(raw(nodes), ARCHIVE)
                self.assertNotIn(field, result.get("node_defaults", {}))
                self.assertNotIn(field, expanded_nodes(result)[0])
                self.assertEqual(expanded_nodes(result), nodes)

    def test_null_false_zero_and_negative_zero_are_not_coerced_by_sharing(self):
        for exceptional in (None, False, 0, "0", "", 0.0, -0.0):
            with self.subTest(value=repr(exceptional)):
                nodes = [node(f"n{i}", label="Evidence") for i in range(12)]
                nodes[-1]["native_visible"] = exceptional
                result = compact.compact_snapshot(raw(nodes), ARCHIVE)
                restored = expanded_nodes(result)
                self.assertIs(type(restored[-1]["native_visible"]), type(exceptional))
                self.assertEqual(json.dumps(restored, sort_keys=True), json.dumps(nodes, sort_keys=True))
        nodes = [node(f"n{i}", label="Evidence", native_visible=False) for i in range(12)]
        nodes[-1]["native_visible"] = 0
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertIs(result["node_defaults"]["native_visible"], False)
        self.assertIs(type(result["nodes"][-1]["native_visible"]), int)
        nodes = [node(f"n{i}", label="Evidence", process_id=0.0) for i in range(12)]
        nodes[-1]["process_id"] = -0.0
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertEqual(json.dumps(expanded_nodes(result), sort_keys=True), json.dumps(nodes, sort_keys=True))

    def test_ancestor_stubs_do_not_inherit_shared_visibility_or_process(self):
        for hidden in (False, True):
            with self.subTest(hidden=hidden):
                root = node("root", native_visible=not hidden)
                children = [node(f"n{i}", "root", label="Child") for i in range(12)]
                result = compact.compact_snapshot(raw([root, *children]), ARCHIVE)
                self.assertIs(result["node_defaults"]["native_visible"], True)
                ancestor = result["ancestors"][0]
                if hidden:
                    self.assertIs(ancestor["native_visible"], False)
                    self.assertTrue(all(n["warnings"] == ["ancestor_visibility_conflict"] for n in result["nodes"]))
                else:
                    self.assertEqual(ancestor, {"id": "root", "parent_id": None})
                self.assert_bounded(result)

    def test_node_detail_keeps_explicit_native_fields_even_when_they_repeat(self):
        nodes = [node("root"), *[node(f"n{i}", "root", label="Detail", native_class="CustomControl") for i in range(12)]]
        result = compact.compact_snapshot(raw(nodes), ARCHIVE, node_id="root")
        self.assertNotIn("node_defaults", result)
        self.assertNotIn("node_defaults_scope", result)
        self.assertEqual(result["nodes"], nodes)

    def test_small_pages_do_not_pay_more_for_defaults_than_they_save(self):
        nodes = [node("a", label="One"), node("b", label="Two")]
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertNotIn("node_defaults", result)
        self.assertNotIn("node_defaults_scope", result)
        self.assertEqual(result["nodes"], nodes)

    def test_budget_uses_shared_encoding_and_defaults_are_local_to_each_page(self):
        nodes = [node(f"n{i}", native_type="UILabel", label="Text", native_visible=i < 128) for i in range(150)]
        first = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertEqual(first["page"]["returned_node_count"], 128)
        self.assertEqual(first["page"]["next_offset"], 128)
        self.assertIs(first["node_defaults"]["native_visible"], True)
        second = compact.compact_snapshot(raw(nodes), ARCHIVE, offset=128)
        self.assertIs(second["node_defaults"]["native_visible"], False)
        self.assertFalse(second["page"]["has_more"])
        self.assertEqual(expanded_nodes(first) + expanded_nodes(second), nodes)
        self.assert_bounded(first)
        self.assert_bounded(second)

    def test_shared_attribute_truncations_remain_explicit_and_are_not_defaulted(self):
        nodes = [node(f"n{i}", native_type="UILabel", label="Text") for i in range(12)]
        nodes[-1]["truncated_fields"] = [{"field": "native_type", "original_characters": 10, "returned_characters": 7}]
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        self.assertNotIn("native_type", result.get("node_defaults", {}))
        self.assertTrue(all(n["native_type"] == "UILabel" for n in result["nodes"]))
        self.assertEqual(expanded_nodes(result), nodes)

    def test_custom_rows_and_cell_wrappers_preserve_native_relationships(self):
        source = raw([node("root", label="Quotes"), node("r1", "root"), node("r2", "root"),
                      node("c1", "r1"), node("c2", "r1"), node("c3", "r2"), node("c4", "r2"),
                      node("s1", "c1", label="AAA"), node("v1", "c2", value="123.45"),
                      node("s2", "c3", label="BBB"), node("v2", "c4", value="678.90")])
        before = deepcopy(source)
        result = compact.compact_snapshot(source, ARCHIVE)
        self.assertEqual(source, before)
        self.assertEqual([n["id"] for n in result["nodes"]], ["root", "s1", "v1", "s2", "v2"])
        records = {n["id"]: n for n in result["nodes"] + result["ancestors"]}
        self.assertEqual(records[records["s1"]["parent_id"]]["parent_id"], "r1")
        self.assertEqual(records[records["v1"]["parent_id"]]["parent_id"], "r1")
        self.assertEqual(records[records["v2"]["parent_id"]]["parent_id"], "r2")
        self.assertNotIn("context_parent_id", json.dumps(result))
        self.assertEqual(result["coverage"]["omitted_node_count"], 0)
        self.assert_bounded(result)

    def test_paging_is_same_source_with_ancestor_context_and_no_disappearing_records(self):
        source = raw([node("root", label="Table"), *[node(f"n{i}", "root", label="价" * 256, value=str(i)) for i in range(180)]])
        offset, ids = 0, []
        while True:
            page = compact.compact_snapshot(source, ARCHIVE, offset=offset)
            self.assert_bounded(page)
            self.assertEqual(page["archive"], ARCHIVE)
            ids.extend(n["id"] for n in page["nodes"])
            if offset:
                self.assertIn("root", [n["id"] for n in page["ancestors"]])
            if not page["page"]["has_more"]:
                break
            self.assertGreater(page["page"]["next_offset"], offset)
            offset = page["page"]["next_offset"]
        self.assertEqual(ids, [n["id"] for n in source["nodes"]])

    def test_visible_child_retains_hidden_ancestor_conflict_and_foreign_context(self):
        source = raw([node("root", native_visible=False, process_id=99, foreign_process=True),
                      node("child", "root", native_type="UIButton", label="Open")])
        result = compact.compact_snapshot(source, ARCHIVE)
        child = result["nodes"][0]
        self.assertTrue(child["native_visible"])
        self.assertFalse(child["ancestor_native_hidden"])
        self.assertEqual(child["warnings"], ["ancestor_visibility_conflict"])
        self.assertFalse(result["ancestors"][0]["native_visible"])
        self.assertTrue(result["ancestors"][0]["foreign_process"])
        self.assert_bounded(result)

    def test_exact_scalar_types_missing_null_empty_and_duplicate_ids_are_not_merged(self):
        values = [None, "", 0, False, "0", "false"]
        nodes = [node(str(i), native_type="UITextField", value=value, label="Repeated") for i, value in enumerate(values)]
        nodes.append(node("missing", native_type="UITextField", label="Repeated"))
        result = compact.compact_snapshot(raw(nodes), ARCHIVE)
        for record, expected in zip(result["nodes"], values):
            self.assertIs(type(record["value"]), type(expected))
            self.assertEqual(record["value"], expected)
        self.assertNotIn("value", result["nodes"][-1])
        self.assertEqual(len(result["nodes"]), 7)

    def test_keyboard_aggregation_uses_native_roles_never_text_and_detail_can_read_it(self):
        source = raw([node("kb", native_class="UIKeyboardImpl"), node("key", "kb", label="Q"),
                      node("field", native_type="UITextField", value="Q"),
                      node("fake", native_type="UILabel", label="UIKeyboardImpl")])
        result = compact.compact_snapshot(source, ARCHIVE)
        self.assertEqual([n["id"] for n in result["nodes"]], ["field", "fake"])
        self.assertEqual(result["coverage"]["keyboard_nodes_aggregated"], 2)
        self.assertNotIn("source_ids", json.dumps(result))
        detail = compact.compact_snapshot(source, ARCHIVE, node_id="kb")
        self.assertEqual([n["id"] for n in detail["nodes"]], ["kb", "key"])

    def test_preview_truncation_is_distinct_from_native_truncation_and_detail_restores_available_text(self):
        text = "股票价格说明" * 100
        truncation = {"field": "value", "original_characters": 900, "returned_characters": len(text)}
        source = raw([node("a", label="Quote", value=text, truncated_fields=[truncation],
                           native_class="CustomQuote", frame={"x": 1, "y": 2})])
        result = compact.compact_snapshot(source, ARCHIVE)
        self.assertEqual(result["nodes"][0]["value"], text[:256])
        self.assertEqual(result["nodes"][0]["truncated_fields"], [truncation])
        self.assertEqual(result["nodes"][0]["preview_truncations"], [
            {"field": "value", "original_characters": len(text), "returned_characters": 256}])
        self.assertNotIn("frame", result["nodes"][0])
        self.assertNotIn("native_class", result["nodes"][0])
        detail = compact.compact_snapshot(source, ARCHIVE, node_id="a")
        self.assertEqual(detail["nodes"][0]["value"], text)
        self.assertEqual(detail["nodes"][0]["native_class"], "CustomQuote")
        self.assertNotIn("preview_truncations", detail["nodes"][0])
        self.assert_bounded(detail)

    def test_long_utf8_nodes_and_metadata_cannot_escape_budget(self):
        source = raw([node(f"n{i}", label="📈" * 2048, value="股" * 2048, identifier="字" * 2048) for i in range(512)],
                     cleanup={"warning": "警" * 10000, "errors": [{"stage": "坏" * 10000, "type": "X" * 10000}] * 100},
                     reason={"code": "x" * 10000, "message": "📉" * 10000},
                     selection={"method": "Q" * 10000, "request_process_id": 41})
        for selector in ({}, {"node_id": "n0"}):
            result = compact.compact_snapshot(source, ARCHIVE, **selector)
            self.assert_bounded(result)
            self.assertTrue(result["nodes"])
            self.assertEqual(result["cleanup"]["errors_omitted"], 96)
            self.assertTrue(result["nodes"][0]["preview_truncations"])

    def test_archive_failure_never_enables_continuation_or_returns_raw(self):
        source = raw([node(str(i), label="a" * 256) for i in range(200)])
        result = compact.compact_snapshot(source, {"status": "failed", "raw_path": "/must/not/be/used"})
        self.assertEqual(result["archive"], {"status": "failed", "raw_path": None})
        self.assertTrue(result["page"]["has_more"])
        self.assertIsNone(result["page"]["next_offset"])
        self.assertFalse(result["page"]["continuation_available"])
        self.assertNotIn("reader", result)
        self.assert_bounded(result)

    def test_deep_labeled_ancestors_remain_reachable_when_their_text_exceeds_a_page(self):
        source = raw([node(f"n{i}", f"n{i - 1}" if i else None, label="层" * 2048) for i in range(49)])
        offset, seen = 0, []
        while True:
            result = compact.compact_snapshot(source, ARCHIVE, offset=offset)
            self.assert_bounded(result)
            self.assertTrue(result["nodes"])
            seen.extend(n["id"] for n in result["nodes"])
            records = {n["id"]: n for n in result["nodes"] + result["ancestors"]}
            self.assertTrue(all(n["parent_id"] is None or n["parent_id"] in records for n in records.values()))
            if not result["page"]["has_more"]:
                break
            offset = result["page"]["next_offset"]
        self.assertEqual(seen, [f"n{i}" for i in range(49)])
        detail = compact.compact_snapshot(source, ARCHIVE, node_id="n48")
        self.assertEqual(detail["nodes"][0]["label"], "层" * 2048)
        self.assertEqual(len(detail["ancestors"]), 48)
        self.assertEqual(detail["coverage"]["context_content_omitted_count"], 48)
        self.assert_bounded(detail)

    def test_record_limit_counts_native_ancestor_stubs_and_paging_keeps_all_data(self):
        nodes = [node("root")]
        for i in range(100):
            nodes.extend([node(f"row{i}", "root"), node(f"data{i}", f"row{i}", value=i)])
        source = raw(nodes)
        first = compact.compact_snapshot(source, ARCHIVE)
        self.assert_bounded(first)
        self.assertTrue(first["page"]["has_more"])
        seen = [n["id"] for n in first["nodes"]]
        offset = first["page"]["next_offset"]
        while offset is not None:
            page = compact.compact_snapshot(source, ARCHIVE, offset=offset)
            self.assert_bounded(page)
            seen.extend(n["id"] for n in page["nodes"])
            offset = page["page"]["next_offset"]
        self.assertEqual(seen, [f"data{i}" for i in range(100)])

    def test_unavailable_and_invalid_selectors_do_not_become_empty_ui_success(self):
        source = raw([node("stale", label="stale")], status="unavailable", reason={"code": "native_refused", "message": "Unavailable"})
        result = compact.compact_snapshot(source, ARCHIVE)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["nodes"], [])
        self.assertIsNone(result["coverage"]["source_node_count"])
        self.assertEqual(result["reason"]["code"], "native_refused")
        for kwargs in ({"offset": -1}, {"offset": True}, {"offset": 2}, {"node_id": "unknown"}):
            with self.assertRaises(ValueError):
                compact.compact_snapshot(raw([node("n", label="x")]), ARCHIVE, **kwargs)
        for nodes in ([node("same"), node("same")], [node("a", "missing")], [node("a", "b"), node("b", "a")]):
            with self.assertRaises(ValueError):
                compact.compact_snapshot(raw(nodes), ARCHIVE)


if __name__ == "__main__":
    unittest.main()
