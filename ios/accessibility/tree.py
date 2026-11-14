#!/usr/bin/env python3
"""One-shot native iPhone AX or display observation. No focus or UI actions.

The captured private protocol and codec provenance are in UPSTREAM.txt. Requests
are application lookup, hit test and native snapshot reads only. A snapshot is
not an all-views guarantee, and an element's frame centre is not hit-test proof.
"""
import asyncio
from collections import deque
from dataclasses import dataclass
import functools
import importlib.metadata
import json
import logging
import math
import os
from pathlib import Path
import re
import shutil
import signal
import sys
import tempfile
import time

from ax_archive import decode, request

SERVICE = "com.apple.accessibility.axAuditDaemon.remoteAXService"
DISPLAY_SERVICE = "com.apple.coredevice.deviceinfo"
DISPLAY_FEATURE = "com.apple.coredevice.feature.getdisplayinfo"
MAX_NODES = 512
MAX_DEPTH = 48
MAX_TEXT = 2048
MAX_OUTPUT_BYTES = 256 * 1024
WORK_SECONDS = 8
CLEANUP_SECONDS = 3.5
SNAPSHOT_OPTIONS = {
    "attributes": [2001, 2002, 2003, 2004, 5019, 2006, 2025, 5003, 5004, 3003],
    "maxDepth": MAX_DEPTH, "maxChildren": MAX_NODES, "maxArrayCount": MAX_NODES,
    "traverseFromParentsToChildren": True, "snapshotKeyHonorModalViews": False,
}


class AXUnavailable(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Options:
    scope: str = "app"
    x: float = 500
    y: float = 500
    include_hidden: bool = False

    @classmethod
    def parse(cls, value):
        if not isinstance(value, dict) or set(value) - {"scope", "x", "y", "include_hidden"}:
            raise AXUnavailable("invalid_request", "Expected scope, x, y and include_hidden only")
        scope = value.get("scope", "app")
        if scope not in ("app", "point"):
            raise AXUnavailable("invalid_request", "scope must be app or point")
        coordinates = [value.get(key, 500) for key in ("x", "y")]
        if any(not isinstance(v, (int, float)) or isinstance(v, bool)
               or not math.isfinite(v) or not 0 <= v <= 1000 for v in coordinates):
            raise AXUnavailable("invalid_request", "x and y must be finite numbers in 0...1000")
        hidden = value.get("include_hidden", False)
        if not isinstance(hidden, bool):
            raise AXUnavailable("invalid_request", "include_hidden must be a boolean")
        return cls(scope, *coordinates, hidden)


@dataclass(frozen=True)
class PrimaryDisplay:
    """Primary app-display rotation, independent of physical device orientation."""
    native_orientation: str
    current_orientation: str
    native_width: float
    native_height: float

    @classmethod
    def parse(cls, info):
        if not isinstance(info, dict) or not isinstance(info.get("displays"), list):
            raise AXUnavailable("display_unavailable", "Native display information is unavailable")
        if info.get("current") is False:
            raise AXUnavailable("display_unavailable", "Native display information is marked stale")
        primary = [d for d in info["displays"] if isinstance(d, dict) and d.get("primary") is True]
        if len(primary) != 1:
            raise AXUnavailable("display_unavailable", "Primary display is ambiguous or absent")
        display = primary[0]
        if display.get("external") is not False:
            raise AXUnavailable("display_unavailable", "Primary display is not confirmed internal")
        rotations = {"rot0", "rot90", "rot180", "rot270"}
        native, current = display.get("nativeOrientation"), display.get("currentOrientation")
        if (not isinstance(native, str) or not isinstance(current, str)
                or native not in rotations or current not in rotations):
            raise AXUnavailable("unsupported_orientation", "Native display rotation is not a supported quarter turn")
        size, bounds = display.get("nativeSize"), display.get("bounds")
        if (not isinstance(size, list) or len(size) != 2
                or not isinstance(bounds, list) or len(bounds) != 2
                or any(not isinstance(pair, list) or len(pair) != 2 for pair in bounds)
                or any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
                       for v in size + [v for pair in bounds for v in pair])
                or any(v <= 0 for v in size + bounds[1])):
            raise AXUnavailable("display_unavailable", "Native display dimensions or bounds are invalid")
        width, height = size
        bound_width, bound_height = bounds[1]
        # CoreDevice bounds are in the native display axes on the measured
        # device even when the app is rotated. Allow raster/zoom-mode rounding,
        # but do not accept a different aspect or infer orientation from it.
        tolerance = 2 / min(height, bound_height)
        native_aspect, bound_aspect = width / height, bound_width / bound_height
        if (not all(math.isfinite(value) for value in (native_aspect, bound_aspect, tolerance))
                or abs(native_aspect - bound_aspect) > tolerance):
            raise AXUnavailable("display_aspect_mismatch", "Native display size and native bounds have inconsistent aspects")
        return cls(native, current, float(width), float(height))

    def json(self):
        rotation = (int(self.current_orientation[3:]) - int(self.native_orientation[3:])) % 360
        swapped = rotation in (90, 270)
        return {"native_orientation": self.native_orientation, "current_orientation": self.current_orientation,
                "native_width": self.native_width, "native_height": self.native_height,
                "display_width": self.native_height if swapped else self.native_width,
                "display_height": self.native_width if swapped else self.native_height,
                "rotation_degrees": rotation,
                "display_dimensions_source": "nativeSize rotated by currentOrientation relative to nativeOrientation"}


