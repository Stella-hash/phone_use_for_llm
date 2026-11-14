import Foundation
import Testing
@testable import iPhoneUse

/// Runs only the Swift bridge and a stdlib fake child; no device service is opened.
@Suite(.serialized) struct CoreDeviceHomeTests {
    private enum Stop: Error { case targetChanged }
    private static let device = "11111111-1111111111111111"

    private final class Harness {
        let directory: URL, helper: URL, marker: URL
        let mode: String

        init(_ mode: String = "normal") throws {
            self.mode = mode
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("home-bridge-test-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false,
                attributes: [.posixPermissions: 0o700])
            helper = directory.appendingPathComponent("fake.py")
            marker = directory.appendingPathComponent("events.json")
            try Self.script.write(to: helper, atomically: true, encoding: .utf8)
        }

        deinit { try? FileManager.default.removeItem(at: directory) }

        var environment: [String: String] {
            var env = ProcessInfo.processInfo.environment
            env[CoreDeviceKeyboard.helperKey] = helper.path
            env["IPHONE_USE_DEVICE_ID"] = CoreDeviceHomeTests.device
            env[DeviceClipboard.deviceKey] = CoreDeviceHomeTests.device
            env[DeviceClipboard.pythonKey] = ProcessInfo.processInfo.environment["PHONE_USE_TEST_PYTHON"] ?? "/usr/bin/python3"
            env["HOME_TEST_MODE"] = mode
            env["HOME_TEST_MARKER"] = marker.path
            return env
        }

        func perform(beforeCommit: () throws -> Void = {}, clipboard: (() throws -> Void)? = nil) throws -> [String: Any] {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.home(), device: CoreDeviceHomeTests.device,
                environment: environment, beforeCommit: beforeCommit, clipboard: clipboard)
        }

        func events() throws -> [[String: Any]] {
            let value = try #require(try JSONSerialization.jsonObject(with: Data(contentsOf: marker)) as? [String: Any])
            #expect(value["plan"] as? [String: String] == ["button": "home"])
            return try #require(value["events"] as? [[String: Any]])
        }

