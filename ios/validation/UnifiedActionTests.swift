import Foundation
import Testing

@testable import iPhoneUse

/// Exercises the production batch executor and final MCP projection with fake
/// leaf responses. No capture manager, USB, BLE, clipboard or phone is used.
@Suite struct UnifiedActionTests {
    private let frame = "00000000-0000-4000-8000-000000000001"
    private var tap: [String: Any] { ["type": "tap", "frame_id": frame, "x": 12, "y": 34] }
    private var key: [String: Any] { ["type": "key", "key": "enter"] }
    private var sent: [String: Any] { ["backend": "coredevice", "input_status": "sent_unverified"] }

    private func reject(_ body: () throws -> Void) {
        do { try body(); Issue.record("Invalid public action was accepted") } catch { }
    }

    private func decoded(_ response: HTTPResponse) throws -> [String: Any] {
        try #require(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
    }

    private func run(_ steps: [[String: Any]],
        execute: (String, [String: Any], String?) throws -> HTTPResponse) throws -> HTTPResponse {
        let request = try ActRequest(["steps": steps], requireFrameTouch: true)
        return try request.perform(device: "fixture", capture: { _, _ in
            throw InputRequestError("Unexpected capture in this fixture")
        }, sleep: { _ in }, execute: execute)
    }

    private func project(_ response: HTTPResponse) throws -> [String: Any] {
        let directory = FileManager.default.temporaryDirectory.appendingPathComponent("unified-actions-\(UUID())")
        defer { try? FileManager.default.removeItem(at: directory) }
        let recording = MCPContextRecording(device: "fixture", tool: "act", arguments: [:], kind: "input", directory: directory)
        recording.requestStarted()
        if response.status == 200 {
            recording.requestAcknowledged()
            recording.recordTransport(response.body)
            let observation = MCPServer.ObservationResult(status: .unobserved, reason: "disabled")
            recording.finish(observation)
            return recording.attach(to: MCPServer.observationContent(observation,
                includeImage: false, diff: false, inputStatus: recording.transportStatus))
        }
        recording.fail(MCPHTTPClient.check(response.body, status: response.status, language: .en))
        return recording.attach(to: ["content": [["type": "text", "text": "fixture stopped"]], "isError": true])
    }

    private func inputReceipt(_ projected: [String: Any]) throws -> [String: Any] {
        let metadata = try #require(projected["structuredContent"] as? [String: Any])
        return try #require(metadata["input_receipt"] as? [String: Any])
    }

    @Test func publicCatalogHasSevenToolsAndNoRetiredCallingGuidance() {
        let expected: Set<String> = ["session_context", "accessibility_tree", "list_devices", "screenshot", "screenshot_burst", "ocr_screen", "act"]
        for language in [AppLanguage.en, .zh] {
            let tools = MCPToolCatalog.tools(for: language)
            #expect(Set(tools.compactMap { $0["name"] as? String }) == expected)
            let guidance = tools.compactMap { $0["description"] as? String }.joined(separator: "\n")
                + StringsMCP(language: language).instructions
            for retired in ["long_press", "touch_sequence", "tap_text", "type_text", "press_key", "keyboard_sequence"] {
                #expect(!guidance.contains(retired))
            }
        }
    }

