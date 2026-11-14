"""Bounded, deterministic presentation of one already captured native AX result.

This module performs no device, model, archive or configuration I/O. Node IDs and
parent links retain their native meanings; table relationships are never inferred.
"""
from copy import deepcopy
import json
import math
from pathlib import Path
import re


MAX_OUTPUT_BYTES = 12 * 1024
MAX_RECORDS = 128
TEXT_PREVIEW = 256
FORMAT = "ios-ax-compact-v2"
_KEYBOARD = re.compile(
    r"^(?:_?UIKeyboard|_?UIKB|UIRemoteKeyboardWindow$|UIInputSet(?:Container|Host)View$|"
    r"UIAccessibilityElementKBKey$|TUISystemInputAssistant|TUIPrediction)")
_CONTROLS = frozenset((
    "UIControl", "UIButton", "_UIButtonBarButton", "UIBarButtonItem", "UIAccessibilityButton",
    "UITextField", "UITextView", "UISearchTextField", "UISecureTextField", "UISwitch", "UISlider",
    "UIStepper", "UISegmentedControl", "UIPageControl", "UIPickerView", "UIDatePicker", "_UIDatePickerView"))
_TEXT = ("native_type", "label", "value", "identifier")
_DETAIL_TEXT = ("native_class", "native_bundle_id", "hint", "native_traits")
_FLAGS = ("native_visible", "ancestor_native_hidden", "foreign_process", "process_id")
_SHARED_FIELDS = ("native_type", *_FLAGS)
_DEFAULTS_HINT = "Node fields override node_defaults; ancestors do not inherit them."


def _size(value):
    return len(json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8"))


def _scalar(value):
    return value is None or type(value) in (str, bool, int) or (type(value) is float and math.isfinite(value))


def _scalar_key(value):
    # Python considers False == 0 and -0.0 == 0.0; these source encodings differ.
    return type(value), json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)


def _shared_nodes(records, read_hint):
    """Reversible, page-local encoding; never fill an absent source attribute."""
    packed = [dict(record) for record in records]
    defaults = {}
    for field in _SHARED_FIELDS:
        if not records or not all(field in record and not any(
                item["field"] == field for item in record.get("truncated_fields", [])
                + record.get("preview_truncations", [])) for record in records):
            continue
        counts, values = {}, {}
        for record in records:
            key = _scalar_key(record[field])
            counts[key] = counts.get(key, 0) + 1
            values[key] = record[field]
        common = max(counts, key=counts.get)
        if counts[common] < 2:
            continue
        defaults[field] = values[common]
        for record in packed:
            if _scalar_key(record[field]) == common:
                del record[field]
    if not defaults:
        return records, {}
    # Include the scope and consumer hint in the saving, not just the node list.
    original = {"nodes": records}
    if read_hint is not None:
        original["read_hint"] = read_hint
    proposed = {"nodes": packed, "node_defaults": defaults, "node_defaults_scope": "nodes_only",
                "read_hint": _DEFAULTS_HINT + (" " + read_hint if read_hint else "")}
    return (packed, defaults) if _size(proposed) < _size(original) else (records, {})


def _fields(source, keys, limit):
    """Copy only bounded scalar fields; preserve absent, null and empty values."""
    result = {}
    for key in keys:
        if key not in source:
            continue
        value = source[key]
        if not _scalar(value):
            raise ValueError("Invalid native AX scalar")
        if isinstance(value, str) and len(value) > limit:
            result[key] = value[:limit]
            result.setdefault("preview_truncations", []).append({
                "field": key, "original_characters": len(value), "returned_characters": limit})
        else:
            result[key] = value
    return result


