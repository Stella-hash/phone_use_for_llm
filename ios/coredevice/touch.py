#!/usr/bin/env python3
"""Bounded CoreDevice direct touch with mandatory host preflight/commit.

Reads a complete JSON contact timeline from stdin before opening the exact USB
target. No media stream, pairing, mounting, retries, keyboard, or BLE input.
Coordinates require an observed screenshot and live display mapping. See the work log
for physical evidence; successful transport writes are not application ACKs.
"""
import asyncio
import datetime
import json
import logging
import math
import os
from pathlib import Path
import re
import signal
import sys
import time

ACCESSIBILITY_DIRECTORY = (Path(__file__).resolve().parent.parent / "accessibility").resolve()
MAX_INPUT = 64 * 1024
MAX_SAMPLES = 256
MAX_DURATION_MS = 6000


def number(value, low, high):
    if (type(value) not in (int, float) or not math.isfinite(value)
            or not low <= value <= high):
        raise ValueError("Expected a finite number in the permitted range")
    return value


def parse_plan(value):
    if not isinstance(value, dict) or set(value) != {"image", "samples"}:
        raise ValueError("Expected image and samples only")
    image = value["image"]
    if (not isinstance(image, dict) or set(image) != {"width", "height"}
            or any(type(image[k]) is not int or not 2 <= image[k] <= 8192
                   for k in ("width", "height"))):
        raise ValueError("Invalid screenshot dimensions")
    samples = value["samples"]
    if not isinstance(samples, list) or not 2 <= len(samples) <= MAX_SAMPLES:
        raise ValueError("Expected 2..256 timeline samples")
    parsed, previous = [], -1
    for sample in samples:
        if not isinstance(sample, dict) or set(sample) != {"at_ms", "contacts"}:
            raise ValueError("Expected at_ms and contacts only")
        at = number(sample["at_ms"], 0, MAX_DURATION_MS)
        if at <= previous:
            raise ValueError("Sample times must strictly increase")
        previous = at
        contacts = sample["contacts"]
        if not isinstance(contacts, list) or len(contacts) > 5:
            raise ValueError("At most five contacts are supported")
        current = {}
        for contact in contacts:
            if not isinstance(contact, dict) or set(contact) != {"id", "x", "y"}:
                raise ValueError("Expected id, x and y only")
            identity = contact["id"]
            if type(identity) is not int or not 0 <= identity <= 4 or identity in current:
                raise ValueError("Contact identities must be unique integers 0..4")
            x = number(contact["x"], 0, image["width"])
            y = number(contact["y"], 0, image["height"])
            if x == image["width"] or y == image["height"]:
                raise ValueError("Coordinates must be inside the screenshot")
            current[identity] = (x / image["width"], y / image["height"])
        parsed.append((at / 1000, current))
    if parsed[0][0] != 0 or not parsed[0][1] or parsed[-1][1]:
        raise ValueError("Begin at zero with contact; finish explicitly with all contacts lifted")
    return image, parsed


def mapped_samples(image, samples, display):
    geometry = display.json()
    if abs(image["width"] / image["height"] - geometry["display_width"] / geometry["display_height"]) > 2 / image["height"]:
        raise ValueError("Screenshot aspect does not match the live primary display")
    rotation = geometry["rotation_degrees"]
    def point(x, y):
        # Inverse native-to-display rotation. Physical acceptance is recorded
        # separately for each observed orientation; aspect never chooses it.
        x, y = {0: (x, y), 90: (y, 1-x), 180: (1-x, 1-y), 270: (1-y, x)}[rotation]
        return round(x * 65535), round(y * 65535)
    return [(at, {i: point(*xy) for i, xy in contacts.items()}) for at, contacts in samples]


async def bounded_cleanup(operation, timeout):
    task = asyncio.create_task(asyncio.wait_for(operation, timeout))
    interrupted = False
    while True:
        try:
            await asyncio.shield(task)
            return interrupted
        except asyncio.CancelledError:
            interrupted = True
            if task.cancelled():
                raise


