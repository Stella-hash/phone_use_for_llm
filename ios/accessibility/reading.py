"""Small reading view of the existing bounded AX projection; no device I/O.

Rows retain source IDs and every parent edge. Sparse native fields preserve
absent/null/empty distinctions. Detailed diagnostics remain in the same archive.
"""
import json

from compact import compact_snapshot


FORMAT = "ios-ax-reading-v1"


def reading_snapshot(raw, archive):
    compact = compact_snapshot(raw, archive)
    result = {key: compact[key] for key in ("source", "status", "scope", "archive")}
    result.update(schema_version=1, format=FORMAT,
                  note="Incomplete, non-atomic native AX; visibility is not actionability.",
                  rows="[source_id,parent_id,native_fields]; defaults apply only to nodes; absent differs from null")
    result["nodes"] = [_row(node) for node in compact["nodes"]]
    result["parents"], parent_fields = _parent_rows(compact["ancestors"])
    if parent_fields:
        result["parent_fields"] = parent_fields
        result["rows"] += "; integer parent fields index parent_fields"
    if compact.get("node_defaults"):
        result["defaults"] = compact["node_defaults"]
    coverage = compact["coverage"]
    # Unknown counts remain null. Zero is evidence of zero in this captured
    # source/projection, never evidence of full native coverage.
    result["counts"] = {key: coverage.get(key) for key in (
        "source_node_count", "source_hidden_nodes_omitted", "keyboard_nodes_aggregated",
        "remaining_view_node_count", "context_content_omitted_count",
        "source_truncated_field_count", "preview_truncated_field_count")}
    result["next_offset"] = compact["page"]["next_offset"]
    if "reader" in compact:
        result["reader"] = compact["reader"]
    if "reason" in compact:
        result["reason"] = compact["reason"]
    for key in ("selection", "elapsed_ms"):
        if key in compact:
            result[key] = compact[key]
    cleanup = compact.get("cleanup", {})
    result["cleanup"] = cleanup.get("status", "unknown")
    # Warnings and partial cleanup must remain visible, even on successful AX.
    if cleanup.get("warning") or cleanup.get("errors") or cleanup.get("errors_omitted"):
        result["cleanup_detail"] = cleanup
    return result


def _row(node):
    fields = {key: value for key, value in node.items() if key not in ("id", "parent_id")}
    return [node["id"], node["parent_id"], fields] if fields else [node["id"], node["parent_id"]]


def _parent_rows(nodes):
    """Intern identical sparse parent fields; never invent missing attributes."""
    rows = [_row(node) for node in nodes]
    encode = lambda value: json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False)
    counts = {}
    for row in rows:
        if len(row) == 3:
            key = encode(row[2])
            counts[key] = counts.get(key, 0) + 1
    indexes, fields, packed = {}, [], []
    for row in rows:
        key = encode(row[2]) if len(row) == 3 else None
        if key is not None and counts[key] > 1:
            if key not in indexes:
                indexes[key] = len(fields)
                fields.append(row[2])
            packed.append([row[0], row[1], indexes[key]])
        else:
            packed.append(row)
    # Count the extra dictionary key and explanatory text as well as the rows.
    if fields and len(encode({"parents": packed, "parent_fields": fields})) + 45 < len(encode({"parents": rows})):
        return packed, fields
    return rows, []
