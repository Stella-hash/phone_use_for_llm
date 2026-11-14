import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import subprocess
import sys
import types
import unittest
from unittest.mock import patch

import ax_archive
import tree


def handle(pid, object_id, app=False):
    return {"pid": pid, "objectID": object_id, "isApplicationElement": app}


def record(element, attrs=None, children=None):
    children = [] if children is None else children
    defaults = {2003: {"x": 0.0, "y": 0.0, "width": 393.0, "height": 852.0}, 2025: True}
    defaults.update(attrs or {})
    return {"UIAccessibilitySnapshotKeyElement": element,
            "UIAccessibilitySnapshotKeyAttributes": defaults,
            "UIAccessibilitySnapshotKeyChildren": children,
            "UIAccessibilitySnapshotKeyChildrenCount": len(children)}


GEOMETRY = tree.Geometry(0, 0, 393, 852, 3)
TARGET_ENV = {"IPHONE_USE_USB_DEVICE_ID": "00000000-0000000000000000"}


def display_info(rotation="rot270"):
    return {"current": True, "orientation": {"currentDeviceOrientation": "portrait"}, "displays": [
        {"primary": True, "external": False, "nativeOrientation": "rot0", "currentOrientation": rotation,
         "nativeSize": [1179.0, 2556.0], "bounds": [[0.0, 0.0], [1179.0, 2556.0]]},
        {"primary": False, "external": True, "name": "not-returned", "nativeSize": [0.0, 0.0]}]}


class NativeReads:
    def __init__(self, remote=True):
        self.point = handle(20, 200)
        self.web_app = handle(20, 201, True)
        self.host_app = handle(10, 101, True)
        self.host_reference = handle(10, 100)
        self.web = record(self.host_reference, {5003: "AXRemoteElement"}, [
            record(self.point, {5003: "WKAccessibilityWebPageObject"}, [
                record(handle(20, 202), {2001: "SCORE", 2006: "196"})])])
        self.host = record(self.host_app, {2001: "Chrome", 3003: "com.google.chrome.ios"}, [
            record(handle(10, 102), {2001: "返回", 5003: "UIButton"}),
            record(self.point, {5003: "AXRemoteElement"})])
        self.remote = remote
        self.calls = []
        self.final_point = self.point

    async def __call__(self, kind, parameters, token=None):
        self.calls.append((kind, parameters, token))
        if kind == 6:
            return self.final_point if len(self.calls) > 1 else self.point
        if kind == 1:
            return self.web_app if parameters["pid"] == 20 else self.host_app
        if kind == 2:
            if token["pid"] == 10:
                return self.host
            return self.web if self.remote else record(self.web_app, {2001: "A native app"})
        raise AssertionError("An action or unsupported read was attempted")


