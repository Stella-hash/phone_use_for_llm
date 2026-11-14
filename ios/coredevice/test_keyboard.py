import asyncio
import json
import os
import types
import unittest
from unittest.mock import patch

import keyboard

PLAN = {"samples": [{"at_ms": 0, "usages": [225]},
    {"at_ms": 1, "usages": [225, 5]}, {"at_ms": 2, "usages": [225]},
    {"at_ms": 3, "usages": []}]}
TARGET = '11111111-1111111111111111'


class PlanTests(unittest.TestCase):
    def test_full_held_sets_and_required_all_up(self):
        self.assertEqual(keyboard.parse_plan(PLAN), [(0, (225,)), (.001, (225, 5)), (.002, (225,)), (.003, ())])
        for rows in [[], [{"at_ms": 0, "usages": []}, {"at_ms": 1, "usages": []}],
            [{"at_ms": 0, "usages": [4]}, {"at_ms": 1, "usages": [4]}],
            [{"at_ms": 0, "usages": [4]}, {"at_ms": 6001, "usages": []}],
            [{"at_ms": 0, "usages": [4]}, {"at_ms": 0, "usages": []}],
            [{"at_ms": 0, "usages": [4]}, {"at_ms": float('nan'), "usages": []}],
            [{"at_ms": True, "usages": [4]}, {"at_ms": 2, "usages": []}],
            [{"at_ms": 0, "usages": [4, 4]}, {"at_ms": 2, "usages": []}],
            [{"at_ms": i, "usages": [4] if i == 0 else []} for i in range(129)]]:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                keyboard.parse_plan({"samples": rows})

    def test_late_invalid_usage_or_extra_field_is_rejected(self):
        for value in [True, -1, 0, 3, 240, '4', 4.5, None]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                keyboard.parse_plan({"samples": [PLAN['samples'][0], {"at_ms": 1, "usages": [value]}, PLAN['samples'][-1]]})
        with self.assertRaises(ValueError):
            keyboard.parse_plan({**PLAN, 'repeat': True})


class SendTests(unittest.IsolatedAsyncioTestCase):
    async def test_exact_sets_plus_release_and_metadata_only(self):
        writes, receipt = [], {}
        async def send(usages): writes.append(usages)
        rows = keyboard.parse_plan(PLAN)
        await keyboard.send_plan(send, rows, receipt)
        self.assertEqual(writes, [r[1] for r in rows] + [()])
        self.assertEqual(set(receipt), {'reports_attempted', 'reports_locally_sent', 'cleanup_release'})
        self.assertEqual(receipt['cleanup_release']['status'], 'sent_unverified')

    async def test_failed_maybe_delivered_send_only_releases_without_replay(self):
        writes, receipt = [], {}
        async def send(usages):
            writes.append(usages)
            if len(writes) == 2: raise RuntimeError('do not copy private input into receipt')
        with self.assertRaises(RuntimeError):
            await keyboard.send_plan(send, keyboard.parse_plan(PLAN), receipt)
        self.assertEqual(writes, [(225,), (225, 5), ()])
        self.assertEqual(receipt['reports_attempted'], 2)
        self.assertEqual(receipt['reports_locally_sent'], 1)

    async def test_repeated_cancel_cannot_skip_release_or_dispatch_grace(self):
        writes, receipt = [], {}
        released = asyncio.Event()
        async def send(usages):
            writes.append(usages)
            if not usages:
                await asyncio.sleep(.04)
                released.set()
            else: raise asyncio.CancelledError()
        began = asyncio.get_running_loop().time()
        task = asyncio.create_task(keyboard.send_plan(send, keyboard.parse_plan(PLAN), receipt))
        await asyncio.sleep(.01); task.cancel()
        await asyncio.sleep(.02); task.cancel()
        with self.assertRaises(asyncio.CancelledError): await task
        self.assertTrue(released.is_set())
        self.assertGreaterEqual(asyncio.get_running_loop().time() - began, .13)
        self.assertEqual(writes, [(225,), ()])
        self.assertEqual(receipt['cleanup_release']['status'], 'sent_unverified')

    async def test_hanging_release_is_bounded_and_unconfirmed(self):
        receipt = {}
        async def send(usages):
            if not usages: await asyncio.sleep(10)
            else: raise RuntimeError('input failure')
        with self.assertRaises(RuntimeError):
            await keyboard.send_plan(send, keyboard.parse_plan(PLAN), receipt)
        self.assertEqual(receipt['cleanup_release']['status'], 'unconfirmed')
        self.assertEqual(receipt['cleanup_release']['error_type'], 'TimeoutError')


