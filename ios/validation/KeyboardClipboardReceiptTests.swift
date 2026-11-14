import Foundation
import Testing
@testable import iPhoneUse

@Suite(.serialized) struct KeyboardClipboardReceiptTests {
    private enum Stop: Error { case identityChanged }

    private final class Harness {
        let directory: URL
        let helper: URL
        let phases: URL
        let commitPath: URL

        init() throws {
            directory = FileManager.default.temporaryDirectory.appendingPathComponent("keyboard-clipboard-receipt-\(UUID().uuidString)")
            try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: false)
            helper = directory.appendingPathComponent("keyboard.py")
            phases = directory.appendingPathComponent("phases")
            commitPath = directory.appendingPathComponent("commit-path")
            try Self.script.write(to: helper, atomically: true, encoding: .utf8)
        }

        deinit { try? FileManager.default.removeItem(at: directory) }

        var environment: [String: String] {
            var env = ProcessInfo.processInfo.environment
            env[CoreDeviceKeyboard.helperKey] = helper.path
            env["IPHONE_USE_DEVICE_ID"] = "11111111-1111111111111111"
            env[DeviceClipboard.deviceKey] = "11111111-1111111111111111"
            env[DeviceClipboard.pythonKey] = ProcessInfo.processInfo.environment["PHONE_USE_TEST_PYTHON"] ?? "/usr/bin/python3"
            env["RECEIPT_TEST_PHASES"] = phases.path
            env["RECEIPT_TEST_COMMIT_PATH"] = commitPath.path
            // These must not change the interpreter or its import path.
            env["PYTHONPATH"] = "/untrusted/python-path"
            env["PYTHONHOME"] = "/untrusted/python-home"
            return env
        }

        func perform(beforeCommit: () throws -> Void = {}, clipboard: (() throws -> Void)? = nil) throws -> [String: Any] {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.key(KeyRequest(["key": "v", "modifiers": ["command"]])),
                device: "11111111-1111111111111111", environment: environment, beforeCommit: beforeCommit, clipboard: clipboard)
        }

        func observedPhases() throws -> [String] {
            try String(contentsOf: phases, encoding: .utf8).split(separator: "\n").map(String.init)
        }

        func preventCommitFile() throws {
            let path = try String(contentsOf: commitPath, encoding: .utf8)
            let pending = URL(fileURLWithPath: path).deletingLastPathComponent().appendingPathComponent("commit.pending")
            try FileManager.default.createDirectory(at: pending, withIntermediateDirectories: false)
        }

        func clipboardEnvironment(_ script: String) throws -> [String: String] {
            let executable = directory.appendingPathComponent("clipboard-helper")
            try ("#!/bin/sh\n" + script).write(to: executable, atomically: true, encoding: .utf8)
            try FileManager.default.setAttributes([.posixPermissions: 0o700], ofItemAtPath: executable.path)
            return [DeviceClipboard.pythonKey: executable.path,
                DeviceClipboard.deviceKey: "11111111-1111111111111111",
                "CLIPBOARD_TEST_MARKER": directory.appendingPathComponent("clipboard-started").path]
        }

        private static let script = #"""
import json, os, pathlib, sys, time
assert sys.flags.isolated == 1 and sys.dont_write_bytecode
assert 'PYTHONPATH' not in os.environ and 'PYTHONHOME' not in os.environ
assert sys.argv[1] == '--commit-file'
json.load(sys.stdin)
commit = pathlib.Path(sys.argv[2])
pathlib.Path(os.environ['RECEIPT_TEST_COMMIT_PATH']).write_text(str(commit))
phases = pathlib.Path(os.environ['RECEIPT_TEST_PHASES'])
phases.write_text('ready\n')
print(json.dumps({'phase':'ready', 'keyboard_surface_registered':True}), flush=True)
while not commit.exists(): time.sleep(.005)
with phases.open('a') as file: file.write('committed\n')
print(json.dumps({'schema_version':1, 'backend':'coredevice-keyboard',
    'input_status':'not_sent', 'reports_attempted':0, 'reports_locally_sent':0,
    'host_commit_received':True, 'cleanup_release':{'status':'not_needed'},
    'cleanup':{'errors':[], 'connection_closed':True, 'tunnel_closed':True,
               'pairing_scratch_removed':True}}), flush=True)
