"""Exact-USB screenshot boundary tests using only synthetic Runtime/services."""
import asyncio
import base64
import io
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import types
import unittest
from unittest.mock import patch

import screenshot


TARGET = "11111111-1111111111111111"
PNG = base64.b64decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=")
SERVICE_MODULE = "pymobiledevice3.remote.core_device.screen_capture_service"


class CaptureTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.calls = []
        self.returned_target = TARGET
        self.result = {"image": PNG}
        self.hold_at = None
        self.read_error = None
        self.close_error = None
        self.cleanup_error_at = None
        self.runtime = None
        owner = self

        class Runtime:
            def __init__(self, target):
                owner.assertEqual(target, TARGET)
                owner.calls.append("runtime")
                owner.runtime = self
                self.cleanup = {"connection_closed": True, "tunnel_closed": False,
                                "pairing_scratch_removed": False, "errors": []}

            async def open(self, *, require_ax):
                owner.assertIs(require_ax, False)
                owner.calls.append("open_without_ax")
                if owner.hold_at == "open":
                    await asyncio.Event().wait()
                return types.SimpleNamespace(udid=owner.returned_target)

            async def close(self):
                owner.calls.append("close")
                self.cleanup["tunnel_closed"] = True
                if owner.cleanup_error_at == "close":
                    self.cleanup["tunnel_closed"] = False
                    self.cleanup["errors"].append({"stage": "tunnel-close", "type": "TimeoutError"})
                if owner.close_error is not None:
                    raise owner.close_error

            def remove_cache(self):
                owner.calls.append("remove_cache")
                self.cleanup["pairing_scratch_removed"] = True
                if owner.cleanup_error_at == "remove_cache":
                    self.cleanup["pairing_scratch_removed"] = False
                    self.cleanup["errors"].append({"stage": "pairing-scratch-remove", "type": "OSError"})

        class Service:
            def __init__(self, rsd):
                owner.assertEqual(rsd.udid, TARGET)
                owner.calls.append("service")

            async def __aenter__(self):
                owner.calls.append("service_enter")
                return self

            async def capture_screenshot(self, *, requested_format):
                owner.assertEqual(requested_format, "png")
                owner.calls.append("capture_png")
                if owner.hold_at == "capture":
                    await asyncio.Event().wait()
                if owner.read_error is not None:
                    raise owner.read_error
                return owner.result

            async def __aexit__(self, *args):
                owner.calls.append("service_exit")

        self.factory = Runtime
        self.service_patch = patch.dict(sys.modules, {SERVICE_MODULE: types.SimpleNamespace(ScreenCaptureService=Service)})
        self.service_patch.start()
        self.addCleanup(self.service_patch.stop)

    async def capture(self):
        return await screenshot.capture(TARGET, runtime_factory=self.factory)

    async def test_success_uses_exact_target_without_ax_and_returns_png_after_cleanup(self):
        self.assertEqual(await self.capture(), PNG)
        self.assertEqual(self.calls, ["runtime", "open_without_ax", "service", "service_enter", "capture_png",
                                     "service_exit", "close", "remove_cache"])
        self.assertEqual(self.runtime.cleanup["errors"], [])

    async def test_mismatched_rsd_target_is_rejected_before_screenshot_service(self):
        self.returned_target = "22222222-2222222222222222"
        with self.assertRaisesRegex(ValueError, "target mismatch"):
            await self.capture()
        self.assertEqual(self.calls, ["runtime", "open_without_ax", "close", "remove_cache"])

    async def test_invalid_target_never_constructs_runtime(self):
        for target in ("", "capture-alias", "11111111-1111111111111111-extra"):
            with self.subTest(target=target), self.assertRaises(ValueError):
                await screenshot.capture(target, runtime_factory=self.factory)
        self.assertEqual(self.calls, [])

    async def test_invalid_output_is_rejected_and_owned_resources_close(self):
        invalid = [None, [], {}, {"image": None}, {"image": PNG.decode("latin1")},
                   {"image": bytearray(PNG)}, {"image": b"not a PNG payload"}, {"image": PNG[:8]}]
        for result in invalid:
            with self.subTest(result_type=type(result).__name__):
                self.calls.clear()
                self.result = result
                with self.assertRaisesRegex(ValueError, "bounded PNG"):
                    await self.capture()
                self.assertEqual(self.calls[-3:], ["service_exit", "close", "remove_cache"])
        self.result = {"image": PNG}
        with patch.object(screenshot, "MAX_PNG", len(PNG) - 1), self.assertRaisesRegex(ValueError, "bounded PNG"):
            await self.capture()
        self.assertEqual(self.calls[-3:], ["service_exit", "close", "remove_cache"])

    async def test_timeout_during_open_or_capture_still_closes_runtime_and_cache(self):
        for phase in ("open", "capture"):
            with self.subTest(phase=phase):
                self.calls.clear()
                self.hold_at = phase
                with patch.object(screenshot, "WORK_SECONDS", .01), self.assertRaises(TimeoutError):
                    await self.capture()
                self.assertEqual(self.calls[-2:], ["close", "remove_cache"])
                if phase == "open":
                    self.assertNotIn("service", self.calls)
                else:
                    self.assertIn("service_exit", self.calls)

    async def test_recorded_close_or_cache_error_prevents_successful_png_return(self):
        for phase in ("close", "remove_cache"):
            with self.subTest(phase=phase):
                self.calls.clear()
                self.cleanup_error_at = phase
                with self.assertRaises(screenshot.ScreenshotCleanupError):
                    await self.capture()
                self.assertEqual(self.calls[-2:], ["close", "remove_cache"])

    async def test_primary_read_failure_survives_recorded_cleanup_failure(self):
        self.read_error = ConnectionError("private service detail")
        self.cleanup_error_at = "close"
        with self.assertRaises(ConnectionError):
            await self.capture()
        self.assertEqual(self.calls[-3:], ["service_exit", "close", "remove_cache"])
        self.assertTrue(self.runtime.cleanup["errors"])

    async def test_raised_close_failure_still_attempts_cache_removal(self):
        self.close_error = RuntimeError("private close detail")
        with self.assertRaises(RuntimeError):
            await self.capture()
        self.assertEqual(self.calls[-2:], ["close", "remove_cache"])

    async def test_cli_emits_only_png_on_success_and_no_png_or_private_detail_on_failure(self):
        original_capture = screenshot.capture

        async def controlled_capture(target):
            self.assertEqual(target, TARGET)
            return await original_capture(target, runtime_factory=self.factory)

        for failed_cleanup in (False, True):
            with self.subTest(failed_cleanup=failed_cleanup):
                self.cleanup_error_at = "close" if failed_cleanup else None
                stdout, stderr = io.BytesIO(), io.StringIO()
                with patch.object(screenshot, "capture", controlled_capture), \
                     patch.object(sys, "stdout", types.SimpleNamespace(buffer=stdout)), \
                     patch.object(sys, "stderr", stderr), patch.object(sys, "argv", ["screenshot.py"]), \
                     patch.dict(os.environ, {"IPHONE_USE_USB_DEVICE_ID": TARGET}), \
                     patch.object(asyncio.get_running_loop(), "add_signal_handler"):
                    if failed_cleanup:
                        with self.assertRaises(SystemExit) as exited:
                            await screenshot.main()
                        self.assertEqual(exited.exception.code, 1)
                    else:
                        await screenshot.main()
                if failed_cleanup:
                    self.assertEqual(stdout.getvalue(), b"")
                    self.assertEqual(stderr.getvalue(), "USB screenshot unavailable: ScreenshotCleanupError\n")
                else:
                    self.assertEqual(stdout.getvalue(), PNG)
                    self.assertEqual(stderr.getvalue(), "")
                self.assertNotIn(TARGET, stderr.getvalue())


class IsolatedEntryTests(unittest.TestCase):
    def test_isolated_entry_uses_trusted_runtime_and_rejects_missing_target_without_capture(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            marker = directory / "untrusted-module-ran"
            poison = f"from pathlib import Path\nPath({str(marker)!r}).touch()\nraise AssertionError('untrusted import')\n"
            for name in ("tree", "ax_archive", "sitecustomize"):
                (directory / f"{name}.py").write_text(poison)
            environment = dict(os.environ, PYTHONPATH=str(directory), PYTHONHOME=str(directory), IPHONE_USE_USB_DEVICE_ID="")
            result = subprocess.run([sys.executable, "-I", "-B", str(Path(screenshot.__file__).resolve())],
                                    env=environment, cwd=directory, input=b"", capture_output=True, timeout=10)
            self.assertEqual(result.returncode, 1)
            self.assertEqual(result.stdout, b"")
            self.assertEqual(result.stderr, b"USB screenshot unavailable: ValueError\n")
            self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
