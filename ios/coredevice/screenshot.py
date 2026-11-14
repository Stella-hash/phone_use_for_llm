#!/usr/bin/env python3
"""Read one PNG from the exact USB session used by the input helpers.

No AVFoundation identifier, image matching, AX subscription or input. The native
host supplies one physical UDID and checks its USB attachment before/after this
read. Output is bounded PNG bytes only, after owned tunnel cleanup.
"""
import asyncio
import logging
import os
from pathlib import Path
import re
import signal
import sys

sys.path.insert(0, str((Path(__file__).resolve().parents[1] / "accessibility").resolve()))
from tree import Runtime

MAX_PNG = 16 * 1024 * 1024
WORK_SECONDS = 5


class ScreenshotCleanupError(Exception):
    """Owned screenshot resources were not confirmed cleaned up."""


async def capture(target, runtime_factory=Runtime):
    if not re.fullmatch(r"(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})", target):
        raise ValueError("An exact physical USB UDID is required")
    rt = runtime_factory(target)
    try:
        async with asyncio.timeout(WORK_SECONDS):
            rsd = await rt.open(require_ax=False)
            # Keep identity validation at this read boundary as well as Runtime.
            if rsd.udid != target:
                raise ValueError("Screenshot USB target mismatch")
            from pymobiledevice3.remote.core_device.screen_capture_service import ScreenCaptureService
            async with ScreenCaptureService(rsd) as service:
                result = await service.capture_screenshot(requested_format="png")
            png = result.get("image") if isinstance(result, dict) else None
            if (not isinstance(png, bytes) or not 8 < len(png) <= MAX_PNG
                    or not png.startswith(b"\x89PNG\r\n\x1a\n")):
                raise ValueError("Screenshot service did not return bounded PNG bytes")
    finally:
        try:
            await rt.close()
        finally:
            rt.remove_cache()
    if rt.cleanup["errors"]:
        raise ScreenshotCleanupError("Owned screenshot cleanup was incomplete")
    return png


async def main():
    logging.disable(logging.CRITICAL)
    task = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, task.cancel)
    try:
        if len(sys.argv) != 1:
            raise ValueError("No screenshot command arguments are supported")
        png = await capture(os.environ.get("IPHONE_USE_USB_DEVICE_ID", ""))
    except (Exception, asyncio.CancelledError) as error:
        # No private IDs, screen contents or arbitrary service diagnostics.
        print("USB screenshot unavailable: " + type(error).__name__, file=sys.stderr)
        raise SystemExit(1)
    sys.stdout.buffer.write(png)
    sys.stdout.buffer.flush()


if __name__ == "__main__":
    asyncio.run(main())