async def send_plan(send, samples, receipt):
    """send accepts [(id, uint16 x, uint16 y, touching), ...]."""
    previous, possibly_used = {}, {}
    started = time.monotonic()
    receipt.update(reports_attempted=0, reports_locally_sent=0, reports=[],
                   cleanup_release={"status": "not_needed"})
    try:
        for at, current in samples:
            await asyncio.sleep(max(0, started + at - time.monotonic()))
            frame = [(i, *current[i], True) for i in sorted(current)]
            frame += [(i, *previous[i], False) for i in sorted(previous.keys() - current.keys())]
            if not frame:
                previous = current
                continue
            # Cancellation or a failed await can happen after the write reached iOS.
            possibly_used.update(previous)
            possibly_used.update(current)
            receipt["reports_attempted"] += 1
            offered = time.monotonic()
            await send(frame)
            receipt["reports_locally_sent"] += 1
            receipt["reports"].append({
                "planned_ms": round(at * 1000, 3),
                "offered_ms": round((offered - started) * 1000, 3),
                "local_send_ms": round((time.monotonic() - offered) * 1000, 3),
                "active_ids": sorted(current),
                "released_ids": sorted(previous.keys() - current.keys()),
            })
            previous = current
    finally:
        if possibly_used:
            release = [(i, *possibly_used[i], False) for i in sorted(possibly_used)]
            try:
                interrupted = await bounded_cleanup(send(release), 1)
                receipt["cleanup_release"] = {"status": "sent_unverified", "ids": sorted(possibly_used)}
                if interrupted:
                    raise asyncio.CancelledError()
            except (Exception, asyncio.CancelledError) as exc:
                if receipt["cleanup_release"]["status"] != "sent_unverified":
                    receipt["cleanup_release"] = {"status": "unconfirmed", "error_type": type(exc).__name__}
                if isinstance(exc, asyncio.CancelledError):
                    raise


async def close_resources(hid, rt):
    errors = []
    try:
        async with asyncio.timeout(5):
            if hid is not None:
                try:
                    await asyncio.wait_for(hid.__aexit__(None, None, None), 1)
                except Exception as exc:
                    errors.append({"stage": "hid_close", "error_type": type(exc).__name__})
            if rt is not None:
                try:
                    await asyncio.wait_for(rt.close(), 4)
                except Exception as exc:
                    errors.append({"stage": "runtime_close", "error_type": type(exc).__name__})
    except (TimeoutError, asyncio.CancelledError) as exc:
        errors.append({"stage": "cleanup_budget", "error_type": type(exc).__name__})
    finally:
        if rt is not None:
            rt.remove_cache()
            result = rt.cleanup
            result["errors"].extend(errors)
        else:
            result = {"not_started": True, "errors": errors}
    return result


async def finish_cleanup(hid, rt, receipt):
    # A second stop request must not skip tunnel closure and scratch removal.
    # The separate task has its own finite deadline and never sends contact.
    cleanup = asyncio.create_task(close_resources(hid, rt))
    while True:
        try:
            receipt["cleanup"] = await asyncio.shield(cleanup)
            return
        except asyncio.CancelledError:
            receipt["error_type"] = "CancelledError"
            receipt["input_status"] = "unconfirmed" if receipt["reports_attempted"] else "not_sent"
            if cleanup.cancelled():
                if rt is not None:
                    rt.remove_cache()
                receipt["cleanup"] = {"errors": [{"stage": "cleanup_task", "error_type": "CancelledError"}]}
                return