class ShapeTests(unittest.TestCase):
    def test_request_rejects_boolean_nonfinite_and_out_of_range_coordinates(self):
        for value in (True, float("nan"), float("inf"), -1, 1001, "500"):
            with self.subTest(value=value), self.assertRaises(tree.AXUnavailable):
                tree.Options.parse({"x": value})
        self.assertEqual(tree.Options.parse({}), tree.Options())

    def test_geometry_accepts_pymobiledevice_integer_subclass(self):
        class XPCInteger(int):
            pass
        info = {"displays": [{"primary": True, "nativeOrientation": "rot0", "currentOrientation": "rot0",
                              "bounds": [[0.0, 0.0], [1179.0, 2556.0]], "pointScale": XPCInteger(3)}]}
        self.assertEqual(tree.Geometry.parse(info), GEOMETRY)
        self.assertEqual(GEOMETRY.point(500, 500), [196.5, 426.0])
        info["displays"][0]["currentOrientation"] = "rot90"
        with self.assertRaisesRegex(tree.AXUnavailable, "portrait"):
            tree.Geometry.parse(info)

    def test_hidden_ancestor_context_and_parent_links_survive_projection(self):
        child = record(handle(1, 3), {2001: "unknown visibility"})
        del child["UIAccessibilitySnapshotKeyAttributes"][2025]
        root = record(handle(1, 1, True), {}, [
            record(handle(1, 2), {2025: False}, [child]),
            record(handle(1, 4), {2001: "hidden cached panel", 2025: False})])
        parsed = tree.parse_snapshot(root, GEOMETRY, 1)
        nodes, coverage = tree.project(parsed, False)
        unknown = next(n for n in nodes if n.get("label") == "unknown visibility")
        self.assertTrue(unknown["ancestor_native_hidden"])
        self.assertNotIn("native_visible", unknown)
        self.assertFalse(any(n.get("label") == "hidden cached panel" for n in nodes))
        self.assertEqual(coverage["hidden_nodes_omitted"], 1)
        self.assertTrue(all(n["parent_id"] is None or n["parent_id"] in {x["id"] for x in nodes} for n in nodes))

    def test_native_count_mismatch_refuses_tree(self):
        root = record(handle(1, 1, True))
        root["UIAccessibilitySnapshotKeyChildrenCount"] = 1
        with self.assertRaisesRegex(tree.AXUnavailable, "child count"):
            tree.parse_snapshot(root, GEOMETRY, 1)

    def test_distinct_paths_with_same_native_handle_are_preserved(self):
        leaf = handle(1, 3)
        root = record(handle(1, 1, True), {}, [record(leaf), record(leaf)])
        nodes = tree.parse_snapshot(root, GEOMETRY, 1)["nodes"]
        self.assertEqual(len(nodes), 3)
        self.assertNotEqual(nodes[1]["id"], nodes[2]["id"])

    def test_labels_truncate_explicitly_traits_preserve_integer_precision(self):
        root = record(handle(1, 1, True), {2001: "中" * (tree.MAX_TEXT + 4), 2004: 2 ** 64 - 1})
        node = tree.parse_snapshot(root, GEOMETRY, 1)["nodes"][0]
        self.assertEqual(len(node["label"]), tree.MAX_TEXT)
        self.assertEqual(node["truncated_fields"][0]["original_characters"], tree.MAX_TEXT + 4)
        self.assertEqual(node["native_traits"], "18446744073709551615")
        self.assertNotIn("role", node)

    def test_no_center_for_null_or_offscreen_frame(self):
        root = record(handle(1, 1, True), {2003: {"unavailable": "CGRectNull"}})
        node = tree.parse_snapshot(root, GEOMETRY, 1)["nodes"][0]
        self.assertEqual(node["frame_unavailable"], "CGRectNull")
        self.assertNotIn("center_normalized", node)
        self.assertIsNone(GEOMETRY.center({"x": 1000, "y": 0, "width": 10, "height": 10}))

    def test_snapshot_and_output_limits_are_explicit_failures(self):
        root = record(handle(1, 1, True), {}, [record(handle(1, 2))])
        with patch.object(tree, "MAX_NODES", 1), self.assertRaisesRegex(tree.AXUnavailable, "budget"):
            tree.parse_snapshot(root, GEOMETRY, 1)
        result = tree.base_result()
        result.update(status="ok", nodes=[{"label": "x" * tree.MAX_OUTPUT_BYTES}])
        encoded = json.loads(tree.encoded_result(result))
        self.assertEqual(encoded["status"], "unavailable")
        self.assertEqual(encoded["reason"]["code"], "output_limit")
        self.assertNotIn("nodes", encoded)

    def test_codec_has_no_action_request(self):
        with self.assertRaises(ValueError):
            ax_archive.request(7, {}, translation=handle(1, 1))
        archive = ax_archive.decode(ax_archive.request(1, {"pid": 1}))
        self.assertEqual(archive["requestType"], 1)
        self.assertEqual(archive["actionType"], 0)


