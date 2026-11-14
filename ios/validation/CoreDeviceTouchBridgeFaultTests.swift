// Codex-E subagent touch_mapping_review · Stella-hash/phone-use · 2026-11-07.
// Initial native tree: 76a92a3ce1586c860118fc1dc8110edea9e0e9bd.
// Accepted rerun changes only CoreDeviceTouch.swift to Git blob
// d0d040ff2dad03c8a1fcd777d23c4e8cbbff4740; provenance is recorded in the iOS work log.
// Isolated /private/tmp overlay. The only child is a stdlib-only fake Python
// helper; no phone library, USB, Bluetooth, app host or network service is used.

import Foundation
import Testing
@testable import iPhoneUse

@Suite(.serialized) struct CoreDeviceTouchBridgeFaultTests {
    private enum CallbackFailure: Error { case stopBeforeCommit }

    private final class Harness {
        let directory: URL
        let helper: URL
        let marker: URL
        let reference: ScreenshotReferences.Reference
        let mode: String

        init(_ mode: String) throws {
            self.mode = mode
            directory = FileManager.default.temporaryDirectory
                .appendingPathComponent("phone-use-touch-test-" + mode + "-" + UUID().uuidString)
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
            helper = directory.appendingPathComponent("fake-helper.py")
            marker = directory.appendingPathComponent("marker.json")
            try Self.script.write(to: helper, atomically: true, encoding: .utf8)
            reference = ScreenshotReferences(capacity: 1).issue(device: "11111111-1111111111111111", source: "synthetic-source",
                screenSize: CGSize(width: 1180, height: 2556), imageSize: (462, 1000))
        }

        deinit { try? FileManager.default.removeItem(at: directory) }

        var environment: [String: String] {
            var values = ProcessInfo.processInfo.environment
            values[CoreDeviceTouch.helperKey] = helper.path
            values["IPHONE_USE_DEVICE_ID"] = reference.device
            values["IPHONE_USE_USB_DEVICE_ID"] = "11111111-1111111111111111"
            values["IPHONE_USE_USB_CLIPBOARD_PYTHON"] = ProcessInfo.processInfo.environment["PHONE_USE_TEST_PYTHON"] ?? "/usr/bin/python3"
            values["TOUCH_FAKE_MODE"] = mode
            values["TOUCH_FAKE_MARKER"] = marker.path
            return values
        }

        func result(beforeCommit: (DeviceDisplayMapping) throws -> Void = { _ in }) throws -> [String: Any] {
            let request = try TouchSequenceRequest(Self.valid, image: (462, 1000))
            return try CoreDeviceTouch.perform(request, reference: reference, environment: environment,
                beforeCommit: beforeCommit)
        }

        func markers() throws -> [String: Any] {
            try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as! [String: Any]
        }

        static var valid: [String: Any] {
            ["samples": [
                ["at_ms": 0, "contacts": [["id": 0, "x": 100, "y": 300]]],
                ["at_ms": 70, "contacts": []],
            ]]
        }

