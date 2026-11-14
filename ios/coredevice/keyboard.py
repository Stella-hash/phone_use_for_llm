#!/usr/bin/env python3
"""Owned, bounded CoreDevice keyboard and native Home button helper.

Validate the complete plan before opening the exact USB target. After opening
the native Home button service or registering a session keyboard, wait for the
host's one-use commit. No media, pairing, mounting, BLE fallback or uncertain-
action replay. Receipts contain no literal input, usage codes, raw reports or
physical device identifiers.
"""
import asyncio
import datetime
import json
import logging
import math
import os
from pathlib import Path
import re
import secrets
import signal
import sys
import time

# -I removes the script directory. Restore only the resolved trusted sibling
# directory needed by this helper, independently of cwd and PYTHONPATH.
HELPER_DIRECTORY = Path(__file__).resolve().parent
sys.path.insert(0, str(HELPER_DIRECTORY))
from touch import bounded_cleanup, finish_cleanup

ACCESSIBILITY_DIRECTORY = (HELPER_DIRECTORY.parent / "accessibility").resolve()
MAX_INPUT = 16384
MAX_SAMPLES = 128
MAX_DURATION_MS = 6000


def parse_plan(value):
    if (type(value) is dict and set(value) == {"button"}
            and type(value["button"]) is str and value["button"] == "home"):
        return "home"
    if type(value) is not dict or set(value) != {"samples"}:
        raise ValueError("Expected samples or the native Home button only")
    rows = value["samples"]
    if type(rows) is not list or not 2 <= len(rows) <= MAX_SAMPLES:
        raise ValueError("Expected 2..128 samples")
    parsed, previous = [], -1
    for row in rows:
        if type(row) is not dict or set(row) != {"at_ms", "usages"}:
            raise ValueError("Expected at_ms and usages only")
        at = row["at_ms"]
        if (type(at) not in (int, float) or not math.isfinite(at)
                or not 0 <= at <= MAX_DURATION_MS or at <= previous):
            raise ValueError("Times must strictly increase within 0..6000 ms")
        previous = at
        usages = row["usages"]
        if type(usages) is not list or len(usages) > 16:
            raise ValueError("Expected at most 16 held usages")
        if (any(type(code) is not int or not 4 <= code < 240 for code in usages)
                or len(set(usages)) != len(usages)):
            raise ValueError("Usages must be unique integers in 4..239")
        parsed.append((at / 1000, tuple(usages)))
    if parsed[0][0] != 0 or not parsed[0][1] or parsed[-1][1]:
        raise ValueError("Start at zero with keys held; explicitly end with all keys released")
    return parsed


async def send_plan(send, samples, receipt):
    started = time.monotonic()
    attempted = False
    receipt.update(reports_attempted=0, reports_locally_sent=0,
                   cleanup_release={"status": "not_needed"})
    try:
        for at, usages in samples:
            await asyncio.sleep(max(0, started + at - time.monotonic()))
            attempted = True
            receipt["reports_attempted"] += 1
            await send(usages)
            receipt["reports_locally_sent"] += 1
    finally:
        if attempted:
            try:
                async def release_and_allow_dispatch():
                    await send(())
                    # Finite dtuhidd dispatch grace before XPC close, not an ACK.
                    await asyncio.sleep(.1)
                interrupted = await bounded_cleanup(release_and_allow_dispatch(), 1)
                receipt["cleanup_release"] = {"status": "sent_unverified"}
                if interrupted:
                    raise asyncio.CancelledError()
            except (Exception, asyncio.CancelledError) as exc:
                if receipt["cleanup_release"]["status"] != "sent_unverified":
                    receipt["cleanup_release"] = {"status": "unconfirmed", "error_type": type(exc).__name__}
                if isinstance(exc, asyncio.CancelledError):
                    raise


async def send_home_button(send, receipt):
    """The pinned Indigo Home usage has down/up states; never retry a press."""
    receipt.update(reports_attempted=0, reports_locally_sent=0,
                   cleanup_release={"status": "not_needed"})
    try:
        receipt["reports_attempted"] += 1
        await send(1)  # HID_BUTTON_STATE_DOWN
        receipt["reports_locally_sent"] += 1
        await asyncio.sleep(.05)
        receipt["reports_attempted"] += 1
        await send(2)  # HID_BUTTON_STATE_UP
        receipt["reports_locally_sent"] += 1
        # The pinned service dispatches asynchronously; allow UP to dispatch
        # before closing XPC. This is a grace period, not an application ACK.
        await asyncio.sleep(.1)
        receipt["cleanup_release"] = {"status": "sent_unverified"}
    except (Exception, asyncio.CancelledError):
        # An interrupted send may already have reached the phone. Cancel the
        # same button on this same session once, without replaying DOWN or UP.
        try:
            async def cancel_and_allow_dispatch():
                await send(3)  # HID_BUTTON_STATE_CANCELED
                await asyncio.sleep(.1)
            interrupted = await bounded_cleanup(cancel_and_allow_dispatch(), 1)
            receipt["cleanup_release"] = {"status": "sent_unverified"}
            if interrupted:
                raise asyncio.CancelledError()
        except (Exception, asyncio.CancelledError) as exc:
            if receipt["cleanup_release"]["status"] != "sent_unverified":
                receipt["cleanup_release"] = {"status": "unconfirmed", "error_type": type(exc).__name__}
            if isinstance(exc, asyncio.CancelledError):
                raise
        raise