def _index(raw):
    nodes = raw.get("nodes", []) if raw["status"] == "ok" else []
    if not isinstance(nodes, list) or len(nodes) > 512:
        raise ValueError("Invalid native AX node array")
    by_id, children = {}, {None: []}
    for node in nodes:
        if not isinstance(node, dict):
            raise ValueError("Invalid native AX node")
        node_id, parent_id = node.get("id"), node.get("parent_id")
        if (not isinstance(node_id, str) or not node_id or len(node_id.encode("utf-8")) > 128
                or node_id in by_id or "parent_id" not in node
                or (parent_id is not None and (not isinstance(parent_id, str) or not parent_id))):
            raise ValueError("Invalid or repeated native AX node ID")
        by_id[node_id] = node
        children.setdefault(parent_id, []).append(node_id)
        children.setdefault(node_id, [])
    for node in nodes:
        if node["parent_id"] is not None and node["parent_id"] not in by_id:
            raise ValueError("Missing native AX parent")
    order, paths = [], {}
    pending = [(node_id, ()) for node_id in reversed(children[None])]
    while pending:
        node_id, path = pending.pop()
        if node_id in paths or len(path) > 48:
            raise ValueError("Invalid native AX ancestry")
        paths[node_id] = path
        order.append(node_id)
        pending.extend((child, (*path, node_id)) for child in reversed(children[node_id]))
    if len(order) != len(nodes):
        raise ValueError("Cyclic native AX ancestry")
    return by_id, order, paths


def _source_truncations(node):
    fields = node.get("truncated_fields", [])
    if not isinstance(fields, list) or len(fields) > 16:
        raise ValueError("Invalid native AX truncation metadata")
    for item in fields:
        if (not isinstance(item, dict) or not isinstance(item.get("field"), str)
                or len(item["field"]) > 80 or not item["field"]
                or type(item.get("original_characters")) is not int
                or type(item.get("returned_characters")) is not int
                or not 0 <= item["returned_characters"] < item["original_characters"]):
            raise ValueError("Invalid native AX truncation metadata")
    return [{key: item[key] for key in ("field", "original_characters", "returned_characters")} for item in fields]


def _meaningful(node):
    truncated = {item["field"] for item in _source_truncations(node)}
    return ("native_type" not in truncated and node.get("native_type") in _CONTROLS) or any(
        key in node and node[key] is not None
        and (not isinstance(node[key], str) or bool(node[key].strip())) for key in ("label", "value", "identifier"))


def _keyboard(node):
    truncated = {item["field"] for item in _source_truncations(node)}
    return any(key not in truncated and isinstance(node.get(key), str) and _KEYBOARD.match(node[key])
               for key in ("native_type", "native_class"))


def _record(node, path, by_id, limit, *, stub=False, detail=False):
    result = {"id": node["id"], "parent_id": node["parent_id"]}
    hidden_ancestor = node.get("ancestor_native_hidden") is True or any(
        by_id[item].get("native_visible") is False or by_id[item].get("ancestor_native_hidden") is True for item in path)
    if stub:
        # Generic structural ancestry, including custom containers, is kept without
        # paying for repeated class/bundle names or assigning it an invented role.
        for key in _FLAGS:
            if key in node and (node.get("native_visible") is False or hidden_ancestor
                                or node.get("foreign_process") is True):
                result[key] = node[key]
    else:
        result.update(_fields(node, (*_TEXT, *(_DETAIL_TEXT if detail else ()), *_FLAGS), limit))
        truncations = _source_truncations(node)
        if truncations:
            result["truncated_fields"] = truncations
    if node.get("native_visible") is True and hidden_ancestor:
        result["warnings"] = ["ancestor_visibility_conflict"]
    return result


def _archive(value):
    if not isinstance(value, dict):
        raise ValueError("Archive metadata must be an object")
    if value.get("status") != "saved":
        return {"status": "failed", "raw_path": None}
    raw_path = value.get("raw_path")
    if (not isinstance(raw_path, str) or not Path(raw_path).is_absolute() or "\0" in raw_path
            or len(raw_path.encode("utf-8")) > 4096):
        raise ValueError("Saved AX archive needs a bounded absolute path")
    result = {"status": "saved", "raw_path": raw_path}
    if "snapshot_id" in value:
        snapshot_id = value["snapshot_id"]
        if not isinstance(snapshot_id, str) or not re.fullmatch(r"[a-zA-Z0-9_-]{1,128}", snapshot_id):
            raise ValueError("Invalid AX snapshot ID")
        result["snapshot_id"] = snapshot_id
    return result