    @Test func publicTouchIsOnePixelFrameStepFirstAndNonTouchBatchesRemainValid() throws {
        let swipe: [String: Any] = ["type": "swipe", "frame_id": frame, "points": [["x": 1, "y": 2], ["x": 3, "y": 4]], "duration": 0.1]
        let touch: [String: Any] = ["type": "touch", "frame_id": frame, "samples": [
            ["at_ms": 0, "contacts": [["id": 0, "x": 1, "y": 2]]], ["at_ms": 10, "contacts": []],
        ]]
        let tail: [[String: Any]] = [["type": "type", "text": "owned"], key, ["type": "home"],
            ["type": "delay", "seconds": 0], ["type": "wait_text", "text": "owned", "timeout": 0]]
        for first in [tap, swipe, touch] {
            _ = try ActRequest(["steps": [first] + tail], requireFrameTouch: true)
            reject { _ = try ActRequest(["steps": [["type": "delay", "seconds": 0], first]], requireFrameTouch: true) }
            reject { _ = try ActRequest(["steps": [first, first]], requireFrameTouch: true) }
            var missing = first; missing.removeValue(forKey: "frame_id")
            reject { _ = try ActRequest(["steps": [missing]], requireFrameTouch: true) }
            for normalized in [false, true] {
                reject { _ = try ActRequest(["steps": [first.merging(["normalized": normalized]) { _, value in value }]], requireFrameTouch: true) }
            }
        }
        _ = try ActRequest(["steps": tail], requireFrameTouch: true)
        // Bound coordinates are checked against the issued frame at the leaf,
        // not against an unrelated current capture/maxEdge during preflight.
        _ = try ActRequest(["steps": [["type": "tap", "frame_id": frame, "x": 1500, "y": 1900]]],
            screenSize: CGSize(width: 300, height: 600), requireGeometry: true, requireFrameTouch: true)
        // A frame-bearing HTTP act must have the same ordering even outside MCP.
        reject { _ = try ActRequest(["steps": [["type": "home"], tap]]) }
        reject { _ = try ActRequest(["steps": [["type": "tap_text", "text": "owned"]]], requireFrameTouch: true) }
    }

    @Test func mcpTouchStepsRetainPixelsAndRejectMissingFrameOrNormalization() throws {
        let cases: [[String: Any]] = [
            ["type": "tap", "x": 1, "y": 2],
            ["type": "tap", "x": 1, "y": 2, "hold": 0.2],
            ["type": "swipe", "points": [["x": 1, "y": 2], ["x": 3, "y": 4]], "duration": 0.1],
            ["type": "touch", "samples": [["at_ms": 0, "contacts": [["id": 0, "x": 1, "y": 2]]], ["at_ms": 10, "contacts": []]]],
        ]
        for body in cases {
            reject { _ = try MCPToolRequest.action(named: "act", arguments: ["steps": [body]], longEdge: 1000) }
            var bound = body; bound["frame_id"] = frame
            let request = try #require(try MCPToolRequest.action(named: "act", arguments: ["steps": [bound]], longEdge: 1000))
            let step = try #require((request.body["steps"] as? [[String: Any]])?.first)
            #expect(request.path == "/act" && step["type"] as? String == body["type"] as? String)
            #expect(step["frame_id"] as? String == frame)
            #expect(step["normalized"] == nil && step["fraction"] == nil)
            for normalized in [false, true] {
                var malformed = bound; malformed["normalized"] = normalized
                reject { _ = try MCPToolRequest.action(named: "act", arguments: ["steps": [malformed]], longEdge: 1000) }
            }
        }
    }

    @Test func invalidLaterStepPreventsEveryLeafAndClipboardOperation() {
        let later: [[String: Any]] = [
            ["type": "key", "key": "enter", "frame_id": frame],
            ["type": "key", "key": "not-a-key"],
            ["type": "type", "text": "owned", "use_clipboard": "yes"],
            ["type": "type", "text": String(repeating: "a", count: 1000), "use_clipboard": false],
            ["type": "delay", "seconds": 7],
        ]
        for step in later {
            var executed = 0
            reject {
                let request = try ActRequest(["steps": [tap, step]], directKeyboardConfigured: true, requireFrameTouch: true)
                _ = try request.perform(device: "fixture", capture: { _, _ in throw InputRequestError("unexpected capture") }, execute: { _, _, _ in
                    executed += 1
                    return .json(["ok": true])
                })
            }
            #expect(executed == 0)
        }
    }

    @Test func individuallyLegalUSBProgramsCannotExceedWholeBatchPlanBudget() throws {
        let step: [String: Any] = ["type": "type", "text": String(repeating: "a", count: 30),
            "use_clipboard": false, "ensure_chinese_ime": false]
        // This input is individually legal (5.92s planned HID), but sixteen
        // copies would take at least 94.72s before service/cleanup overhead.
        _ = try ActRequest(["steps": [step]], directKeyboardConfigured: true, requireFrameTouch: true)
        var calls = 0
        reject {
            let request = try ActRequest(["steps": Array(repeating: step, count: 16)],
                directKeyboardConfigured: true, requireFrameTouch: true)
            _ = try request.perform(device: "fixture", capture: { _, _ in
                throw InputRequestError("Unexpected capture")
            }, execute: { _, _, _ in
                calls += 1
                return .json(["ok": true])
            })
        }
        #expect(calls == 0)
        // Short batches retain their normal execution path.
        let short = try ActRequest(["steps": [step, key]], directKeyboardConfigured: true, requireFrameTouch: true)
        let result = try short.perform(device: "fixture", capture: { _, _ in
            throw InputRequestError("Unexpected capture")
        }, now: { 0 }, execute: { _, _, _ in calls += 1; return .json(["ok": true]) })
        #expect(calls == 2 && result.status == 200)
    }