@dataclass(frozen=True)
class Geometry:
    x: float
    y: float
    width: float
    height: float
    point_scale: float

    @classmethod
    def parse(cls, info):
        if not isinstance(info, dict) or not isinstance(info.get("displays"), list):
            raise AXUnavailable("display_unavailable", "Native display geometry is unavailable")
        primary = [d for d in info["displays"] if isinstance(d, dict) and d.get("primary") is True]
        if len(primary) != 1:
            raise AXUnavailable("display_unavailable", "Primary display is ambiguous or absent")
        display = primary[0]
        if display.get("nativeOrientation") != "rot0" or display.get("currentOrientation") != "rot0":
            raise AXUnavailable("unsupported_orientation", "Native AX coordinate mapping is verified only in portrait")
        bounds, scale = display.get("bounds"), display.get("pointScale")
        if (not isinstance(bounds, list) or len(bounds) != 2
                or any(not isinstance(v, list) or len(v) != 2 for v in bounds)
                or not isinstance(scale, (int, float)) or isinstance(scale, bool)
                or not math.isfinite(scale) or scale <= 0
                or any(not isinstance(v, (int, float)) or isinstance(v, bool)
                       or not math.isfinite(v) for pair in bounds for v in pair)
                or any(v <= 0 for v in bounds[1])):
            raise AXUnavailable("display_unavailable", "Native display bounds or point scale are invalid")
        return cls(bounds[0][0] / scale, bounds[0][1] / scale,
                   bounds[1][0] / scale, bounds[1][1] / scale, float(scale))

    def point(self, x, y):
        return [self.x + self.width * x / 1000, self.y + self.height * y / 1000]

    def center(self, frame):
        if not frame or frame.get("width", 0) <= 0 or frame.get("height", 0) <= 0:
            return None
        x = (frame["x"] + frame["width"] / 2 - self.x) / self.width * 1000
        y = (frame["y"] + frame["height"] / 2 - self.y) / self.height * 1000
        if not 0 <= x <= 1000 or not 0 <= y <= 1000:
            return None
        return {"x": round(x, 4), "y": round(y, 4)}

    def json(self):
        return {"logical_origin": {"x": self.x, "y": self.y},
                "logical_width": self.width, "logical_height": self.height,
                "pixel_width": self.width * self.point_scale,
                "pixel_height": self.height * self.point_scale,
                "point_scale": self.point_scale, "orientation": "portrait"}


def identity(value):
    if (not isinstance(value, dict) or type(value.get("pid")) is not int
            or type(value.get("objectID")) is not int or value["pid"] <= 0
            or not 0 <= value["objectID"] < 2 ** 64):
        raise AXUnavailable("invalid_native_reply", "Native AX element identity is invalid")
    return value["pid"], value["objectID"]