class DisplayShapeTests(unittest.TestCase):
    def test_app_display_rotation_overrides_physical_portrait(self):
        for rotation, expected_size in (("rot0", (1179, 2556)), ("rot90", (2556, 1179)),
                                        ("rot180", (1179, 2556)), ("rot270", (2556, 1179))):
            with self.subTest(rotation=rotation):
                result = tree.PrimaryDisplay.parse(display_info(rotation)).json()
                self.assertEqual(result["native_orientation"], "rot0")
                self.assertEqual(result["current_orientation"], rotation)
                self.assertEqual((result["display_width"], result["display_height"]), expected_size)
                self.assertEqual(result["rotation_degrees"], int(rotation[3:]))
                self.assertNotIn("displays", result)
                self.assertNotIn("not-returned", json.dumps(result))

    def test_relative_rotation_uses_reported_native_orientation(self):
        info = display_info("rot270")
        info["displays"][0]["nativeOrientation"] = "rot90"
        result = tree.PrimaryDisplay.parse(info).json()
        self.assertEqual(result["rotation_degrees"], 180)
        self.assertEqual((result["display_width"], result["display_height"]), (1179, 2556))

    def test_external_ambiguous_stale_and_unsupported_rotations_are_refused(self):
        cases = []
        info = display_info(); info["displays"][0]["external"] = True; cases.append(info)
        info = display_info(); info["displays"].append(deepcopy(info["displays"][0])); cases.append(info)
        info = display_info(); info["current"] = False; cases.append(info)
        info = display_info(); info["displays"][0]["currentOrientation"] = "rot45"; cases.append(info)
        info = display_info(); info["displays"][0]["nativeOrientation"] = ["rot0"]; cases.append(info)
        cases.extend(({}, {"displays": []}, {"displays": "not a list"}))
        for info in cases:
            with self.subTest(info=info), self.assertRaises(tree.AXUnavailable):
                tree.PrimaryDisplay.parse(info)

    def test_bad_dimensions_and_inconsistent_aspect_are_refused(self):
        for size in ([True, 2556], [0, 2556], [-1, 2556], [float("nan"), 2556],
                     [float("inf"), 2556], [1179], "1179x2556"):
            info = display_info(); info["displays"][0]["nativeSize"] = size
            with self.subTest(size=size), self.assertRaises(tree.AXUnavailable):
                tree.PrimaryDisplay.parse(info)
        info = display_info(); info["displays"][0]["bounds"] = [[0, 0], [1000, 1000]]
        with self.assertRaisesRegex(tree.AXUnavailable, "inconsistent aspects"):
            tree.PrimaryDisplay.parse(info)
        # A one-pixel native-bounds rounding discrepancy does not imply rotation.
        info = display_info(); info["displays"][0]["bounds"] = [[0, 0], [1180, 2556]]
        self.assertEqual(tree.PrimaryDisplay.parse(info).current_orientation, "rot270")

    def test_display_only_cli_requires_no_stdin_and_never_guesses_a_target(self):
        environment = {key: value for key, value in os.environ.items()
                       if key != "IPHONE_USE_USB_DEVICE_ID" and not key.startswith("PYMOBILEDEVICE3_")}
        completed = subprocess.run([sys.executable, str(Path(tree.__file__)), "--display-only"],
                                   stdin=subprocess.DEVNULL, capture_output=True, env=environment, timeout=3)
        self.assertEqual(completed.returncode, 0, completed.stderr.decode())
        result = json.loads(completed.stdout)
        self.assertEqual(result["source"], "ios-native-display")
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"]["code"], "not_configured")
        self.assertEqual(result["cleanup"], {"not_started": True})