async def run(value, gate=None):
    receipt = {
        "schema_version": 1, "backend": "coredevice-direct-touch-experiment",
        "started_at_utc": datetime.datetime.now(datetime.timezone.utc).isoformat(),
        "input_status": "not_sent", "device_delivery": "unverified",
        "application_effect": "unverified", "frame_bound": False,
        "media_started": False, "reports_attempted": 0,
    }
    rt = hid = None
    began = time.monotonic()
    try:
        # Validate the whole program before any connection or input side effect.
        image, samples = parse_plan(value)
        if gate is None:
            raise ValueError("Hosted touch requires a host commit")
        device_id = os.environ.get("IPHONE_USE_USB_DEVICE_ID", "")
        if not re.fullmatch(r"(?:[0-9A-Fa-f]{8}-[0-9A-Fa-f]{16}|[0-9A-Fa-f]{40})", device_id):
            raise ValueError("Hosted touch requires an exact USB device")
        # Isolated Python omits the script directory. Add only this resolved
        # source sibling, never a directory supplied by cwd or PYTHONPATH.
        sys.path.insert(0, str(ACCESSIBILITY_DIRECTORY))
        from tree import Runtime
        from pymobiledevice3.remote.core_device.hid_service import UniversalHIDServiceService, TouchscreenContact
        rt = Runtime(device_id)
        async with asyncio.timeout(6):
            rsd = await rt.open(require_ax=False)
            display = await rt.primary_display(rsd)
            samples = mapped_samples(image, samples, display)
            hid = UniversalHIDServiceService(rsd)
            await hid.__aenter__()
            surfaces = (await hid.list_connected_services()).get("connectedServices", [])
            if not any(s.get("_ServiceID") == 257 and s.get("PrimaryUsagePage") == 13
                       and s.get("PrimaryUsage") == 4 for s in surfaces):
                raise ValueError("Native touchscreen surface was not advertised")
            receipt["preflight_ms"] = round((time.monotonic() - began) * 1000, 3)
            receipt["ios_version"] = rsd.peer_info.get("Properties", {}).get("OSVersion")
            receipt["display"] = display.json()

        await gate(receipt["display"])
        receipt["host_commit_received"] = True

        async def send(frame):
            await hid.send_multitouch([TouchscreenContact(i, x, y, touching) for i, x, y, touching in frame])

        async with asyncio.timeout(MAX_DURATION_MS / 1000 + 2):
            await send_plan(send, samples, receipt)
        receipt["input_status"] = "unconfirmed" if receipt["cleanup_release"]["status"] == "unconfirmed" else "sent_unverified"
    except (Exception, asyncio.CancelledError) as exc:
        receipt["input_status"] = "unconfirmed" if receipt["reports_attempted"] else "not_sent"
        receipt["error_type"] = type(exc).__name__
        # Known validation messages contain no device identifier or user content.
        if isinstance(exc, ValueError):
            receipt["reason"] = str(exc)
    finally:
        await finish_cleanup(hid, rt, receipt)
        receipt["elapsed_ms"] = round((time.monotonic() - began) * 1000, 3)
    return receipt


async def host_gate(display, commit_file):
    print(json.dumps({"phase": "ready", "display": display}), flush=True)
    async with asyncio.timeout(3):
        while not commit_file.exists():
            await asyncio.sleep(.01)
        if commit_file.stat().st_size > 64:
            raise ValueError("Invalid host commit")
        message = json.loads(commit_file.read_text())
        if type(message) is not dict or set(message) != {"commit"} or message["commit"] is not True:
            raise ValueError("Host did not commit the validated frame")


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
            raise ValueError("Input exceeds 64 KiB")
        value = json.loads(raw)
    except (ValueError, UnicodeError) as exc:
        result = {"input_status": "not_sent", "error_type": type(exc).__name__, "reason": "Invalid host arguments or JSON"}
    else:
        result = await run(value, lambda display: host_gate(display, commit_file))
    print(json.dumps(result, ensure_ascii=False, allow_nan=False), flush=True)
    if result.get("error_type") or result.get("cleanup", {}).get("errors") or result.get("cleanup_release", {}).get("status") == "unconfirmed":
        raise SystemExit(1)


if __name__ == "__main__":
    asyncio.run(main())