async def run(value, gate):
    began = time.monotonic()
    receipt = {
        "schema_version": 1, "backend": "coredevice-keyboard",
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "input_status": "not_sent", "device_delivery": "unverified",
        "application_effect": "unverified", "media_started": False,
        "virtual_service_registered": False, "reports_attempted": 0,
        "reports_locally_sent": 0, "cleanup_release": {"status": "not_needed"},
        "surface_deregistration": "not_independently_observed",
    }
    rt = hid = None
    try:
        samples = parse_plan(value)
        button = samples == "home"
        if button:
            receipt.update(backend="coredevice-button", button="home", button_service_ready=False,
                           surface_deregistration="not_applicable")
        device_id = os.environ.get("IPHONE_USE_USB_DEVICE_ID", "")
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})", device_id):
            raise ValueError("Hosted keyboard requires an exact USB device")
        if gate is None:
            raise ValueError("Hosted keyboard requires a host commit")
        sys.path.insert(0, str(ACCESSIBILITY_DIRECTORY))
        from tree import Runtime
        rt = Runtime(device_id)
        async with asyncio.timeout(6):
            rsd = await rt.open(require_ax=False)
            if button:
                from pymobiledevice3.remote.core_device.hid_service import IndigoHIDService
                hid = IndigoHIDService(rsd)
                await hid.__aenter__()
                receipt["button_service_ready"] = True
            else:
                from pymobiledevice3.remote.core_device.hid_service import UniversalHIDServiceService
                hid = UniversalHIDServiceService(rsd)
                await hid.__aenter__()
                requested = (1 << 32) | secrets.randbits(32)
                service_id = await hid.create_keyboard_service(service_id=requested,
                    product="Phone-use USB keyboard", manufacturer="Phone-use")
                if type(service_id) is not int or service_id != requested:
                    raise ValueError("Unexpected keyboard service identity")
                surfaces = (await hid.list_connected_services()).get("connectedServices", [])
                if not any(s.get("_ServiceID") == service_id and s.get("PrimaryUsagePage") == 1
                           and s.get("PrimaryUsage") == 6 for s in surfaces):
                    raise ValueError("Registered keyboard surface was not advertised")
                receipt["virtual_service_registered"] = True
            receipt["preflight_ms"] = round((time.monotonic() - began) * 1000, 3)
        await gate()
        receipt["host_commit_received"] = True
        async with asyncio.timeout(MAX_DURATION_MS / 1000 + 2):
            if button:
                async def send(state):
                    await hid.send_button(0x0C, 0x40, state)
                await send_home_button(send, receipt)
            else:
                async def send(usages):
                    await hid.send_keyboard(service_id, usages)
                await send_plan(send, samples, receipt)
        receipt["input_status"] = "unconfirmed" if receipt["cleanup_release"]["status"] == "unconfirmed" else "sent_unverified"
    except (Exception, asyncio.CancelledError) as exc:
        receipt["input_status"] = "unconfirmed" if receipt["reports_attempted"] else "not_sent"
        receipt["error_type"] = type(exc).__name__
    finally:
        await finish_cleanup(hid, rt, receipt)
        receipt["elapsed_ms"] = round((time.monotonic() - began) * 1000, 3)
    return receipt


async def host_gate(commit_file, *, button=False):
    ready = {"phase": "ready", "button_service_ready": True, "button": "home"} if button else {
        "phase": "ready", "keyboard_surface_registered": True}
    print(json.dumps(ready), flush=True)
    # The host may spend up to ten seconds writing the phone clipboard here.
    async with asyncio.timeout(13):
        while not commit_file.exists():
            await asyncio.sleep(.01)
        if commit_file.stat().st_size > 64:
            raise ValueError("Invalid host commit")
        message = json.loads(commit_file.read_text())
        if type(message) is not dict or set(message) != {"commit"} or message["commit"] is not True:
            raise ValueError("Host did not commit the validated keyboard program")


async def main():
    logging.disable(logging.CRITICAL)
    task = asyncio.current_task()
    for sig in (signal.SIGINT, signal.SIGTERM):
        asyncio.get_running_loop().add_signal_handler(sig, task.cancel)
    try:
        if len(sys.argv) != 3 or sys.argv[1] != "--commit-file":
            raise ValueError("Expected host commit path")
        commit_file = Path(sys.argv[2])
        if not commit_file.is_absolute() or commit_file.exists():
            raise ValueError("Host commit must be a new absolute path")
        raw = sys.stdin.buffer.read(MAX_INPUT + 1)
        if len(raw) > MAX_INPUT:
            raise ValueError("Oversized JSON")
        value = json.loads(raw)
    except (ValueError, UnicodeError):
        result = {"input_status": "not_sent", "error_type": "ValueError", "reason": "Invalid host arguments or JSON"}
    else:
        result = await run(value, lambda: host_gate(commit_file, button=value == {"button": "home"}))
    print(json.dumps(result, allow_nan=False), flush=True)
    if result.get("error_type") or result.get("cleanup", {}).get("errors") or result.get("cleanup_release", {}).get("status") == "unconfirmed":
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