        static let script = #"""
import json, os, pathlib, signal, sys, time

assert len(sys.argv) == 3 and sys.argv[1] == '--commit-file'
commit = pathlib.Path(sys.argv[2])
marker = pathlib.Path(os.environ['TOUCH_FAKE_MARKER'])
mode = os.environ['TOUCH_FAKE_MODE']
plan = json.load(sys.stdin)
assert plan['image'] == {'width': 462, 'height': 1000}
events = []

def record(stage, **extra):
    events.append({'stage': stage, 'commit_seen': commit.exists(), **extra})
    temp = marker.with_suffix('.pending')
    temp.write_text(json.dumps({'events': events}))
    temp.replace(marker)

def stop(signum, _frame):
    record('terminated', signal=signum)
    raise SystemExit(1)

signal.signal(signal.SIGTERM, stop)
signal.signal(signal.SIGINT, stop)
record('before_ready')
assert not commit.exists()
receipt = {'schema_version': 1, 'input_status': 'sent_unverified',
           'reports_attempted': 2, 'reports_locally_sent': 2,
           'host_commit_received': True,
           'cleanup_release': {'status': 'sent_unverified'},
           'cleanup': {'errors': []}, 'reports': [{'fixture_detail': 'strip me'}]}

if mode == 'uncommitted_success':
    receipt['host_commit_received'] = False
    receipt['reports_attempted'] = 0
    receipt['reports_locally_sent'] = 0
    print(json.dumps(receipt), flush=True)
    raise SystemExit(0)
if mode == 'preflight_failure':
    receipt.update(input_status='not_sent', reports_attempted=0,
                   reports_locally_sent=0, host_commit_received=False,
                   error_type='SyntheticPreflightError')
    print(json.dumps(receipt), flush=True)
    raise SystemExit(1)

display = {'native_orientation': 'rot0', 'current_orientation': 'rot0',
           'rotation_degrees': 0, 'native_width': 1179, 'native_height': 2556,
           'display_width': 1179, 'display_height': 2556}
ready = json.dumps({'phase': 'ready', 'display': display})
if mode == 'partial_ready':
    half = len(ready) // 2
    sys.stdout.write(ready[:half]); sys.stdout.flush()
    time.sleep(.20)
    record('partial_ready_checked')
    if commit.exists():
        raise SystemExit(31)
    sys.stdout.write(ready[half:] + '\n'); sys.stdout.flush()
else:
    time.sleep(.06)
    record('ready_will_be_sent')
    assert not commit.exists()
    print(ready, flush=True)

deadline = time.monotonic() + 4
while not commit.exists() and time.monotonic() < deadline:
    time.sleep(.005)
if not commit.exists():
    record('commit_absent_at_deadline')
    raise SystemExit(32)
message = json.loads(commit.read_text())
record('commit_observed', complete_message=message == {'commit': True})
assert message == {'commit': True}

if mode == 'invalid_receipt':
    print('{not valid JSON}', flush=True)
elif mode == 'oversized_receipt':
    receipt['padding'] = 'x' * 70000
    print(json.dumps(receipt), flush=True)
elif mode == 'unknown_receipt_status':
    receipt['input_status'] = 'completed'
    print(json.dumps(receipt), flush=True)
elif mode == 'cleanup_failure':
    receipt['cleanup']['errors'] = [{'stage': 'runtime_close', 'error_type': 'SyntheticCleanupError'}]
    print(json.dumps(receipt), flush=True)
    raise SystemExit(1)
else:
    print(json.dumps(receipt), flush=True)
"""#
    }

    @Test func noCommitBeforeReadyAndNormalReceiptIsPreserved() throws {
        let harness = try Harness("normal")
        var callbacks = 0
        let result = try harness.result { mapping in
            callbacks += 1
            #expect(mapping.rotationDegrees == 0)
            let events = try harness.markers()["events"] as! [[String: Any]]
            #expect(events.allSatisfy { $0["commit_seen"] as? Bool == false })
        }
        #expect(callbacks == 1)
        #expect(result["input_status"] as? String == "sent_unverified")
        #expect(result["frame_bound"] as? Bool == true)
        #expect(result["orientation_bound"] as? Bool == false)
        #expect(result["reports"] == nil)
        let events = try harness.markers()["events"] as! [[String: Any]]
        #expect(events.last?["stage"] as? String == "commit_observed")
        #expect(events.last?["complete_message"] as? Bool == true)
    }

    @Test func callbackFailureDoesNotCommit() throws {
        let harness = try Harness("callback_failure")
        #expect(throws: CallbackFailure.self) {
            try harness.result { _ in throw CallbackFailure.stopBeforeCommit }
        }
        let events = try harness.markers()["events"] as! [[String: Any]]
        #expect(events.allSatisfy { $0["commit_seen"] as? Bool == false })
        #expect(events.last?["stage"] as? String == "terminated")
    }

    @Test func partialReadyCannotCommitEarly() throws {
        let harness = try Harness("partial_ready")
        let result = try harness.result()
        #expect(result["input_status"] as? String == "sent_unverified")
        let events = try harness.markers()["events"] as! [[String: Any]]
        let partial = try #require(events.first { $0["stage"] as? String == "partial_ready_checked" })
        #expect(partial["commit_seen"] as? Bool == false)
    }

    @Test(arguments: ["invalid_receipt", "oversized_receipt", "unknown_receipt_status"])
    func badPostCommitReceiptIsUnconfirmed(_ mode: String) throws {
        let harness = try Harness(mode)
        let result = try harness.result()
        #expect(result["input_status"] as? String == "unconfirmed")
        let events = try harness.markers()["events"] as! [[String: Any]]
        #expect(events.last?["stage"] as? String == "commit_observed")
    }

    @Test func failedCleanupExitOverridesSuccessfulSendStatus() throws {
        let result = try Harness("cleanup_failure").result()
        #expect(result["input_status"] as? String == "unconfirmed")
    }

    @Test func preflightFailureIsNotSent() throws {
        let harness = try Harness("preflight_failure")
        var callbacks = 0
        let result = try harness.result { _ in callbacks += 1 }
        #expect(callbacks == 0)
        #expect(result["input_status"] as? String == "not_sent")
    }

    @Test func uncommittedSuccessfulReceiptMustNotClaimBoundInput() throws {
        let harness = try Harness("uncommitted_success")
        var callbacks = 0
        let result = try harness.result { _ in callbacks += 1 }
        #expect(callbacks == 0)
        // A contradictory helper claim is not proof that no input occurred.
        // The host never revalidated this frame or committed the program.
        #expect(result["input_status"] as? String == "unconfirmed")
        #expect(result["frame_bound"] as? Bool == false)
    }

    @Test func completeTimelineRejectsBadLaterCoordinates() throws {
        let body: [String: Any] = ["samples": [
            ["at_ms": 0, "contacts": [["id": 0, "x": 100, "y": 300]]],
            ["at_ms": 10, "contacts": [["id": 0, "x": 462, "y": 300]]],
            ["at_ms": 70, "contacts": []],
        ]]
        #expect(throws: InputRequestError.self) { try TouchSequenceRequest(body, image: (462, 1000)) }
    }

    @Test func duplicateIdsAndInvalidDurationsAreRejected() throws {
        let duplicate: [String: Any] = ["samples": [
            ["at_ms": 0, "contacts": [["id": 0, "x": 100, "y": 300], ["id": 0, "x": 200, "y": 300]]],
            ["at_ms": 70, "contacts": []],
        ]]
        #expect(throws: InputRequestError.self) { try TouchSequenceRequest(duplicate, image: (462, 1000)) }
        for time in [0, -1, 6001] {
            let body: [String: Any] = ["samples": [
                ["at_ms": 0, "contacts": [["id": 0, "x": 100, "y": 300]]],
                ["at_ms": time, "contacts": []],
            ]]
            #expect(throws: InputRequestError.self) { try TouchSequenceRequest(body, image: (462, 1000)) }
        }
    }

    @Test func gesturePreservesTapHoldAndSwipeEndpoints() throws {
        let tap = try TouchSequenceRequest.gesture(path: "/tap", body: ["x": 15.5, "y": 22.5, "hold": 0.07])
        #expect((tap.samples.last?["at_ms"] as? Double) == 70)
        let swipe = try TouchSequenceRequest.gesture(path: "/swipe", body: [
            "duration": 0.3, "points": [["x": 15.5, "y": 22.5], ["x": 100.5, "y": 22.5], ["x": 100.5, "y": 188.5]],
        ])
        let first = (swipe.samples.first!["contacts"] as! [[String: Any]])[0]
        let last = (swipe.samples[swipe.samples.count-2]["contacts"] as! [[String: Any]])[0]
        #expect(first["x"] as? Double == 15.5)
        #expect(first["y"] as? Double == 22.5)
        #expect(last["x"] as? Double == 100.5)
        #expect(last["y"] as? Double == 188.5)
        #expect((swipe.samples.last!["contacts"] as! [[String: Any]]).isEmpty)
        #expect(swipe.samples.count <= 256)
    }
}