def frame_value(value):
    if value == {"unavailable": "CGRectNull"}:
        return None
    if (not isinstance(value, dict) or set(value) != {"x", "y", "width", "height"}
            or any(type(v) not in (int, float) or not math.isfinite(v) for v in value.values())
            or value["width"] < 0 or value["height"] < 0):
        raise AXUnavailable("invalid_native_reply", "Native AX frame is invalid")
    return value


def limited_text(node, field, value, limit=MAX_TEXT):
    if not isinstance(value, str):
        raise AXUnavailable("invalid_native_reply", "Native AX text field has an unexpected type")
    node[field] = value[:limit]
    if len(value) > limit:
        node.setdefault("truncated_fields", []).append({
            "field": field, "original_characters": len(value), "returned_characters": limit})


def parse_snapshot(snapshot, geometry, request_pid):
    if not isinstance(snapshot, dict):
        raise AXUnavailable("snapshot_unavailable", "Device returned no native AX snapshot")
    identity(snapshot.get("UIAccessibilitySnapshotKeyElement"))
    pending = deque([(snapshot, None, 0)])
    nodes = []
    while pending:
        record, parent, depth = pending.popleft()
        if depth > MAX_DEPTH or len(nodes) >= MAX_NODES:
            raise AXUnavailable("snapshot_limit", "Native AX snapshot exceeds the node/depth budget; no partial tree emitted")
        if not isinstance(record, dict):
            raise AXUnavailable("invalid_native_reply", "Native AX snapshot record is invalid")
        element = record.get("UIAccessibilitySnapshotKeyElement")
        pid, _ = identity(element)
        children = record.get("UIAccessibilitySnapshotKeyChildren")
        count = record.get("UIAccessibilitySnapshotKeyChildrenCount")
        attrs = record.get("UIAccessibilitySnapshotKeyAttributes")
        if not isinstance(children, list) or type(count) is not int or count != len(children):
            raise AXUnavailable("incomplete_native_reply", "Native AX child count is absent or inconsistent")
        if not isinstance(attrs, dict):
            raise AXUnavailable("invalid_native_reply", "Native AX attributes are unavailable")
        index = len(nodes)
        node = {"id": f"n{index}", "parent_id": parent, "depth": depth,
                "process_id": pid, "foreign_process": pid != request_pid}
        parent_node = nodes[int(parent[1:])] if parent is not None else None
        node["ancestor_native_hidden"] = bool(parent_node is not None and (
            parent_node["ancestor_native_hidden"] or parent_node.get("native_visible") is False))
        for native_id, field in ((2001, "label"), (2002, "hint"), (5019, "identifier"),
                                 (5003, "native_class"), (5004, "native_type"), (3003, "native_bundle_id")):
            if attrs.get(native_id) is not None:
                limited_text(node, field, attrs[native_id])
        value = attrs.get(2006)
        if isinstance(value, str):
            limited_text(node, "value", value)
        elif value is not None:
            if type(value) not in (int, float, bool) or (isinstance(value, float) and not math.isfinite(value)):
                raise AXUnavailable("invalid_native_reply", "Native AX value has an unexpected type")
            node["value"] = value
        if attrs.get(2004) is not None:
            traits = attrs[2004]
            if type(traits) is not int or not -(1 << 63) <= traits < (1 << 64):
                raise AXUnavailable("invalid_native_reply", "Native AX traits are not a 64-bit integer")
            node["native_traits"] = str(traits)
        if attrs.get(2025) is not None:
            visible = attrs[2025]
            if type(visible) not in (bool, int) or visible not in (0, 1):
                raise AXUnavailable("invalid_native_reply", "Native AX visibility value is invalid")
            node["native_visible"] = bool(visible)
        if attrs.get(2003) is not None:
            frame = frame_value(attrs[2003])
            if frame is None:
                node["frame_unavailable"] = "CGRectNull"
            else:
                node["frame"] = frame
                center = geometry.center(frame)
                if center is not None:
                    node["center_normalized"] = center
        nodes.append(node)
        pending.extend((child, node["id"], depth + 1) for child in children)
    return {"root": snapshot["UIAccessibilitySnapshotKeyElement"], "nodes": nodes}