class SelectionTests(unittest.IsolatedAsyncioTestCase):
    async def test_app_scope_follows_confirmed_remote_parent_without_merging(self):
        reads = NativeReads()
        result = await tree.selected_tree(reads, GEOMETRY, tree.Options())
        self.assertEqual(result["selection"]["application_pid"], 10)
        self.assertEqual(result["nodes"][0]["label"], "Chrome")
        self.assertFalse(any(n.get("label") == "SCORE" for n in result["nodes"]))
        self.assertEqual({call[0] for call in reads.calls}, {1, 2, 6})

    async def test_point_scope_returns_native_content_with_scope_boundary(self):
        reads = NativeReads()
        result = await tree.selected_tree(reads, GEOMETRY, tree.Options(scope="point"))
        self.assertIsNone(result["selection"]["application_pid"])
        self.assertEqual(result["selection"]["request_process_id"], 20)
        self.assertTrue(any(n.get("value") == "196" for n in result["nodes"]))
        self.assertFalse(result["coverage"]["complete"])
        self.assertEqual(sum(call[0] == 2 for call in reads.calls), 1)

    async def test_app_scope_rejects_parent_without_reverse_native_reference(self):
        reads = NativeReads()
        reads.host = record(reads.host_app, {2001: "Unrelated app"})
        with self.assertRaisesRegex(tree.AXUnavailable, "does not reference"):
            await tree.selected_tree(reads, GEOMETRY, tree.Options())

    async def test_regular_app_needs_only_one_snapshot(self):
        reads = NativeReads(remote=False)
        result = await tree.selected_tree(reads, GEOMETRY, tree.Options())
        self.assertEqual(result["selection"]["application_pid"], 20)
        self.assertEqual(sum(call[0] == 2 for call in reads.calls), 1)

    async def test_changed_point_process_does_not_emit_stale_app_tree(self):
        reads = NativeReads()
        reads.final_point = handle(30, 300)
        with self.assertRaisesRegex(tree.AXUnavailable, "changed"):
            await tree.selected_tree(reads, GEOMETRY, tree.Options())


class FakeRuntime:
    instances = []
    fail_open = False
    slow_connect = False
    bad_cleanup = False

    def __init__(self, target):
        self.target = target
        self.reads = NativeReads()
        self.cleanup = {"errors": []}
        self.closed = False
        self.removed = False
        type(self).instances.append(self)

    async def open(self):
        if self.fail_open:
            raise tree.AXUnavailable("service_unavailable", "Native AX service absent")
        return object()

    async def display(self, rsd):
        return GEOMETRY

    async def connect_ax(self, rsd):
        if self.slow_connect:
            await asyncio.sleep(1)
        return 26

    async def read(self, *args):
        return await self.reads(*args)

    async def close(self):
        self.closed = True
        if self.bad_cleanup:
            self.cleanup["errors"].append({"stage": "subscription-stop", "type": "TimeoutError"})

    def remove_cache(self):
        self.removed = True


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeRuntime.instances = []
        FakeRuntime.fail_open = False
        FakeRuntime.slow_connect = False
        FakeRuntime.bad_cleanup = False

    async def test_success_closes_owned_transport(self):
        result = await tree.observe(tree.Options(), TARGET_ENV, FakeRuntime)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["cleanup"]["status"], "ok")
        self.assertTrue(FakeRuntime.instances[0].closed)
        self.assertTrue(FakeRuntime.instances[0].removed)

    async def test_missing_exact_device_never_opens_transport(self):
        result = await tree.observe(tree.Options(), {}, FakeRuntime)
        self.assertEqual(result["reason"]["code"], "not_configured")
        self.assertEqual(FakeRuntime.instances, [])

    async def test_missing_service_is_explicit_without_fallback(self):
        FakeRuntime.fail_open = True
        result = await tree.observe(tree.Options(), TARGET_ENV, FakeRuntime)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"]["code"], "service_unavailable")
        self.assertNotIn("nodes", result)
        self.assertTrue(FakeRuntime.instances[0].closed)

    async def test_timeout_still_closes_transport(self):
        FakeRuntime.slow_connect = True
        with patch.object(tree, "WORK_SECONDS", 0.01):
            result = await tree.observe(tree.Options(), TARGET_ENV, FakeRuntime)
        self.assertEqual(result["reason"]["code"], "timeout")
        self.assertTrue(FakeRuntime.instances[0].closed)
        self.assertTrue(FakeRuntime.instances[0].removed)

    async def test_cleanup_warning_preserves_validated_native_tree(self):
        class AckLostRuntime(FakeRuntime):
            async def close(self):
                self.closed = True
                self.cleanup.update(subscription_stop="not-acknowledged", connection_closed=True, tunnel_closed=True,
                                    errors=[{"stage": "subscription-stop", "type": "ConnectionTerminatedError"}])

        result = await tree.observe(tree.Options(), TARGET_ENV, AckLostRuntime)
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["nodes"][0]["label"], "Chrome")
        self.assertNotIn("reason", result)
        self.assertEqual(result["cleanup"]["status"], "warning")
        self.assertTrue(result["cleanup"]["warning"])
        self.assertEqual(result["cleanup"]["subscription_stop"], "not-acknowledged")
        self.assertEqual(result["cleanup"]["errors"], [{"stage": "subscription-stop", "type": "ConnectionTerminatedError"}])
        self.assertTrue(result["cleanup"]["connection_closed"])
        self.assertTrue(result["cleanup"]["tunnel_closed"])

    async def test_primary_read_failure_survives_cleanup_failure(self):
        class FailedReadRuntime(FakeRuntime):
            bad_cleanup = True

            async def read(self, *args):
                raise tree.AXUnavailable("native_refused", "Native AX read returned error 7")

        result = await tree.observe(tree.Options(), TARGET_ENV, FailedReadRuntime)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"], {"code": "native_refused", "message": "Native AX read returned error 7"})
        self.assertEqual(result["cleanup"]["errors"], [{"stage": "subscription-stop", "type": "TimeoutError"}])
        self.assertEqual(result["cleanup"]["status"], "warning")
        self.assertTrue(result["cleanup"]["warning"])
        self.assertNotIn("nodes", result)
        self.assertTrue(FailedReadRuntime.instances[-1].closed)
        self.assertTrue(FailedReadRuntime.instances[-1].removed)

    async def test_lost_subscription_ack_still_attempts_unsubscribe(self):
        calls = []

        class Control:
            async def invoke(self, selector, enabled):
                calls.append((selector, enabled))
                if enabled:
                    raise TimeoutError("ACK lost after possible remote activation")

        class DTX:
            _ctrl_channel = Control()

            async def aclose(self):
                pass

        runtime = tree.Runtime(TARGET_ENV["IPHONE_USE_USB_DEVICE_ID"])
        runtime.dtx = DTX()
        with self.assertRaises(TimeoutError):
            await runtime.subscribe()
        self.assertEqual(runtime.cleanup["subscription_start"], "requested")
        await runtime.close()
        self.assertEqual(calls, [("clientNeedsAccessibility:", True), ("clientNeedsAccessibility:", False)])
        self.assertEqual(runtime.cleanup["subscription_stop"], "acknowledged")