class RuntimeTests(unittest.IsolatedAsyncioTestCase):
    async def exercise(self, *, gate_fails=False, send_fails=False, close_fails=False, advertised=True):
        calls, writes = [], []
        class Runtime:
            def __init__(self, target):
                self.cleanup = {'errors': []}
                self_target = target
                if self_target != TARGET: raise AssertionError('wrong exact target')
                calls.append('exact_target')
            async def open(self, require_ax):
                if require_ax is not False: raise AssertionError('unexpected AX')
                calls.append('open'); return object()
            async def close(self):
                calls.append('close')
                if close_fails: raise RuntimeError('private close detail')
            def remove_cache(self): calls.append('remove_cache')
        class HID:
            def __init__(self, rsd): pass
            async def __aenter__(self): calls.append('hid_open')
            async def __aexit__(self, *args): calls.append('hid_close')
            async def create_keyboard_service(self, service_id, **kwargs):
                self.service_id = service_id
                calls.append('register'); return service_id
            async def list_connected_services(self):
                return {'connectedServices': [{'PrimaryUsagePage': 1, 'PrimaryUsage': 6,
                    '_ServiceID': self.service_id if advertised else 1}]}
            async def send_keyboard(self, service_id, usages):
                if service_id != self.service_id: raise AssertionError('wrong service')
                if 'commit' not in calls: raise AssertionError('input before commit')
                writes.append(usages)
                if send_fails and usages: raise RuntimeError('literal-private-input')
        async def gate():
            calls.append('gate')
            if gate_fails: raise RuntimeError('literal-private-input')
            calls.append('commit')
        with patch.dict(os.environ, {'IPHONE_USE_USB_DEVICE_ID': TARGET}), patch.dict('sys.modules', {
            'tree': types.SimpleNamespace(Runtime=Runtime),
            'pymobiledevice3.remote.core_device.hid_service': types.SimpleNamespace(UniversalHIDServiceService=HID),
        }):
            receipt = await keyboard.run(PLAN, gate)
        self.assertEqual(calls[-3:], ['hid_close', 'close', 'remove_cache'])
        self.assertNotIn(TARGET, json.dumps(receipt))
        self.assertNotIn('literal-private-input', json.dumps(receipt))
        return calls, writes, receipt

    async def test_gate_precedes_input_and_target_is_exact(self):
        calls, writes, receipt = await self.exercise()
        self.assertLess(calls.index('register'), calls.index('gate'))
        self.assertEqual(writes, [r[1] for r in keyboard.parse_plan(PLAN)] + [()])
        self.assertEqual(receipt['input_status'], 'sent_unverified')
        self.assertEqual(receipt['application_effect'], 'unverified')

    async def test_gate_failure_never_sends_and_never_leaks_message(self):
        _, writes, receipt = await self.exercise(gate_fails=True)
        self.assertEqual(writes, [])
        self.assertEqual(receipt['input_status'], 'not_sent')

    async def test_send_failure_is_unconfirmed_and_only_release_follows(self):
        _, writes, receipt = await self.exercise(send_fails=True)
        self.assertEqual(writes, [(225,), ()])
        self.assertEqual(receipt['input_status'], 'unconfirmed')

    async def test_close_failure_remains_explicit(self):
        _, _, receipt = await self.exercise(close_fails=True)
        self.assertEqual(receipt['cleanup']['errors'], [{'stage': 'runtime_close', 'error_type': 'RuntimeError'}])

    async def test_unadvertised_service_rejects_before_gate(self):
        calls, writes, receipt = await self.exercise(advertised=False)
        self.assertNotIn('gate', calls)
        self.assertEqual(writes, [])
        self.assertEqual(receipt['input_status'], 'not_sent')

    async def test_invalid_late_value_and_missing_gate_preempt_runtime(self):
        def forbidden(*args): raise AssertionError('Runtime must not be opened')
        with patch.dict(os.environ, {'IPHONE_USE_USB_DEVICE_ID': TARGET}), patch.dict('sys.modules', {
            'tree': types.SimpleNamespace(Runtime=forbidden),
        }):
            invalid = {'samples': [PLAN['samples'][0], {'at_ms': 1, 'usages': [240]}, PLAN['samples'][-1]]}
            for value, gate in [(invalid, forbidden), (PLAN, None)]:
                receipt = await keyboard.run(value, gate)
                self.assertEqual(receipt['error_type'], 'ValueError')
                self.assertEqual(receipt['input_status'], 'not_sent')


if __name__ == '__main__': unittest.main()