def _envelope(raw, archive, offset, node_id):
    result = {"source": "ios-native-ax", "schema_version": 1, "format": FORMAT,
              "status": raw["status"], "scope": raw.get("scope") if raw.get("scope") in ("point", "app") else None,
              "atomic": False, "raw_only_local": True, "archive": archive,
              "limits": {"json_bytes": MAX_OUTPUT_BYTES, "records": MAX_RECORDS, "text_preview_characters": TEXT_PREVIEW},
              "geometry": "omitted_from_compact; available_in_archive", "actionability": "not_established",
              "coverage": {"complete": False}, "nodes": [], "ancestors": [],
              "page": {"offset": offset, "node_id": node_id, "order": "native-tree-depth-first"}}
    if archive["status"] == "saved" and "snapshot_id" in archive:
        result["reader"] = {"script": str(Path(__file__).with_name("tree.py").resolve()),
                            "args": ["--snapshot-id", archive["snapshot_id"]]}
        result["read_hint"] = ("Run python3 with reader.script and reader.args; append --offset page.next_offset for later records "
                               "or --node-id a source ID for native fields/subtree. This reads the same local snapshot without phone input/capture.")
    selection = raw.get("selection")
    if isinstance(selection, dict):
        result["selection"] = _fields(selection, ("method", "request_process_id", "root_process_id", "point_process_id",
                                                   "application_pid", "identity_stability_scope"), 80)
    cleanup = raw.get("cleanup")
    if isinstance(cleanup, dict):
        result["cleanup"] = _fields(cleanup, ("status", "not_started", "subscription_start", "subscription_stop",
                                               "connection_closed", "tunnel_closed", "pairing_scratch_removed", "warning"), 160)
        errors = cleanup.get("errors")
        if isinstance(errors, list):
            result["cleanup"]["errors"] = [_fields(item, ("stage", "type"), 80) for item in errors[:4] if isinstance(item, dict)]
            result["cleanup"]["errors_omitted"] = len(errors) - len(result["cleanup"]["errors"])
    if isinstance(raw.get("reason"), dict):
        result["reason"] = _fields(raw["reason"], ("code", "message"), TEXT_PREVIEW)
    if type(raw.get("elapsed_ms")) is int:
        result["elapsed_ms"] = raw["elapsed_ms"]
    event = raw.get("session_activity", {}).get("event_id") if isinstance(raw.get("session_activity"), dict) else None
    if type(event) is int and event > 0:
        result["source_event_id"] = event
    return result