"""#
    }

    private func expectPartialClipboardEffect(_ receipt: [String: Any], clipboard: String, directory: URL) throws {
        #expect(receipt["hid_input_status"] as? String == "not_sent")
        #expect(receipt["clipboard_status"] as? String == clipboard)
        #expect(receipt["input_status"] as? String == "unconfirmed")
        let leaf = CoreDeviceKeyboard.response(receipt, device: "11111111-1111111111111111")
        let leafBody = try #require(try JSONSerialization.jsonObject(with: leaf.body) as? [String: Any])
        #expect(leaf.status == 409 && leafBody["input_sent"] == nil)

        let act = try ActRequest(["steps": [["type": "type", "text": "synthetic"], ["type": "key", "key": "enter"]]])
        var attemptedLeaves = 0
        let batch = try act.perform(device: "11111111-1111111111111111", capture: { _, _ in throw Stop.identityChanged }, execute: { _, _, _ in
            attemptedLeaves += 1
            return leaf
        })
        #expect(attemptedLeaves == 1 && batch.status == 409)
        let error = MCPHTTPClient.check(batch.body, status: batch.status, language: .en)
        #expect(error.completedSteps == 0 && error.failedStep == 1 && !error.inputNotSent)
        let recording = MCPContextRecording(device: "11111111-1111111111111111", tool: "act", arguments: [:], kind: "input",
            directory: directory.appendingPathComponent("context"))
        recording.requestStarted()
        recording.fail(error)
        let result = recording.attach(to: ["isError": true])
        let metadata = try #require(result["structuredContent"] as? [String: Any])
        let input = try #require(metadata["input_receipt"] as? [String: Any])
        #expect(input["status"] as? String == "unconfirmed")
        #expect(metadata["input_sent"] == nil)
        let text = (result["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined(separator: "\n")
        #expect(!text.contains("Input: not sent."))
        #expect(text.contains("HID: not sent.") && text.contains("Clipboard:"))
        #expect(text.contains("Phone side effects: possible") && text.contains("do not replay automatically"))
    }

    @Test func mismatchedUSBTargetIsRejectedBeforeChildOrClipboard() throws {
        let harness = try Harness()
        var environment = harness.environment
        environment[DeviceClipboard.deviceKey] = "22222222-2222222222222222"
        var validations = 0, clipboards = 0
        #expect(throws: (any Error).self) {
            try CoreDeviceKeyboard.perform(CoreDeviceKeyboardProgram.key(KeyRequest(["key": "a"])),
                device: "11111111-1111111111111111", environment: environment,
                beforeCommit: { validations += 1 }, clipboard: { clipboards += 1 })
        }
        #expect(validations == 0 && clipboards == 0)
        #expect(!FileManager.default.fileExists(atPath: harness.phases.path))
        #expect(!FileManager.default.fileExists(atPath: harness.commitPath.path))
    }

    @Test func acknowledgedClipboardThenCaptureRejectionIsPartialInput() throws {
        let harness = try Harness()
        var validations = 0, writes = 0
        let receipt = try harness.perform(beforeCommit: {
            validations += 1
            if validations == 2 { throw Stop.identityChanged }
        }, clipboard: { writes += 1 })
        #expect(validations == 2 && writes == 1)
        #expect(try harness.observedPhases() == ["ready"])
        try expectPartialClipboardEffect(receipt, clipboard: "written_unverified", directory: harness.directory)
    }

    @Test func acknowledgedClipboardThenCommitFileFailurePreservesBothAxes() throws {
        let harness = try Harness()
        var validations = 0, writes = 0
        let receipt = try harness.perform(beforeCommit: {
            validations += 1
            if validations == 2 { try harness.preventCommitFile() }
        }, clipboard: { writes += 1 })
        #expect(validations == 2 && writes == 1)
        #expect(try harness.observedPhases() == ["ready"])
        try expectPartialClipboardEffect(receipt, clipboard: "written_unverified", directory: harness.directory)
    }

    @Test func acknowledgedClipboardThenHIDNotSentCannotClaimNoSideEffect() throws {
        let harness = try Harness()
        var writes = 0
        let receipt = try harness.perform(clipboard: { writes += 1 })
        #expect(writes == 1)
        #expect(try harness.observedPhases() == ["ready", "committed"])
        try expectPartialClipboardEffect(receipt, clipboard: "written_unverified", directory: harness.directory)
    }

    @Test func clipboardTimeoutIsUnconfirmedEvenWithUncommittedHID() throws {
        let harness = try Harness()
        let environment = try harness.clipboardEnvironment("printf 'called' > \"$CLIPBOARD_TEST_MARKER\"\nexec /bin/sleep 5\n")
        var failure: DeviceClipboard.WriteFailure?
        let receipt = try harness.perform(clipboard: {
            do { try DeviceClipboard.write("synthetic", environment: environment, timeout: 0.2) }
            catch {
                failure = error as? DeviceClipboard.WriteFailure
                throw error
            }
        })
        #expect(failure?.status == .unconfirmed)
        #expect(try harness.observedPhases() == ["ready"])
        try expectPartialClipboardEffect(receipt, clipboard: "unconfirmed", directory: harness.directory)
    }

    @Test func rejectionBeforeClipboardLaunchRemainsDefinitivelyNotSent() throws {
        let harness = try Harness()
        let environment = try harness.clipboardEnvironment("printf 'called' > \"$CLIPBOARD_TEST_MARKER\"\n")
        var failure: DeviceClipboard.WriteFailure?
        let receipt = try harness.perform(clipboard: {
            do { try DeviceClipboard.write("synthetic", environment: environment, beforeWrite: { throw Stop.identityChanged }) }
            catch {
                failure = error as? DeviceClipboard.WriteFailure
                throw error
            }
        })
        #expect(failure?.status == .notWritten)
        #expect(!FileManager.default.fileExists(atPath: environment["CLIPBOARD_TEST_MARKER"]!))
        #expect(try harness.observedPhases() == ["ready"])
        #expect(receipt["input_status"] as? String == "not_sent")
        #expect(receipt["hid_input_status"] as? String == "not_sent")
        #expect(receipt["clipboard_status"] as? String == "not_written")
        let response = CoreDeviceKeyboard.response(receipt, device: "11111111-1111111111111111")
        let body = try #require(try JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(body["input_sent"] as? Bool == false)
    }

    @Test func legacyClipboardReceiptCannotReintroduceNoInputOrNoOpClaims() throws {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("clipboard-legacy-receipt-\(UUID().uuidString)")
        defer { try? FileManager.default.removeItem(at: directory) }
        for clipboard in ["written_unverified", "unconfirmed"] {
            for asBatch in [false, true] {
                let transport: [String: Any] = ["backend": "coredevice-keyboard", "input_status": "not_sent",
                    "hid_input_status": "not_sent", "clipboard_status": clipboard, "no_op": true]
                let steps: [[String: Any]] = [["step": 1, "type": "type", "ok": false,
                    "keyboard_receipt": transport, "input_sent": false]]
                let recording = MCPContextRecording(device: UUID().uuidString, tool: "act", arguments: [:], kind: "input", directory: directory)
                recording.requestStarted()
                recording.fail(MCPServer.MCPError("legacy receipt", httpStatus: 409, inputNotSent: true,
                    transportReceipt: transport, stepReceipts: asBatch ? steps : nil))
                let result = recording.attach(to: ["structuredContent": ["input_sent": false, "ok": true]])
                let metadata = try #require(result["structuredContent"] as? [String: Any])
                let input = try #require(metadata["input_receipt"] as? [String: Any])
                #expect(input["status"] as? String == "unconfirmed")
                #expect(metadata["input_sent"] == nil && metadata["ok"] as? Bool == false)
                #expect(result["isError"] as? Bool == true)
                let text = try #require(MCPResultSummary.text(metadata))
                #expect(text.contains("Input: unconfirmed") && text.contains("HID: not sent."))
                #expect(!text.contains("nothing sent") && !text.contains("Input: not sent."))
            }
        }
    }
}