    @Test func elapsedAdmissionWindowStopsOnlyUnstartedTailAndKeepsPrefixReceipt() throws {
        let request = try ActRequest(["steps": [tap, key, ["type": "home"]]], requireFrameTouch: true)
        var clock = 0.0
        var paths: [String] = []
        let result = try request.perform(device: "fixture", capture: { _, _ in
            throw InputRequestError("Unexpected capture")
        }, now: { clock }, execute: { path, _, _ in
            paths.append(path)
            clock = 30.001 // The already-started leaf finishes; the next never starts.
            return .json(["ok": true, "touch_receipt": sent])
        })
        let body = try decoded(result)
        #expect(result.status != 200 && paths == ["/tap"])
        #expect(body["completed"] as? Int == 1 && body["failed_step"] as? Int == 2)
        let rows = try #require(body["step_receipts"] as? [[String: Any]])
        #expect(rows.count == 2 && rows[0]["ok"] as? Bool == true)
        #expect((rows[0]["touch_receipt"] as? [String: Any])?["input_status"] as? String == "sent_unverified")
        #expect(rows[1]["input_sent"] as? Bool == false && rows[1]["ok"] as? Bool == false)
        #expect(rows[1]["keyboard_receipt"] == nil)
        let receipt = try inputReceipt(project(result))
        #expect(receipt["status"] as? String == "unconfirmed" && receipt["transport"] == nil)
    }

    @Test func http200TouchFailureStopsBeforeTailAndPreservesUncertainty() throws {
        var paths: [String] = []
        let receipt: [String: Any] = ["backend": "coredevice", "input_status": "unconfirmed", "reason": "owned failure"]
        let response = try run([tap, key]) { path, _, _ in
            paths.append(path)
            return .json(["ok": false, "touch_receipt": receipt])
        }
        let body = try decoded(response)
        #expect(paths == ["/tap"])
        #expect(body["ok"] as? Bool == false && body["completed"] as? Int == 0 && body["failed_step"] as? Int == 1)
        let rows = try #require(body["step_receipts"] as? [[String: Any]])
        #expect(rows.count == 1 && rows[0]["step"] as? Int == 1 && rows[0]["ok"] as? Bool == false)
        #expect((rows[0]["touch_receipt"] as? [String: Any])?["input_status"] as? String == "unconfirmed")
        let projected = try project(response)
        #expect(projected["isError"] as? Bool == true)
        #expect(try inputReceipt(projected)["status"] as? String == "unconfirmed")
    }

    @Test func staleFrameStopsWithNotSentAndNoFollowup() throws {
        var calls = 0
        let response = try run([tap, key]) { _, _, _ in
            calls += 1
            return .json(["error": "frame consumed", "frame_rejected": true, "input_sent": false], status: 409)
        }
        let body = try decoded(response)
        let rows = try #require(body["step_receipts"] as? [[String: Any]])
        #expect(calls == 1 && body["completed"] as? Int == 0 && body["failed_step"] as? Int == 1)
        #expect(rows.count == 1 && rows[0]["frame_rejected"] as? Bool == true && rows[0]["input_sent"] as? Bool == false)
        #expect(try inputReceipt(project(response))["status"] as? String == "not_sent")
    }