def project(tree, include_hidden):
    nodes = tree["nodes"]
    by_id = {node["id"]: node for node in nodes}
    keep = {node["id"] for node in nodes if include_hidden or node.get("native_visible") is not False}
    keep.add(nodes[0]["id"])
    for node_id in list(keep):
        parent = by_id[node_id]["parent_id"]
        while parent is not None:
            keep.add(parent)
            parent = by_id[parent]["parent_id"]
    returned = [node for node in nodes if node["id"] in keep]
    coverage = {
        "native_node_count": len(nodes), "returned_node_count": len(returned),
        "native_edge_count": len(nodes) - 1, "returned_edge_count": len(returned) - 1,
        "max_depth": max(node["depth"] for node in nodes),
        "projection": "all-native-records" if include_hidden else "native-visible-or-unknown-with-ancestors",
        "hidden_nodes_omitted": len(nodes) - len(returned),
        "text_truncated_field_count": sum(len(node.get("truncated_fields", [])) for node in returned),
        "foreign_process_node_count": sum(node["foreign_process"] for node in nodes),
        "complete": False,
        "reason": "Native AX snapshot only; custom drawing, unmaterialized UI and other processes may be absent. "
                  "native_visible is the native AX attribute, not hittability; ancestor_native_hidden preserves hidden-parent context. "
                  "Separate process snapshots are never merged.",
    }
    return returned, coverage


async def selected_tree(read, geometry, options):
    point = geometry.point(options.x, options.y)
    selected = await read(6, {"point": point})
    point_pid, _ = identity(selected)

    async def app(pid):
        result = await read(1, {"pid": pid})
        if identity(result)[0] != pid or not result.get("isApplicationElement"):
            raise AXUnavailable("identity_mismatch", "Native application lookup does not match its requested process")
        return result

    original_app = await app(point_pid)
    native = await read(2, {"parameter": SNAPSHOT_OPTIONS}, original_app)
    tree = parse_snapshot(native, geometry, point_pid)
    chosen_app = original_app
    method = "point-process-snapshot"
    if options.scope == "app":
        if identity(tree["root"]) == identity(original_app):
            method = "point-process-application-root"
        else:
            root_node = tree["nodes"][0]
            parent_pid = identity(tree["root"])[0]
            if (root_node.get("native_class") != "AXRemoteElement" or parent_pid == point_pid
                    or not any(n["process_id"] == point_pid for n in tree["nodes"])):
                raise AXUnavailable("app_scope_unavailable", "Point-selected snapshot is not a verified application root")
            chosen_app = await app(parent_pid)
            parent_native = await read(2, {"parameter": SNAPSHOT_OPTIONS}, chosen_app)
            parent_tree = parse_snapshot(parent_native, geometry, parent_pid)
            if identity(parent_tree["root"]) != identity(chosen_app):
                raise AXUnavailable("app_scope_unavailable", "Related process does not return its own native application root")
            child_ids = {n["parent_id"] for n in parent_tree["nodes"] if n["parent_id"] is not None}
            if not any(n["process_id"] == point_pid and n.get("native_class") == "AXRemoteElement"
                       and n["id"] not in child_ids for n in parent_tree["nodes"]):
                raise AXUnavailable("app_scope_unavailable", "Native parent application does not reference the point-selected process")
            tree = parent_tree
            method = "point-process-with-native-remote-parent"
    elif not any(n["process_id"] == point_pid for n in tree["nodes"]):
        raise AXUnavailable("identity_mismatch", "Native point snapshot does not contain its selected process")

    if identity(await app(chosen_app["pid"])) != identity(chosen_app):
        raise AXUnavailable("identity_changed", "Native application identity changed during observation")
    if identity(await read(6, {"point": point}))[0] != point_pid:
        raise AXUnavailable("identity_changed", "Point-selected process changed during observation")
    nodes, coverage = project(tree, options.include_hidden)
    selection = {"point_normalized": {"x": options.x, "y": options.y},
                 "point_process_id": point_pid, "request_process_id": chosen_app["pid"],
                 "root_process_id": identity(tree["root"])[0],
                 "application_pid": chosen_app["pid"] if options.scope == "app" else None,
                 "method": method, "identity_stability_scope": "application-and-point-process-only"}
    return {"selection": selection, "nodes": nodes, "coverage": coverage}


