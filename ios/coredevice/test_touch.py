import asyncio
import copy
import os
import types
import unittest
from unittest.mock import Mock, patch

from touch import finish_cleanup, mapped_samples, parse_plan, run, send_plan


def plan():
    return {"image": {"width": 462, "height": 1000}, "samples": [
        {"at_ms": 0, "contacts": [{"id": 0, "x": 100, "y": 300}]},
        {"at_ms": 1, "contacts": []},
    ]}


class Validation(unittest.IsolatedAsyncioTestCase):
    async def test_late_invalid_sample_does_not_open_runtime_or_send_earlier_sample(self):
        value = plan()
        value["samples"].insert(1, {"at_ms": .5, "contacts": [{"id": 1, "x": 462, "y": 20}]})
        result = await run(value)
        self.assertEqual(result["input_status"], "not_sent")
        self.assertEqual(result["reports_attempted"], 0)
        self.assertTrue(result["cleanup"]["not_started"])

    async def test_missing_host_gate_or_exact_target_never_opens_runtime(self):
        forbidden = Mock(side_effect=AssertionError("Runtime must not open"))
        with patch.dict("sys.modules", {"tree": types.SimpleNamespace(Runtime=forbidden)}):
            for target, gate in [("11111111-1111111111111111", None),
                                 ("", forbidden), ("capture-alias", forbidden)]:
                with self.subTest(target=target), patch.dict(os.environ, {"IPHONE_USE_USB_DEVICE_ID": target}):
                    result = await run(plan(), gate)
                    self.assertEqual(result["error_type"], "ValueError")
                    self.assertEqual(result["input_status"], "not_sent")
                    self.assertEqual(result["reports_attempted"], 0)
                    self.assertTrue(result["cleanup"]["not_started"])
        forbidden.assert_not_called()

    async def test_rejects_wraparound_nonfinite_boolean_duplicates_and_unreleased_plan(self):
        cases = []
        for x in (-1, 462, float("nan"), float("inf"), True):
            value = plan(); value["samples"][0]["contacts"][0]["x"] = x; cases.append(value)
        value = plan(); value["samples"][0]["contacts"][0]["id"] = True; cases.append(value)
        value = plan(); value["samples"][0]["contacts"] *= 2; cases.append(value)
        value = plan(); value["samples"][-1]["contacts"] = copy.deepcopy(value["samples"][0]["contacts"]); cases.append(value)
        value = plan(); value["samples"][-1]["at_ms"] = 6001; cases.append(value)
        for value in cases:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_plan(value)

    async def test_fractional_last_pixel_and_explicit_rotation_mapping(self):
        value = plan(); value["samples"][0]["contacts"][0]["x"] = 461.9
        image, samples = parse_plan(value)
        class Display:
            def __init__(self, rotation): self.rotation = rotation
            def json(self): return {"display_width": 1000, "display_height": 462, "rotation_degrees": self.rotation}
        image = {"width": 1000, "height": 462}
        raw = [(0, {0: (.31, .37)}), (.1, {})]
        self.assertEqual(mapped_samples(image, raw, Display(270))[0][1][0], (round(.63*65535), round(.31*65535)))
        self.assertEqual(mapped_samples(image, raw, Display(90))[0][1][0], (round(.37*65535), round(.69*65535)))
        with self.assertRaises(ValueError): mapped_samples({"width":462,"height":1000}, raw, Display(270))


class Delivery(unittest.IsolatedAsyncioTestCase):
    async def test_second_contact_can_lift_without_lifting_held_first_contact(self):
        frames, receipt = [], {}
        async def send(frame): frames.append(frame)
        await send_plan(send, [(0, {0: (100, 200)}), (.001, {0: (110, 200), 1: (300, 400)}),
                               (.002, {0: (120, 200)}), (.003, {})], receipt)
        self.assertEqual(frames[2], [(0, 120, 200, True), (1, 300, 400, False)])
        self.assertEqual(frames[3], [(0, 120, 200, False)])
        self.assertEqual(frames[-1], [(0, 120, 200, False), (1, 300, 400, False)])
        self.assertEqual(receipt["reports_locally_sent"], 4)

    async def test_failed_contact_write_still_attempts_release_without_retrying_contact(self):
        frames, receipt = [], {}
        async def send(frame):
            frames.append(frame)
            if len(frames) == 1: raise ConnectionError("possibly delivered")
        with self.assertRaises(ConnectionError):
            await send_plan(send, [(0, {2: (100, 200)}), (.001, {})], receipt)
        self.assertEqual(frames, [[(2, 100, 200, True)], [(2, 100, 200, False)]])
        self.assertEqual(receipt["reports_attempted"], 1)
        self.assertEqual(receipt["reports_locally_sent"], 0)
        self.assertEqual(receipt["cleanup_release"]["status"], "sent_unverified")

    async def test_cancellation_while_held_uses_independent_release_attempt(self):
        frames, receipt = [], {}
        started = asyncio.Event()
        async def send(frame): frames.append(frame); started.set()
        task = asyncio.create_task(send_plan(send, [(0, {0: (1, 2)}), (1, {})], receipt))
        await started.wait(); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(frames[-1], [(0, 1, 2, False)])
        self.assertEqual(receipt["cleanup_release"]["status"], "sent_unverified")

    async def test_failed_release_is_explicitly_unconfirmed(self):
        receipt = {}
        async def send(frame): raise ConnectionError("gone")
        with self.assertRaises(ConnectionError):
            await send_plan(send, [(0, {0: (1, 2)}), (.001, {})], receipt)
        self.assertEqual(receipt["cleanup_release"]["status"], "unconfirmed")

    async def test_repeated_cancellation_does_not_interrupt_final_release(self):
        touched, releasing, resume = asyncio.Event(), asyncio.Event(), asyncio.Event()
        frames, receipt = [], {}
        async def send(frame):
            frames.append(frame)
            if frame[0][-1]: touched.set()
            else: releasing.set(); await resume.wait()
        task = asyncio.create_task(send_plan(send, [(0,{0:(1,2)}),(1,{})], receipt))
        await asyncio.wait_for(touched.wait(), .5); task.cancel()
        await asyncio.wait_for(releasing.wait(), .5); task.cancel(); await asyncio.sleep(0); task.cancel()
        resume.set()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertEqual(len(frames), 2)
        self.assertEqual(receipt["cleanup_release"]["status"], "sent_unverified")

    async def test_repeated_cancellation_during_close_preserves_cleanup_and_receipt(self):
        entered, resume = asyncio.Event(), asyncio.Event()
        class HID:
            async def __aexit__(self, *_): entered.set(); await resume.wait()
        class Runtime:
            cleanup = {"errors": [], "tunnel_closed": False, "pairing_scratch_removed": False}
            async def close(self): self.cleanup["tunnel_closed"] = True
            def remove_cache(self): self.cleanup["pairing_scratch_removed"] = True
        receipt = {"reports_attempted": 1}
        task = asyncio.create_task(finish_cleanup(HID(), Runtime(), receipt))
        await asyncio.wait_for(entered.wait(), .5); task.cancel(); await asyncio.sleep(0); task.cancel()
        resume.set(); await task
        self.assertTrue(receipt["cleanup"]["tunnel_closed"])
        self.assertTrue(receipt["cleanup"]["pairing_scratch_removed"])
        self.assertEqual(receipt["input_status"], "unconfirmed")


if __name__ == "__main__":
    unittest.main()
