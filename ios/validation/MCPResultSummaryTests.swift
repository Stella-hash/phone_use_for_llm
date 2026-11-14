import Foundation
import Testing
@testable import iPhoneUse

struct MCPResultSummaryTests {
    private func directory() -> URL {
        FileManager.default.temporaryDirectory.appendingPathComponent("mcp-summary-test-\(UUID().uuidString)")
    }

    private func blocks(_ result: [String: Any]) -> [[String: Any]] {
        result["content"] as? [[String: Any]] ?? []
    }

    private func text(_ result: [String: Any]) -> String {
        blocks(result).compactMap { $0["text"] as? String }.joined(separator: "\n")
    }

    private func sameJSON(_ lhs: Any?, _ rhs: Any?) throws -> Bool {
        guard let lhs, let rhs else { return false }
        return try JSONSerialization.data(withJSONObject: lhs, options: [.sortedKeys, .fragmentsAllowed]) ==
            JSONSerialization.data(withJSONObject: rhs, options: [.sortedKeys, .fragmentsAllowed])
    }

    private func frame() -> MCPServer.ObservationFrame {
        MCPServer.ObservationFrame(
            image: Data("synthetic-image-bytes".utf8), device: "summary-test", width: "500", height: "1000",
            mimeType: "image/png", identity: .init(source: "source-1", sequence: 2, receivedAt: 10.2),
            signature: "new", ocr: .init(width: 500, height: 1000,
                items: [.init(text: "existing OCR", x: 10, y: 20)]), frameID: "returned-frame")
    }

