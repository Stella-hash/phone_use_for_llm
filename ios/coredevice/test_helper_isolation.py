"""Synthetic helper entry/import checks; never opens a phone service."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


IOS = Path(__file__).resolve().parent.parent
TARGET = "11111111-1111111111111111"


class HelperIsolationTests(unittest.TestCase):
    def hostile_environment(self, directory):
        marker = directory / "untrusted-module-ran"
        poison = f"from pathlib import Path\nPath({str(marker)!r}).touch()\nraise AssertionError('untrusted module ran')\n"
        for name in ("touch", "tree", "ax_archive", "compact", "reading", "snapshots", "sitecustomize", "usercustomize"):
            (directory / f"{name}.py").write_text(poison)
        environment = dict(os.environ, PYTHONPATH=str(directory), PYTHONHOME=str(directory),
                           IPHONE_USE_USB_DEVICE_ID=TARGET)
        return environment, marker

    def test_isolated_helpers_import_only_resolved_source_siblings(self):
        probe = r'''
import asyncio, builtins, json, pathlib, runpy, sys, types
assert sys.flags.isolated == 1 and sys.dont_write_bytecode
source = pathlib.Path(sys.argv[1]).resolve()
ios = pathlib.Path(sys.argv[2]).resolve()
before = set(sys.path)
scope = runpy.run_path(str(source), run_name="isolated_helper_probe")
if source.name == "tree.py":
    assert pathlib.Path(sys.modules["ax_archive"].__file__).resolve() == ios / "accessibility/ax_archive.py"
    # Exercise the delayed AX presentation imports without collecting a tree.
    result = json.loads(scope["present_ax"](scope["base_result"](), {"status": "failed", "raw_path": None}))
    assert result["status"] == "unavailable"
    for name in ("compact", "reading", "snapshots"):
        assert pathlib.Path(sys.modules[name].__file__).resolve() == ios / f"accessibility/{name}.py"
else:
    if source.name == "keyboard.py":
        assert pathlib.Path(sys.modules["touch"].__file__).resolve() == ios / "coredevice/touch.py"
    original_import = builtins.__import__
    reached = []
    def refuse_runtime(target):
        assert target == "11111111-1111111111111111"
        reached.append("runtime_constructor")
        raise RuntimeError("synthetic stop before opening any device")
    def trusted_import(name, *args, **kwargs):
        if name == "pymobiledevice3.remote.core_device.hid_service":
            return types.SimpleNamespace(UniversalHIDServiceService=None, TouchscreenContact=None)
        module = original_import(name, *args, **kwargs)
        if name == "tree":
            assert pathlib.Path(module.__file__).resolve() == ios / "accessibility/tree.py"
            assert pathlib.Path(sys.modules["ax_archive"].__file__).resolve() == ios / "accessibility/ax_archive.py"
            reached.append("trusted_runtime_import")
            module.Runtime = refuse_runtime
        return module
    builtins.__import__ = trusted_import
    plan = {"samples": [{"at_ms": 0, "usages": [4]}, {"at_ms": 1, "usages": []}]}
    if source.name == "touch.py":
        plan = {"image": {"width": 462, "height": 1000}, "samples": [
            {"at_ms": 0, "contacts": [{"id": 0, "x": 100, "y": 300}]}, {"at_ms": 1, "contacts": []}]}
    async def gate(*args):
        raise AssertionError("service and gate must not be reached")
    result = asyncio.run(scope["run"](plan, gate))
    assert reached == ["trusted_runtime_import", "runtime_constructor"], reached
    assert result["error_type"] == "RuntimeError" and result["input_status"] == "not_sent"
    assert result["reports_attempted"] == 0 and result["cleanup"]["not_started"]
assert set(sys.path) - before <= {str(ios / "coredevice"), str(ios / "accessibility")}, sys.path
print("trusted imports only")
'''
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            environment, marker = self.hostile_environment(directory)
            for relative in ("coredevice/touch.py", "coredevice/keyboard.py", "accessibility/tree.py"):
                with self.subTest(helper=relative):
                    result = subprocess.run([sys.executable, "-I", "-B", "-c", probe, str(IOS / relative), str(IOS)],
                                            cwd=directory, env=environment, capture_output=True, text=True, timeout=10)
                    self.assertEqual(result.returncode, 0, result.stderr + result.stdout)
                    self.assertEqual(result.stdout.strip(), "trusted imports only")
                    self.assertFalse(marker.exists())

    def test_direct_entry_requires_commit_before_input_or_service_import(self):
        with tempfile.TemporaryDirectory() as temporary:
            directory = Path(temporary)
            environment, marker = self.hostile_environment(directory)
            coredevice = directory / "source/ios/coredevice"
            accessibility = coredevice.parent / "accessibility"
            coredevice.mkdir(parents=True)
            accessibility.mkdir()
            service_marker = directory / "service-imported"
            # Copy only the actual entrypoints. A forbidden Runtime module
            # makes a regression observable without ever touching a phone.
            (accessibility / "tree.py").write_text(
                f"from pathlib import Path\nPath({str(service_marker)!r}).touch()\nraise AssertionError('service import before commit arguments')\n")
            for name in ("touch.py", "keyboard.py"):
                (coredevice / name).write_bytes((IOS / "coredevice" / name).read_bytes())
            for name in ("touch.py", "keyboard.py"):
                for arguments in ([], ["--commit-file"], ["--commit-file", "relative-path"]):
                    with self.subTest(helper=name, arguments=arguments):
                        # Keep stdin open and empty: arguments must fail before
                        # even trying to read the complete input program.
                        with subprocess.Popen([sys.executable, "-I", "-B", str(coredevice / name), *arguments],
                                              cwd=directory, env=environment, stdin=subprocess.PIPE,
                                              stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True) as child:
                            try:
                                child.wait(timeout=10)
                            finally:
                                if child.poll() is None:
                                    child.kill()
                            stdout, stderr = child.communicate()
                        self.assertEqual(child.returncode, 1, stderr + stdout)
                        result = json.loads(stdout)
                        self.assertEqual(result, {"input_status": "not_sent", "error_type": "ValueError",
                                                  "reason": "Invalid host arguments or JSON"})
                        self.assertFalse(service_marker.exists())
                        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
