import Foundation
import Testing
@testable import iPhoneUse

@Suite(.serialized) struct CoreDeviceKeyboardTests {
    private enum Stop: Error { case beforeInput }

    @Test func compilerPreservesShiftAndExplicitPressKeySemantics() throws {
        let request = try TypeTextRequest(["text": "aBc", "use_clipboard": false], directKeyboardConfigured: true)
        let samples = try CoreDeviceKeyboardProgram.text(request, switchIME: false).samples
        #expect(samples.map { $0["at_ms"] as! Int } == [0, 120, 200, 300, 420, 520, 600, 720])
        #expect(samples.map { $0["usages"] as! [Int] } == [[4], [], [225], [225, 5], [225], [], [6], []])
        let key = try CoreDeviceKeyboardProgram.key(KeyRequest(["key": "B"]))
        #expect(key.samples.first?["usages"] as? [Int] == [5])
    }

    @Test func longHIDAndConditionalIMEAreRejectedBeforeAnyBatchStep() throws {
        let long = String(repeating: "a", count: 31)
        #expect(throws: (any Error).self) {
            try TypeTextRequest(["text": long, "use_clipboard": false, "clear_before": true], directKeyboardConfigured: true)
        }
        _ = try TypeTextRequest(["text": long, "use_clipboard": false], directKeyboardConfigured: false)
        _ = try TypeTextRequest(["text": String(repeating: "火🚀", count: 1000)], deviceClipboardConfigured: true,
            directKeyboardConfigured: true)
        #expect(throws: (any Error).self) {
            try TypeTextRequest(["text": String(repeating: "a", count: 29), "use_clipboard": false,
                "ensure_chinese_ime": true], directKeyboardConfigured: true)
        }
        #expect(throws: (any Error).self) {
            try ActRequest(["steps": [["type": "key", "key": "a"], ["type": "type", "text": long, "use_clipboard": false]]],
                directKeyboardConfigured: true)
        }
    }

    private final class Harness {
        let directory: URL, helper: URL, marker: URL
        let mode: String
        init(_ mode: String) throws {
            self.mode = mode
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("keyboard-test-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            helper = directory.appendingPathComponent("fake.py")
            marker = directory.appendingPathComponent("marker.json")
            try Self.script.write(to: helper, atomically: true, encoding: .utf8)
        }
        deinit { try? FileManager.default.removeItem(at: directory) }
        var environment: [String: String] {
            var env = ProcessInfo.processInfo.environment
            env[CoreDeviceKeyboard.helperKey] = helper.path
            env["IPHONE_USE_DEVICE_ID"] = "11111111-1111111111111111"
            env["IPHONE_USE_USB_DEVICE_ID"] = "11111111-1111111111111111"
            env["IPHONE_USE_USB_CLIPBOARD_PYTHON"] = ProcessInfo.processInfo.environment["PHONE_USE_TEST_PYTHON"] ?? "/usr/bin/python3"
            env["PYMOBILEDEVICE3_UDID"] = "must-not-be-inherited"
            env["KEYBOARD_FAKE_MODE"] = mode
            env["KEYBOARD_FAKE_MARKER"] = marker.path
            return env
        }
        func result(beforeCommit: () throws -> Void = {}, clipboard: (() throws -> Void)? = nil) throws -> [String: Any] {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.key(KeyRequest(["key": "a", "modifiers": ["command"]])),
                device: "11111111-1111111111111111", environment: environment, beforeCommit: beforeCommit, clipboard: clipboard)
        }
        func stages() throws -> [String] {
            (try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as! [String: Any])["stages"] as! [String]
        }
        static let script = #"""
import json, os, pathlib, signal, sys, time
assert sys.argv[1] == '--commit-file'
assert os.environ['PYMOBILEDEVICE3_UDID'] == '11111111-1111111111111111'
commit = pathlib.Path(sys.argv[2]); marker = pathlib.Path(os.environ['KEYBOARD_FAKE_MARKER'])
mode = os.environ['KEYBOARD_FAKE_MODE']; plan = json.load(sys.stdin)
stages = []
def record(value):
    stages.append(value); marker.write_text(json.dumps({'stages': stages}))
def stop(*args):
    record('terminated'); raise SystemExit(1)
signal.signal(signal.SIGTERM, stop)
record('opened')
receipt = {'schema_version': 1, 'backend': 'coredevice-keyboard', 'input_status': 'sent_unverified',
    'reports_attempted': len(plan['samples']), 'reports_locally_sent': len(plan['samples']),
    'host_commit_received': True, 'virtual_service_registered': True, 'media_started': False,
    'cleanup_release': {'status': 'sent_unverified'}, 'cleanup': {'errors': [],
        'connection_closed':True, 'tunnel_closed':True, 'pairing_scratch_removed':True},
    'literal': 'PRIVATE_INPUT_SENTINEL', 'reports': [{'usages': [227,4]}]}
if mode == 'preflight_failure':
    receipt.update(input_status='not_sent', reports_attempted=0, reports_locally_sent=0, host_commit_received=False)
    print(json.dumps(receipt), flush=True); raise SystemExit(1)
if mode == 'uncommitted_success':
    print(json.dumps(receipt), flush=True); raise SystemExit(0)
print(json.dumps({'phase':'ready', 'keyboard_surface_registered':True}), flush=True)
record('ready')
deadline=time.monotonic()+4
while not commit.exists() and time.monotonic()<deadline: time.sleep(.005)
if not commit.exists(): raise SystemExit(7)
assert json.loads(commit.read_text()) == {'commit': True}
record('committed')
if mode == 'invalid_json':
    print('{invalid}', flush=True); raise SystemExit(0)
if mode == 'contradictory_not_sent': receipt['input_status']='not_sent'
if mode == 'numeric_count': receipt['reports_attempted']=True
if mode == 'wrong_count': receipt['reports_locally_sent']=0
if mode == 'error_success': receipt['error_type']='PRIVATE_INPUT_SENTINEL'
if mode == 'cleanup_failure': receipt['cleanup']['errors']=[{'stage':'PRIVATE_INPUT_SENTINEL','error_type':'PRIVATE_INPUT_SENTINEL'}]
if mode == 'cleanup_false': receipt['cleanup']['tunnel_closed']=False
print(json.dumps(receipt), flush=True)
if mode == 'nonzero_success': raise SystemExit(1)
"""#
    }

    @Test func clipboardRunsOnlyAfterReadyAndBeforeCommit() throws {
        let harness = try Harness("normal")
        var captures = 0, clipboards = 0
        let result = try harness.result(beforeCommit: {
            captures += 1
            let stages = try harness.stages()
            #expect(stages.contains("ready"))
            #expect(!stages.contains("committed"))
        }, clipboard: {
            clipboards += 1
            let stages = try harness.stages()
            #expect(!stages.contains("committed"))
        })
        #expect(captures == 2 && clipboards == 1)
        #expect(result["clipboard_status"] as? String == "written_unverified")
        #expect(result["input_status"] as? String == "sent_unverified")
        let encoded = String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self)
        #expect(!encoded.contains("PRIVATE_INPUT_SENTINEL"))
        #expect(result["reports"] == nil)
    }

    @Test func targetAndCaptureRevalidationCannotCommitWrongPhone() throws {
        let harness = try Harness("normal")
        #expect(throws: (any Error).self) {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.key(KeyRequest(["key": "a"])), device: "wrong-capture",
                environment: harness.environment)
        }
        #expect(!FileManager.default.fileExists(atPath: harness.marker.path))
        let result = try harness.result(beforeCommit: { throw Stop.beforeInput })
        #expect(result["input_status"] as? String == "not_sent")
        let stages = try harness.stages()
        #expect(!stages.contains("committed"))
    }

    @Test func clipboardFailureKeepsKeysUncommittedAndHidesChildDetail() throws {
        let harness = try Harness("normal")
        let result = try harness.result(clipboard: { throw DeviceError("PRIVATE_INPUT_SENTINEL") })
        #expect(result["input_status"] as? String == "unconfirmed")
        #expect(result["hid_input_status"] as? String == "not_sent")
        #expect(result["clipboard_status"] as? String == "unconfirmed")
        let stages = try harness.stages()
        #expect(!stages.contains("committed"))
        #expect(!String(decoding: try JSONSerialization.data(withJSONObject: result), as: UTF8.self).contains("PRIVATE_INPUT_SENTINEL"))
    }

    @Test func preflightFailureNeverWritesClipboard() throws {
        let harness = try Harness("preflight_failure")
        var clipboard = false
        let result = try harness.result(clipboard: { clipboard = true })
        #expect(!clipboard)
        #expect(result["input_status"] as? String == "not_sent")
        #expect(CoreDeviceKeyboard.response(result, device: "11111111-1111111111111111").status == 409)
    }

    @Test(arguments: ["uncommitted_success", "invalid_json", "contradictory_not_sent", "numeric_count", "wrong_count", "error_success", "cleanup_failure", "cleanup_false", "nonzero_success"])
    func contradictoryOrFailedHelperCannotClaimSuccess(_ mode: String) throws {
        let harness = try Harness(mode)
        let result = try harness.result()
        #expect(result["input_status"] as? String == "unconfirmed")
        let response = CoreDeviceKeyboard.response(result, device: "11111111-1111111111111111")
        #expect(response.status == 409)
        let body = try JSONSerialization.jsonObject(with: response.body) as! [String: Any]
        #expect(body["input_sent"] == nil)
        #expect(!String(decoding: response.body, as: UTF8.self).contains("PRIVATE_INPUT_SENTINEL"))
    }

    @Test func emptyHIDRequestIsANoOpWithoutChildOrClipboard() throws {
        let harness = try Harness("normal")
        let request = try TypeTextRequest(["text": "", "use_clipboard": false], directKeyboardConfigured: true)
        let result = try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.text(request, switchIME: false),
            device: "11111111-1111111111111111", environment: harness.environment)
        #expect(result["no_op"] as? Bool == true)
        #expect(CoreDeviceKeyboard.response(result, device: "11111111-1111111111111111").status == 200)
        #expect(!FileManager.default.fileExists(atPath: harness.marker.path))
    }

    @Test func actStopsAtKeyboardFailureAndPreservesLeafReceipt() throws {
        let act = try ActRequest(["steps": [["type": "key", "key": "a"], ["type": "key", "key": "b"]]])
        var calls = 0
        let response = try act.perform(device: "11111111-1111111111111111", capture: { _, _ in throw Stop.beforeInput }, execute: { _, _, _ in
            calls += 1
            return CoreDeviceKeyboard.response(["input_status": "unconfirmed"], device: "11111111-1111111111111111")
        })
        #expect(calls == 1 && response.status == 409)
        let error = MCPHTTPClient.check(response.body, status: response.status, language: .en)
        #expect(error.failedStep == 1 && error.completedSteps == 0)
        #expect(error.transportReceipt?["input_status"] as? String == "unconfirmed")
    }

    @Test func priorLeafSuccessCannotMaskLaterTimeoutOrPartialSequence() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("keyboard-recording-test-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        for carriesReceipt in [false, true] {
            let recording = MCPContextRecording(device: "keyboard-test-\(UUID().uuidString)", tool: "keyboard_sequence", arguments: [:],
                kind: "input", directory: directory)
            recording.requestStarted(); recording.requestAcknowledged()
            recording.recordTransport(try JSONSerialization.data(withJSONObject: ["keyboard_receipt": ["input_status": "sent_unverified"]]))
            recording.requestStarted()
            recording.fail(MCPServer.MCPError("later failure", completedSteps: 1, failedStep: 2,
                transportReceipt: carriesReceipt ? ["input_status": "not_sent"] : nil))
            let result = recording.attach(to: [:])
            let metadata = result["structuredContent"] as! [String: Any]
            let receipt = metadata["input_receipt"] as! [String: Any]
            #expect(receipt["status"] as? String == "unconfirmed")
            #expect(result["isError"] as? Bool == true)
        }
    }
}