    @Test func earlierTouchRemainsVisibleWhenLaterKeyboardFails() throws {
        let failed: [String: Any] = ["backend": "coredevice-keyboard", "input_status": "not_sent",
            "cleanup": ["errors": [["stage": "close", "error_type": "OwnedFixtureError"]]]]
        let response = try run([tap, key]) { path, _, _ in
            path == "/tap" ? .json(["ok": true, "touch_receipt": sent])
                : .json(["ok": false, "keyboard_receipt": failed], status: 409)
        }
        let body = try decoded(response)
        #expect(body["completed"] as? Int == 1 && body["failed_step"] as? Int == 2)
        let projected = try project(response), receipt = try inputReceipt(projected)
        let rows = try #require(receipt["steps"] as? [[String: Any]])
        #expect(rows.count == 2 && rows[0]["touch_receipt"] != nil && rows[1]["keyboard_receipt"] != nil)
        #expect(receipt["status"] as? String == "unconfirmed" && receipt["transport"] == nil)
        #expect(rows.allSatisfy { $0["x"] == nil && $0["text"] == nil && $0["key"] == nil })
        let text = (projected["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
        #expect(text.contains("Cleanup: warning"))
    }

    @Test func noOpCannotEraseEarlierInputAndAcknowledgedHomeIsNotLocallySent() throws {
        let noOp: [String: Any] = ["backend": "coredevice-keyboard", "input_status": "not_sent", "no_op": true]
        let empty: [String: Any] = ["type": "type", "text": "", "use_clipboard": false]
        let response = try run([tap, ["type": "delay", "seconds": 0], empty]) { path, _, _ in
            path == "/tap" ? .json(["ok": true, "touch_receipt": sent]) : .json(["ok": true, "keyboard_receipt": noOp])
        }
        let projected = try project(response), receipt = try inputReceipt(projected)
        #expect(receipt["status"] as? String == "sent_unverified")
        #expect((receipt["steps"] as? [[String: Any]])?.count == 3)
        #expect(projected["isError"] as? Bool != true)
        #expect((projected["structuredContent"] as? [String: Any])?["ok"] as? Bool == true)
        let home = try project(run([["type": "home"], empty]) { path, _, _ in
            path == "/home" ? .json(["ok": true]) : .json(["ok": true, "keyboard_receipt": noOp])
        })
        #expect(try inputReceipt(home)["status"] as? String == "acknowledged")
        #expect(home["isError"] as? Bool != true)
        #expect((home["structuredContent"] as? [String: Any])?["ok"] as? Bool == true)
        let text = (home["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
        #expect(text.contains("request acknowledged") && !text.contains("locally sent"))
        let waiting = try project(run([["type": "delay", "seconds": 0]]) { _, _, _ in
            Issue.record("A delay-only batch must not dispatch input")
            return .json(["ok": true])
        })
        let waitingReceipt = try inputReceipt(waiting)
        #expect(waitingReceipt["status"] as? String == "not_sent" && waitingReceipt["no_op"] as? Bool == true)
        #expect((waiting["structuredContent"] as? [String: Any])?["ok"] as? Bool == true)
        #expect(waiting["isError"] as? Bool != true)
        let waitingText = (waiting["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
        #expect(!waitingText.contains("locally sent"))
    }

    @Test func earlierAcknowledgedHomeCannotBorrowLaterKeyboardBackend() throws {
        let stopped: [String: Any] = ["backend": "coredevice-keyboard", "input_status": "not_sent"]
        let response = try run([["type": "home"], key]) { path, _, _ in
            path == "/home" ? .json(["ok": true]) : .json(["ok": false, "keyboard_receipt": stopped], status: 409)
        }
        let projected = try project(response), receipt = try inputReceipt(projected)
        #expect(receipt["status"] as? String == "unconfirmed")
        #expect(receipt["transport"] == nil)
        let rows = try #require(receipt["steps"] as? [[String: Any]])
        #expect(rows.count == 2 && rows[0]["ok"] as? Bool == true)
        #expect(rows[0]["keyboard_receipt"] == nil)
        #expect((rows[1]["keyboard_receipt"] as? [String: Any])?["input_status"] as? String == "not_sent")
        let text = (projected["content"] as? [[String: Any]] ?? []).compactMap { $0["text"] as? String }.joined()
        #expect(!text.contains("coredevice-keyboard") && text.contains("unconfirmed"))
    }

    @Test func completedDelayDoesNotInventEarlierInputOnFirstInputRejection() throws {
        let response = try run([["type": "delay", "seconds": 0], key]) { _, _, _ in
            .json(["ok": false, "keyboard_receipt": ["backend": "coredevice-keyboard", "input_status": "not_sent"]], status: 409)
        }
        let body = try decoded(response)
        #expect(body["completed"] as? Int == 1 && body["failed_step"] as? Int == 2)
        #expect(try inputReceipt(project(response))["status"] as? String == "not_sent")
    }
}