class FakeDisplayRuntime(FakeRuntime):
    slow_display = False

    async def open(self, require_ax=True):
        self.require_ax = require_ax
        return object()

    async def primary_display(self, rsd):
        if self.slow_display:
            await asyncio.sleep(1)
        return tree.PrimaryDisplay.parse(display_info())

    async def display(self, rsd):
        raise AssertionError("Display-only mode must not use the portrait AX mapping")

    async def connect_ax(self, rsd):
        raise AssertionError("Display-only mode must not connect or subscribe to AX")

    async def read(self, *args):
        raise AssertionError("Display-only mode must not issue AX reads")


class DisplayLifecycleTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        FakeDisplayRuntime.instances = []
        FakeDisplayRuntime.slow_display = False
        FakeDisplayRuntime.bad_cleanup = False

    async def test_display_only_opens_exact_target_without_ax_and_cleans_up(self):
        result = await tree.observe(tree.Options(), TARGET_ENV, FakeDisplayRuntime, display_only=True)
        runtime = FakeDisplayRuntime.instances[0]
        self.assertEqual(result["source"], "ios-native-display")
        self.assertEqual(result["status"], "ok")
        self.assertEqual(result["device_id"], TARGET_ENV["IPHONE_USE_USB_DEVICE_ID"])
        self.assertEqual(runtime.target, TARGET_ENV["IPHONE_USE_USB_DEVICE_ID"])
        self.assertFalse(runtime.require_ax)
        self.assertEqual(result["display"]["current_orientation"], "rot270")
        self.assertNotIn("nodes", result)
        self.assertNotIn("device_api_version", result)
        self.assertTrue(runtime.closed)
        self.assertTrue(runtime.removed)

    async def test_display_timeout_is_bounded_and_still_cleans_up(self):
        FakeDisplayRuntime.slow_display = True
        with patch.object(tree, "WORK_SECONDS", 0.01):
            result = await tree.observe(tree.Options(), TARGET_ENV, FakeDisplayRuntime, display_only=True)
        self.assertEqual(result["status"], "unavailable")
        self.assertEqual(result["reason"]["code"], "timeout")
        self.assertNotIn("display", result)
        self.assertTrue(FakeDisplayRuntime.instances[0].closed)
        self.assertTrue(FakeDisplayRuntime.instances[0].removed)

    async def test_runtime_display_open_can_skip_ax_but_not_target_validation(self):
        selected = TARGET_ENV["IPHONE_USE_USB_DEVICE_ID"]
        opened = []

        class Tunnel:
            returned_target = selected

            def __init__(self, **kwargs):
                opened.append(kwargs)

            async def aopen(self):
                return types.SimpleNamespace(udid=self.returned_target, peer_info={"Services": {}})

            async def aclose(self):
                pass

        package = types.ModuleType("pymobiledevice3"); package.__path__ = []
        lockdown = types.ModuleType("pymobiledevice3.lockdown")
        lockdown.create_using_usbmux = lambda **kwargs: None
        remote = types.ModuleType("pymobiledevice3.remote"); remote.__path__ = []
        userspace = types.ModuleType("pymobiledevice3.remote.userspace_tunnel")
        userspace.UserspaceRsdTunnel = Tunnel
        remote.userspace_tunnel = userspace
        modules = {"pymobiledevice3": package, "pymobiledevice3.lockdown": lockdown,
                   "pymobiledevice3.remote": remote, "pymobiledevice3.remote.userspace_tunnel": userspace}
        with patch.dict(sys.modules, modules), patch.object(tree.importlib.metadata, "version", return_value="11.50.0"):
            runtime = tree.Runtime(selected)
            try:
                await runtime.open(require_ax=False)
                cache = runtime.cache
                self.assertTrue(cache.is_dir())
                self.assertEqual(opened[-1], {"serial": selected, "autopair": False, "remotepairing_fallback": False})
                self.assertEqual(userspace.create_using_usbmux.keywords["connection_type"], "USB")
            finally:
                await runtime.close()
                runtime.remove_cache()
            self.assertFalse(cache.exists())
            self.assertTrue(runtime.cleanup["pairing_scratch_removed"])

            Tunnel.returned_target = "00000000-0000000000000001"
            runtime = tree.Runtime(selected)
            try:
                with self.assertRaisesRegex(tree.AXUnavailable, "different physical device"):
                    await runtime.open(require_ax=False)
            finally:
                await runtime.close()
                runtime.remove_cache()
            self.assertFalse(runtime.cache.exists())

    async def test_display_mode_still_requires_advertised_core_display_feature(self):
        module = types.ModuleType("pymobiledevice3.remote.core_device.device_info")

        class UnexpectedService:
            def __init__(self, rsd):
                raise AssertionError("Missing display capability must be rejected before service invocation")

        module.DeviceInfoService = UnexpectedService
        with patch.dict(sys.modules, {"pymobiledevice3.remote.core_device.device_info": module}):
            runtime = tree.Runtime(TARGET_ENV["IPHONE_USE_USB_DEVICE_ID"])
            for services, code in (({}, "display_service_unavailable"),
                                   ({tree.DISPLAY_SERVICE: {"Properties": {"Features": []}}}, "display_feature_unavailable")):
                with self.subTest(code=code), self.assertRaises(tree.AXUnavailable) as caught:
                    await runtime.primary_display(types.SimpleNamespace(peer_info={"Services": services}))
                self.assertEqual(caught.exception.code, code)


if __name__ == "__main__":
    unittest.main()