class Runtime:
    def __init__(self, target):
        self.target = target
        self.cache = None
        self.tunnel = None
        self.connection = None
        self.dtx = None
        self.subscribed = False
        self.queue = asyncio.Queue(maxsize=128)
        self.received_bytes = 0
        self.packet_error = None
        self.cleanup = {"subscription_stop": "not-started", "connection_closed": True,
                        "tunnel_closed": True, "pairing_scratch_removed": True, "errors": []}

    async def open(self, require_ax=True):
        from pymobiledevice3.lockdown import create_using_usbmux
        from pymobiledevice3.remote import userspace_tunnel as userspace
        if importlib.metadata.version("pymobiledevice3") != "11.50.0":
            raise AXUnavailable("dependency_mismatch", "Native iPhone helper requires pinned pymobiledevice3 11.50.0")
        self.cache = Path(tempfile.mkdtemp(prefix="iphone-use-ax-pair-"))
        self.cleanup["pairing_scratch_removed"] = False
        userspace.create_using_usbmux = functools.partial(
            create_using_usbmux, connection_type="USB", pairing_records_cache_folder=self.cache)
        self.tunnel = userspace.UserspaceRsdTunnel(serial=self.target, autopair=False, remotepairing_fallback=False)
        self.cleanup["tunnel_closed"] = False
        rsd = await self.tunnel.aopen()
        if rsd.udid != self.target:
            raise AXUnavailable("target_mismatch", "USB tunnel returned a different physical device")
        if require_ax and not isinstance(rsd.peer_info.get("Services", {}).get(SERVICE), dict):
            raise AXUnavailable("service_unavailable", "Device does not advertise the native AX service")
        return rsd

    async def primary_display(self, rsd):
        from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
        service = rsd.peer_info.get("Services", {}).get(DISPLAY_SERVICE)
        if not isinstance(service, dict):
            raise AXUnavailable("display_service_unavailable", "Device does not advertise the native display-info service")
        properties = service.get("Properties")
        features = properties.get("Features") if isinstance(properties, dict) else None
        if not isinstance(features, list) or DISPLAY_FEATURE not in features:
            raise AXUnavailable("display_feature_unavailable", "Device does not advertise the native display-info feature")
        async with DeviceInfoService(rsd) as service:
            return PrimaryDisplay.parse(await service.get_display_info())

    async def display(self, rsd):
        from pymobiledevice3.remote.core_device.device_info import DeviceInfoService
        async with DeviceInfoService(rsd) as service:
            return Geometry.parse(await service.get_display_info())

    async def connect_ax(self, rsd):
        from pymobiledevice3.dtx import DTXConnection
        from pymobiledevice3.dtx.service import DTXControlService, dtx_on_invoke
        owner = self

        class Control(DTXControlService):
            @dtx_on_invoke("hostAPIVersion")
            async def host_version(self):
                return 7

            @dtx_on_invoke("processDataFromRemoteDevice:")
            async def packet(self, data):
                if not isinstance(data, bytes) or len(data) > 20 * 1024 * 1024:
                    owner.packet_error = "Native AX packet size/type is invalid"
                    data = b""
                owner.received_bytes += len(data)
                if owner.received_bytes > 40 * 1024 * 1024:
                    owner.packet_error = "Native AX incoming byte budget exceeded"
                try:
                    owner.queue.put_nowait(data)
                except asyncio.QueueFull:
                    owner.packet_error = "Native AX notification queue budget exceeded"

        desc = rsd.peer_info["Services"][SERVICE]
        self.connection = await rsd.create_service_connection(int(desc["Port"]))
        self.cleanup["connection_closed"] = False
        self.dtx = DTXConnection(self.connection.reader, self.connection.writer)
        control = Control(self.dtx._control_svc._ctx)
        self.dtx._control_svc = control
        self.dtx._services[0] = control
        await self.dtx.connect()
        api = await self.dtx._ctrl_channel.invoke("deviceAPIVersion")
        if api != 26:
            raise AXUnavailable("protocol_unavailable", "Native AX API does not match the verified protocol")
        await self.subscribe()
        return api

    async def subscribe(self):
        # Delivery can succeed before its ACK is lost. Cleanup must attempt
        # unsubscribe as soon as the request may have reached the device.
        self.subscribed = True
        self.cleanup["subscription_start"] = "requested"
        self.cleanup["subscription_stop"] = "pending"
        await self.dtx._ctrl_channel.invoke("clientNeedsAccessibility:", True)
        self.cleanup["subscription_start"] = "acknowledged"

    async def read(self, kind, parameters, token=None):
        # The codec cannot emit actions. One semantic request is outstanding;
        # a timeout exits the session instead of reassigning a late reply.
        async with asyncio.timeout(3):
            await self.dtx._ctrl_channel.invoke("processDataFromHost:", request(kind, parameters, translation=token))
            while True:
                raw = await self.queue.get()
                if self.packet_error:
                    raise AXUnavailable("archive_limit", self.packet_error)
                reply = decode(raw)
                if not isinstance(reply, dict):
                    raise AXUnavailable("invalid_native_reply", "Native AX reply is not a record")
                if reply.get("associatedRequestType") != kind:
                    continue
                if reply.get("error") != 0:
                    raise AXUnavailable("native_refused", "Native AX read returned error " + str(reply.get("error"))[:32])
                if kind == 2 and (reply.get("attribute") != 52
                                  or identity(reply.get("associatedTranslationObject")) != identity(token)):
                    raise AXUnavailable("identity_mismatch", "Native snapshot reply does not match its request")
                return reply.get("resultData")

    async def close(self):
        async def attempt(name, operation, seconds):
            try:
                await asyncio.wait_for(operation(), seconds)
                return True
            except Exception as exc:
                self.cleanup["errors"].append({"stage": name, "type": type(exc).__name__})
                return False

        if self.subscribed:
            stopped = await attempt("subscription-stop", lambda: self.dtx._ctrl_channel.invoke("clientNeedsAccessibility:", False), 0.8)
            self.cleanup["subscription_stop"] = "acknowledged" if stopped else "not-acknowledged"
        if self.dtx is not None:
            await attempt("dtx-close", self.dtx.aclose, 0.8)
        if self.connection is not None:
            self.cleanup["connection_closed"] = await attempt("socket-close", self.connection.close, 0.5)
        if self.tunnel is not None:
            self.cleanup["tunnel_closed"] = await attempt("tunnel-close", self.tunnel.aclose, 1)

    def remove_cache(self):
        if self.cache is not None:
            try:
                shutil.rmtree(self.cache)
                self.cleanup["pairing_scratch_removed"] = True
            except OSError as exc:
                self.cleanup["errors"].append({"stage": "pairing-scratch-remove", "type": type(exc).__name__})