        private static let script = #"""
import json, os, pathlib, signal, sys, time
assert sys.flags.isolated == 1 and sys.dont_write_bytecode
assert sys.argv[1] == '--commit-file'
assert os.environ['PYMOBILEDEVICE3_UDID'] == '11111111-1111111111111111'
plan = json.load(sys.stdin)
assert plan == {'button': 'home'}
commit = pathlib.Path(sys.argv[2])
marker = pathlib.Path(os.environ['HOME_TEST_MARKER'])
mode = os.environ['HOME_TEST_MODE']; events = []
def record(stage):
    events.append({'stage': stage, 'commit_seen': commit.exists()})
    pending = marker.with_suffix('.pending')
    pending.write_text(json.dumps({'plan': plan, 'events': events}))
    pending.replace(marker)
def stop(*args):
    record('terminated'); raise SystemExit(1)
signal.signal(signal.SIGTERM, stop)
record('opened')
receipt = {'schema_version': 1, 'backend': 'coredevice-button', 'button': 'home',
    'input_status': 'sent_unverified', 'reports_attempted': 2, 'reports_locally_sent': 2,
    'host_commit_received': True, 'button_service_ready': True,
    'virtual_service_registered': False, 'media_started': False,
    'cleanup_release': {'status': 'sent_unverified'}, 'cleanup': {'errors': [],
        'connection_closed': True, 'tunnel_closed': True, 'pairing_scratch_removed': True}}
ready = {'phase': 'ready', 'button': 'home', 'button_service_ready': True}
if mode == 'ready_keyboard': ready = {'phase': 'ready', 'keyboard_surface_registered': True}
if mode == 'ready_wrong_button': ready['button'] = 'power'
if mode == 'ready_false_service': ready['button_service_ready'] = False
if mode == 'ready_numeric_service': ready['button_service_ready'] = 1
if mode == 'ready_wrong_phase': ready['phase'] = 'other'
record('ready')
print(json.dumps(ready), flush=True)
if mode.startswith('ready_'):
    # Deliberately claim success without a commit; invalid readiness must never authorize it.
    print(json.dumps(receipt), flush=True); raise SystemExit(0)
deadline = time.monotonic() + 4
while not commit.exists() and time.monotonic() < deadline: time.sleep(.005)
if not commit.exists(): raise SystemExit(7)
assert json.loads(commit.read_text()) == {'commit': True}
record('committed')
if mode == 'keyboard_backend': receipt['backend'] = 'coredevice-keyboard'
if mode == 'virtual_keyboard': receipt['virtual_service_registered'] = True
if mode == 'wrong_button': receipt['button'] = 'power'
if mode == 'false_service': receipt['button_service_ready'] = False
if mode == 'numeric_service': receipt['button_service_ready'] = 1
print(json.dumps(receipt), flush=True)
"""#
    }

    @Test func nativeHomeUsesButtonPayloadAndReadyCommitReceipt() throws {
        let harness = try Harness()
        var validations = 0
        let receipt = try harness.perform(beforeCommit: {
            validations += 1
            let events = try harness.events()
            #expect(events.last?["stage"] as? String == "ready")
            #expect(events.allSatisfy { $0["commit_seen"] as? Bool == false })
        })
        #expect(validations == 2)
        #expect(receipt["backend"] as? String == "coredevice-button")
        #expect(receipt["button"] as? String == "home")
        #expect(receipt["input_status"] as? String == "sent_unverified")
        #expect(receipt["hid_input_status"] as? String == "sent_unverified")
        #expect(receipt["clipboard_status"] as? String == "not_requested")
        #expect(receipt["reports_attempted"] as? Int == 2 && receipt["reports_locally_sent"] as? Int == 2)
        #expect(receipt["host_commit_received"] as? Bool == true)
        #expect(receipt["surface_deregistration"] as? String == "not_applicable")
        #expect((receipt["cleanup_release"] as? [String: String])?["status"] == "sent_unverified")
        let cleanup = try #require(receipt["cleanup"] as? [String: Any])
        #expect((cleanup["errors"] as? [[String: Any]])?.isEmpty == true)
        #expect(["connection_closed", "tunnel_closed", "pairing_scratch_removed"].allSatisfy { cleanup[$0] as? Bool == true })
        #expect(try harness.events().last?["stage"] as? String == "committed")
        #expect(CoreDeviceKeyboard.response(receipt, device: Self.device).status == 200)
    }

    @Test func wrongTargetAndPrecommitRevalidationCannotCommitHome() throws {
        let harness = try Harness()
        var environment = harness.environment
        environment[DeviceClipboard.deviceKey] = "22222222-2222222222222222"
        #expect(throws: InputRequestError.self) {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.home(), device: Self.device, environment: environment)
        }
        #expect(!FileManager.default.fileExists(atPath: harness.marker.path))
        var validations = 0
        let receipt = try harness.perform(beforeCommit: {
            validations += 1
            if validations == 2 { throw Stop.targetChanged }
        })
        #expect(validations == 2)
        #expect(receipt["input_status"] as? String == "not_sent")
        let events = try harness.events()
        #expect(events.contains { $0["stage"] as? String == "ready" })
        #expect(!events.contains { $0["stage"] as? String == "committed" })
        #expect(events.allSatisfy { $0["commit_seen"] as? Bool == false })
    }

    @Test(arguments: ["ready_keyboard", "ready_wrong_button", "ready_false_service", "ready_numeric_service", "ready_wrong_phase"])
    func keyboardOrMalformedButtonReadyCannotAuthorizeHome(_ mode: String) throws {
        let harness = try Harness(mode)
        var validations = 0
        let receipt = try harness.perform(beforeCommit: { validations += 1 })
        #expect(validations == 0)
        #expect(receipt["input_status"] as? String == "unconfirmed")
        #expect(try harness.events().allSatisfy { $0["commit_seen"] as? Bool == false })
    }

    @Test(arguments: ["keyboard_backend", "virtual_keyboard", "wrong_button", "false_service", "numeric_service"])
    func incompatibleHomeSuccessClaimIsUnconfirmed(_ mode: String) throws {
        let harness = try Harness(mode)
        let receipt = try harness.perform()
        #expect(try harness.events().last?["stage"] as? String == "committed")
        #expect(receipt["input_status"] as? String == "unconfirmed")
        #expect(receipt["clipboard_status"] as? String == "not_requested")
        let response = CoreDeviceKeyboard.response(receipt, device: Self.device)
        #expect(response.status == 409)
        let body = try #require(try JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(body["input_sent"] == nil)
    }

    @Test func homeRejectsClipboardBeforeStartingAnyChildOrCallback() throws {
        let harness = try Harness()
        var validations = 0, clipboardCalls = 0
        #expect(throws: InputRequestError.self) {
            try harness.perform(beforeCommit: { validations += 1 }, clipboard: { clipboardCalls += 1 })
        }
        #expect(validations == 0 && clipboardCalls == 0)
        #expect(!FileManager.default.fileExists(atPath: harness.marker.path))
    }
}