def compact_snapshot(raw, archive, offset=0, node_id=None):
    """Present one native snapshot; offsets index meaningful records (all nodes for a subtree).

    `archive` is {status, raw_path, optional snapshot_id}. A failed archive never
    enables continuation. Default pages may share source fields through
    node_defaults, scoped only to nodes; explicit node fields override them.
    Detail views and ancestors always use explicit fields. Invalid source/selector
    shapes raise ValueError, so the caller can report a bounded failure.
    """
    if (not isinstance(raw, dict) or raw.get("source") != "ios-native-ax"
            or raw.get("status") not in ("ok", "unavailable") or "format" in raw):
        raise ValueError("Expected an original native AX snapshot")
    if type(offset) is not int or offset < 0 or (node_id is not None and not isinstance(node_id, str)):
        raise ValueError("Invalid AX snapshot selector")
    by_id, order, paths = _index(raw)
    if node_id is not None and node_id not in by_id:
        raise ValueError("Source node is absent from this snapshot")
    saved = _archive(archive)
    keyboard = set()
    meaningful = set()
    for item in order:
        node = by_id[item]
        if _keyboard(node) or any(parent in keyboard for parent in paths[item]):
            keyboard.add(item)
        elif _meaningful(node):
            meaningful.add(item)
    detail = node_id is not None
    view = ([item for item in order if item == node_id or node_id in paths[item]] if detail else
            [item for item in order if item in meaningful])
    if offset > len(view):
        raise ValueError("AX snapshot offset is beyond this view")
    result = _envelope(raw, saved, offset, node_id)
    source_coverage = raw.get("coverage", {})
    source_coverage = source_coverage if isinstance(source_coverage, dict) else {}
    source_counts = {"native_node_count": source_coverage.get("native_node_count"),
                     "source_hidden_nodes_omitted": source_coverage.get("hidden_nodes_omitted"),
                     "source_truncated_field_count": source_coverage.get("text_truncated_field_count")}
    for key, value in source_counts.items():
        if value is None or type(value) is int and value >= 0:
            result["coverage"][key] = value
    result["coverage"].update(source_complete=source_coverage.get("complete") if type(source_coverage.get("complete")) is bool else None,
                              source_node_count=len(by_id) if raw["status"] == "ok" else None,
                              meaningful_node_count=len(meaningful) if raw["status"] == "ok" else None,
                              keyboard_nodes_aggregated=(None if raw["status"] != "ok" else 0 if detail else len(keyboard)),
                              view_node_count=len(view))

    context_details = True
    base_read_hint = result.get("read_hint")

    def assemble(records):
        selected = {record["id"] for record in records}
        context = {ancestor for item in selected for ancestor in paths[item]} - selected
        result["nodes"], defaults = _shared_nodes(records, base_read_hint) if not detail else (records, {})
        if defaults:
            result["node_defaults"] = defaults
            result["node_defaults_scope"] = "nodes_only"
            result["read_hint"] = _DEFAULTS_HINT + (" " + base_read_hint if base_read_hint else "")
        else:
            result.pop("node_defaults", None)
            result.pop("node_defaults_scope", None)
            if base_read_hint is None:
                result.pop("read_hint", None)
            else:
                result["read_hint"] = base_read_hint
        result["ancestors"] = [_record(by_id[item], paths[item], by_id, TEXT_PREVIEW,
                                       stub=not context_details or item not in meaningful) for item in order if item in context]
        count = len(records)
        has_more = offset + count < len(view)
        result["page"].update(returned_node_count=count, has_more=has_more,
                              next_offset=offset + count if has_more and saved["status"] == "saved" else None,
                              continuation_available=has_more and saved["status"] == "saved")
        result["coverage"].update(returned_node_count=count, context_node_count=len(context),
                                  omitted_node_count=len(by_id) - count - len(context) if raw["status"] == "ok" else None,
                                  remaining_view_node_count=len(view) - offset - count,
                                  context_content_omitted_count=len(context & meaningful) if not context_details else 0,
                                  preview_truncated_field_count=sum(len(n.get("preview_truncations", []))
                                                                    for n in [*records, *result["ancestors"]]))

    records = []
    assemble(records)
    for item in view[offset:]:
        node = by_id[item]
        text_limit = max([TEXT_PREVIEW, *(len(value) for value in node.values() if isinstance(value, str))]) if detail else TEXT_PREVIEW
        while True:
            candidate = _record(node, paths[item], by_id, text_limit, detail=detail)
            assemble([*records, candidate])
            fits = len(result["nodes"]) + len(result["ancestors"]) <= MAX_RECORDS and _size(result) <= MAX_OUTPUT_BYTES
            if not fits and not records and context_details:
                # A deep path can contain more ancestor text than an entire page.
                # Keep every native parent link and disclose omitted context text,
                # allowing the selected node to remain reachable on its own page.
                context_details = False
                assemble([candidate])
                fits = len(result["nodes"]) + len(result["ancestors"]) <= MAX_RECORDS and _size(result) <= MAX_OUTPUT_BYTES
            if fits or records or text_limit == 0:
                break
            text_limit //= 2
        if not fits:
            assemble(records)
            if not records:
                raise ValueError("Native AX context cannot fit the compact output budget")
            break
        records.append(candidate)
    if _size(result) > MAX_OUTPUT_BYTES:
        raise ValueError("Native AX metadata cannot fit the compact output budget")
    return deepcopy(result)