def base_result(scope="app"):
    return {"schema_version": 1, "source": "ios-native-ax", "status": "unavailable", "scope": scope,
            "coordinate_space": "device-logical-points", "center_coordinate_space": "normalized-0-1000",
            "center_semantics": "Geometric AX frame centre for reading only, not a touch target. Touch requires a fresh screenshot's frame.id passed as frame_id with that image's pixel coordinates. Hittability is not checked.",
            "atomic": False, "limits": {"native_nodes": MAX_NODES, "native_depth": MAX_DEPTH,
                                         "text_characters_per_field": MAX_TEXT, "json_bytes": MAX_OUTPUT_BYTES}}


def display_base_result():
    return {"schema_version": 1, "source": "ios-native-display", "status": "unavailable",
            "orientation_source": "primary-display-currentOrientation", "atomic": False}


async def observe(options, environment, runtime_type=Runtime, *, display_only=False):
    started = time.monotonic()
    result = display_base_result() if display_only else base_result(options.scope)
    operation = "Native display" if display_only else "Native AX"
    target = environment.get("IPHONE_USE_USB_DEVICE_ID", "")
    if not isinstance(target, str) or re.fullmatch(r"(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})", target) is None:
        result["reason"] = {"code": "not_configured", "message": "An exact physical USB device ID is required"}
        result["cleanup"] = {"not_started": True}
        return result
    runtime = runtime_type(target)
    failure = None
    payload = None
    try:
        async with asyncio.timeout(WORK_SECONDS):
            if display_only:
                rsd = await runtime.open(require_ax=False)
                result["device_id"] = target
                payload = {"display": (await runtime.primary_display(rsd)).json()}
            else:
                rsd = await runtime.open()
                geometry = await runtime.display(rsd)
                api = await runtime.connect_ax(rsd)
                payload = await selected_tree(runtime.read, geometry, options)
                if await runtime.display(rsd) != geometry:
                    raise AXUnavailable("display_changed", "Native display geometry changed during observation")
                payload.update(display=geometry.json(), device_api_version=api)
    except asyncio.CancelledError:
        failure = AXUnavailable("cancelled", operation + " observation was cancelled; no UI action was sent")
    except TimeoutError:
        failure = AXUnavailable("timeout", operation + " observation timed out; no alternate observation was substituted")
    except AXUnavailable as exc:
        failure = exc
    except Exception as exc:
        failure = AXUnavailable("service_error", operation + " service failed: " + type(exc).__name__)
    finally:
        try:
            async with asyncio.timeout(CLEANUP_SECONDS):
                await runtime.close()
        except (TimeoutError, asyncio.CancelledError):
            runtime.cleanup["errors"].append({"stage": "cleanup-budget", "type": "TimeoutError"})
        finally:
            runtime.remove_cache()
    result["cleanup"] = runtime.cleanup
    # Cleanup diagnostics do not invalidate an already validated observation.
    # Keep read status and cleanup confirmation separate, preserving both.
    if runtime.cleanup["errors"]:
        result["cleanup"]["status"] = "warning"
        result["cleanup"]["warning"] = "One or more cleanup steps failed or were not acknowledged; see errors."
    else:
        result["cleanup"]["status"] = "ok"
    if failure is None and payload is not None:
        result.update(payload)
        result["status"] = "ok"
    else:
        result["reason"] = {"code": failure.code, "message": str(failure).replace(target, "<target>")[:400]}
    result["elapsed_ms"] = round((time.monotonic() - started) * 1000)
    return result