    @Test func sentInputAndObservationTimeoutStaySeparateWithExactPayloads() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "tap",
            arguments: ["frame_id": "input-frame"], kind: "input", directory: folder)
        let transport: [String: Any] = [
            "input_status": "sent_unverified", "backend": "coredevice", "device_delivery": "unverified",
            "cleanup": ["errors": [], "connection_closed": true],
            "diagnostic_payload": String(repeating: "transport-detail-", count: 100),
        ]
        recording.requestStarted(); recording.requestAcknowledged()
        recording.recordTransport(try JSONSerialization.data(withJSONObject: ["touch_receipt": transport]))
        let observation = MCPServer.ObservationResult(
            status: .timeout, frame: frame(), elapsed: 1.5, fresh: true, changed: true, stable: false)
        recording.finish(observation)
        let original = MCPServer.observationContent(observation, includeImage: true, diff: false, inputStatus: "sent_unverified")
        let result = recording.attach(to: original)
        let metadata = try #require(result["structuredContent"] as? [String: Any])
        let receipt = try #require(metadata["input_receipt"] as? [String: Any])
        #expect(try sameJSON(receipt["transport"], transport))
        for (key, value) in original["structuredContent"] as! [String: Any] {
            #expect(try sameJSON(metadata[key], value))
        }
        #expect(receipt["based_on_frame_id"] as? String == "input-frame")
        #expect(try sameJSON(Array(blocks(result).prefix(blocks(original).count)), blocks(original)))
        #expect(blocks(result).first?["data"] as? String == frame().image.base64EncodedString())
        #expect(blocks(result).filter { ($0["text"] as? String)?.hasPrefix("Input:") == true }.count == 1)
        #expect(text(result).contains("Input: locally sent (coredevice); device delivery unverified."))
        #expect(text(result).contains("Observation: wait timed out; fresh=yes, changed=yes, stable=no."))
        #expect(text(result).contains("App result: unverified."))
        #expect(text(result).contains("existing OCR") && !text(result).contains("returned-frame"))
        #expect(metadata["frame"] == nil)
        #expect(metadata["touch_reference"] as? [String: String] ==
            ["status": "not_issued", "reason": "action_observation_only", "next_tool": "screenshot"])
        #expect(text(result).contains("call screenshot for a fresh frame.id"))
        #expect(!text(result).contains("transport-detail-") && !text(result).contains("\"input_receipt\":"))
        #expect(result["isError"] == nil)
    }

    @Test func keyboardSummaryUsesFinalReceiptWithoutRequiringAFrameArgument() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "type_text",
            arguments: [:], kind: "input", directory: folder)
        recording.requestStarted(); recording.requestAcknowledged()
        recording.recordTransport(try JSONSerialization.data(withJSONObject: [
            "keyboard_receipt": ["input_status": "sent_unverified", "backend": "coredevice-keyboard"],
        ]))
        let observation = MCPServer.ObservationResult(status: .stable, fresh: true, changed: false, stable: true)
        recording.finish(observation)
        let result = recording.attach(to: MCPServer.observationContent(
            observation, includeImage: false, diff: false, inputStatus: "sent_unverified"))
        #expect(text(result).contains("locally sent (coredevice-keyboard)"))
        #expect(text(result).contains("Observation: stable; fresh=yes, changed=no, stable=yes."))
        #expect(text(result).contains("App result: unverified."))
    }

    @Test func acknowledgementWithoutTransportDoesNotInventBackendOrDelivery() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "home",
            arguments: [:], kind: "input", directory: folder)
        recording.requestStarted(); recording.requestAcknowledged()
        let observation = MCPServer.ObservationResult(status: .unobserved, reason: "disabled")
        recording.finish(observation)
        let result = recording.attach(to: MCPServer.observationContent(observation, includeImage: false, diff: false))
        #expect(text(result) == "Input: request acknowledged; device delivery unverified.\nObservation: not requested.\nApp result: unverified.")
        #expect(blocks(result).count == 1)
        #expect(!text(result).contains("BLE") && !text(result).contains("coredevice"))
    }

    @Test func laterFailureKeepsProgressAndCleanupWarningWithoutClaimingEarlierSuccess() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "keyboard_sequence",
            arguments: [:], kind: "input", directory: folder)
        recording.requestStarted(); recording.requestAcknowledged()
        recording.recordTransport(try JSONSerialization.data(withJSONObject: [
            "keyboard_receipt": ["input_status": "sent_unverified", "backend": "coredevice-keyboard"],
        ]))
        recording.requestStarted()
        let failed: [String: Any] = ["input_status": "not_sent", "backend": "coredevice-keyboard",
            "reason": "synthetic failure", "cleanup": ["errors": [["stage": "close", "error_type": "OSError"]]]]
        recording.fail(MCPServer.MCPError("step 2 stopped", completedSteps: 1, failedStep: 2, transportReceipt: failed))
        let original: [String: Any] = ["content": [["type": "text", "text": "step 2 stopped; step 1 may have executed"]], "isError": true]
        let result = recording.attach(to: original)
        let receipt = (result["structuredContent"] as! [String: Any])["input_receipt"] as! [String: Any]
        let transport = receipt["transport"] as! [String: Any]
        #expect(receipt["status"] as? String == "unconfirmed")
        #expect(transport["completed_steps"] as? Int == 1)
        #expect(transport["failed_step_input_status"] as? String == "not_sent")
        #expect(try sameJSON(transport["cleanup"], failed["cleanup"]))
        #expect(blocks(result).first?["text"] as? String == blocks(original).first?["text"] as? String)
        #expect(text(result).contains("Input: unconfirmed") && !text(result).contains("Input: locally sent"))
        #expect(text(result).contains("Cleanup: warning") && text(result).contains("synthetic failure"))
        #expect(text(result).contains("Observation: not recorded.") && result["isError"] as? Bool == true)
    }

    @Test func cleanupFailuresRemainVisibleAndUnchanged() throws {
        let warnings: [[String: Any]] = [
            ["cleanup": ["errors": [["stage": "close"]]]],
            ["cleanup": ["tunnel_closed": false]],
            ["cleanup": ["subscription_stop": "not-acknowledged"]],
            ["cleanup": ["status": "warning"]],
            ["cleanup_release": ["status": "unconfirmed"]],
        ]
        for warning in warnings {
            let folder = directory()
            defer { try? FileManager.default.removeItem(at: folder) }
            let recording = MCPContextRecording(device: "summary-test", tool: "tap",
                arguments: ["frame_id": "input-frame"], kind: "input", directory: folder)
            var transport = warning
            transport["input_status"] = "unconfirmed"
            recording.requestStarted(); recording.requestAcknowledged()
            recording.recordTransport(try JSONSerialization.data(withJSONObject: ["touch_receipt": transport]))
            let result = recording.attach(to: ["content": [["type": "text", "text": "existing failure detail"]], "isError": true])
            let receipt = (result["structuredContent"] as! [String: Any])["input_receipt"] as! [String: Any]
            #expect(try sameJSON(receipt["transport"], transport))
            #expect(text(result).contains("existing failure detail") && text(result).contains("Cleanup: warning"))
            #expect(result["isError"] as? Bool == true)
        }
    }

    @Test func rejectionBeforeInputRetainsTheErrorAndDoesNotClaimASend() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "tap",
            arguments: ["frame_id": "stale-frame"], kind: "input", directory: folder)
        recording.requestStarted()
        recording.fail(MCPServer.MCPError("frame rejected before input", httpStatus: 409, inputNotSent: true))
        let result = recording.attach(to: [
            "content": [["type": "text", "text": "frame rejected before input"]], "isError": true,
        ])
        let receipt = (result["structuredContent"] as! [String: Any])["input_receipt"] as! [String: Any]
        #expect(receipt["status"] as? String == "not_sent")
        #expect(receipt["requests_acknowledged"] as? Int == 0)
        #expect(blocks(result).first?["text"] as? String == "frame rejected before input")
        #expect(text(result).contains("Input: not sent.") && !text(result).contains("Input: locally sent"))
        #expect(result["isError"] as? Bool == true)
    }

    @Test func noOpAndUnobservedReasonsDoNotBecomeExecutionOrAppSuccess() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "type_text",
            arguments: [:], kind: "input", directory: folder)
        recording.requestStarted(); recording.requestAcknowledged()
        recording.recordTransport(try JSONSerialization.data(withJSONObject: [
            "keyboard_receipt": ["input_status": "not_sent", "no_op": true,
                "cleanup_release": ["status": "not_needed"]],
        ]))
        let observation = MCPServer.ObservationResult(status: .unobserved, reason: "no_fresh_frame", detail: "original capture error")
        recording.finish(observation)
        let result = recording.attach(to: MCPServer.observationContent(observation, includeImage: false, diff: false, inputStatus: "not_sent"))
        #expect(result["isError"] == nil)
        #expect(text(result).contains("Input: no-op; nothing sent."))
        #expect(text(result).contains("changed=unknown") && text(result).contains("no_fresh_frame"))
        #expect(text(result).contains("original capture error") && text(result).contains("App result: unverified."))
        #expect(!text(result).contains("Cleanup: warning"))
    }

    @Test func observationOnlyResponsesReceiveNoInventedInputSummary() throws {
        let folder = directory()
        defer { try? FileManager.default.removeItem(at: folder) }
        let recording = MCPContextRecording(device: "summary-test", tool: "screenshot",
            arguments: [:], kind: "observation", directory: folder)
        recording.finishSnapshot(frame())
        let original = MCPServer.screenshotContent(frame(), includeImage: true, diff: false)
        let result = recording.attach(to: original)
        #expect(try sameJSON(blocks(result), blocks(original)))
        #expect(!text(result).contains("Input:") && !text(result).contains("App result:"))
        let metadata = try #require(result["structuredContent"] as? [String: Any])
        #expect((metadata["frame"] as? [String: Any])?["id"] as? String == "returned-frame")
    }
}