def encoded_result(result):
    data = json.dumps(result, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
    if len(data) <= MAX_OUTPUT_BYTES:
        return data
    failure = display_base_result() if result.get("source") == "ios-native-display" else base_result(result.get("scope", "app"))
    failure.update(reason={"code": "output_limit", "message": "Native observation JSON exceeds the output budget; no partial result emitted"},
                   cleanup=result.get("cleanup", {}), elapsed_ms=result.get("elapsed_ms"))
    return json.dumps(failure, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


def detail_arguments(arguments):
    """The local detail route reads a saved source; it cannot select a device."""
    allowed = {"--snapshot-id", "--offset", "--node-id"}
    if len(arguments) % 2 or any(key not in allowed for key in arguments[::2]):
        raise AXUnavailable("invalid_request", "Use --snapshot-id ID with optional --offset N and --node-id ID")
    pairs = dict(zip(arguments[::2], arguments[1::2]))
    if len(pairs) * 2 != len(arguments) or "--snapshot-id" not in pairs:
        raise AXUnavailable("invalid_request", "A single snapshot ID is required")
    offset = pairs.get("--offset", "0")
    if not re.fullmatch(r"[0-9]{1,6}", offset):
        raise AXUnavailable("invalid_request", "offset must be a nonnegative record index")
    node_id = pairs.get("--node-id")
    if node_id is not None and (not node_id or len(node_id.encode("utf-8")) > 128 or "\0" in node_id):
        raise AXUnavailable("invalid_request", "Invalid native source ID")
    return pairs["--snapshot-id"], int(offset), node_id


def present_ax(raw, archive=None, *, offset=0, node_id=None, reading=False):
    """Public AX output is always bounded; the complete source stays local.

    Collection and the native source budget retain their existing contracts.
    Even projection/storage failures never fall back to printing the raw tree.
    """
    from compact import compact_snapshot, FORMAT, MAX_OUTPUT_BYTES as compact_budget
    from reading import reading_snapshot, FORMAT as reading_format
    from snapshots import save_snapshot
    saved = archive
    try:
        if saved is None:
            saved = save_snapshot(raw)
        compact = reading_snapshot(raw, saved) if reading else compact_snapshot(raw, saved, offset=offset, node_id=node_id)
        data = json.dumps(compact, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")
        if len(data) > compact_budget:
            raise ValueError("Compact output exceeded its budget")
        return data
    except Exception:
        # No exception body or native content is put into this failure record.
        failure = {"schema_version": 1, "source": "ios-native-ax", "format": reading_format if reading else FORMAT,
                   "status": "unavailable", "atomic": False, "scope": raw.get("scope", "app")
                   if raw.get("scope") in ("app", "point") else "app",
                   "reason": {"code": "compact_presentation_failed",
                              "message": "Could not present the requested native snapshot or selector; no raw tree returned."},
                   "native_status": raw.get("status") if raw.get("status") in ("ok", "unavailable") else "unknown",
                   "coverage": {"complete": False}, "actionability": "not_established",
                   "archive": {"status": "failed", "raw_path": None}}
        if isinstance(saved, dict) and saved.get("status") == "saved":
            # Produced by the local cache, never copied from a node's text.
            archive_path, snapshot_id = saved.get("raw_path"), saved.get("snapshot_id")
            if (isinstance(archive_path, str) and len(archive_path) <= 1024
                    and isinstance(snapshot_id, str) and len(snapshot_id) <= 128):
                failure["archive"] = {"status": "saved", "raw_path": archive_path, "snapshot_id": snapshot_id}
        return json.dumps(failure, ensure_ascii=False, separators=(",", ":")).encode("utf-8")


async def main():
    task = asyncio.current_task()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, task.cancel)
    display_only = sys.argv[1:] == ["--display-only"]
    archive = None
    offset, node_id = 0, None
    try:
        if display_only:
            result = await observe(Options(), os.environ, display_only=True)
        elif sys.argv[1:]:
            # This branch does not call observe(), open USB, or subscribe to AX.
            from snapshots import read_snapshot, SnapshotError
            snapshot_id, offset, node_id = detail_arguments(sys.argv[1:])
            try:
                result, archive = read_snapshot(snapshot_id)
            except SnapshotError as exc:
                raise AXUnavailable(exc.code, "The requested local AX snapshot is unavailable or invalid") from None
        else:
            raw = sys.stdin.buffer.read(8193)
            if len(raw) > 8192:
                raise AXUnavailable("invalid_request", "Native AX request exceeds its byte budget")
            options = Options.parse(json.loads(raw))
            result = await observe(options, os.environ)
    except (ValueError, UnicodeError, AXUnavailable) as exc:
        result = display_base_result() if display_only else base_result()
        result.update(reason={"code": getattr(exc, "code", "invalid_request"), "message": str(exc)[:400]},
                      cleanup={"not_started": True})
        archive = {"status": "failed", "raw_path": None}
        offset, node_id = 0, None
    if display_only:
        data = encoded_result(result)
    else:
        # Preserve the pre-existing native collection byte limit independently
        # of the much smaller public presentation budget.
        # A cache read has its own bounded-file check. Its local_snapshot stamp
        # is not part of the previously accepted native collection byte count.
        raw = result if archive and archive.get("status") == "saved" else json.loads(encoded_result(result))
        data = present_ax(raw, archive, offset=offset, node_id=node_id, reading=not sys.argv[1:])
    sys.stdout.buffer.write(data + b"\n")
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    os.umask(0o077)
    logging.disable(logging.CRITICAL)
    asyncio.run(main())
