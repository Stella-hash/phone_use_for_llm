import AppKit
import Testing

@testable import iPhoneUse

/// Cached OCR and an injected monotonic clock exercise the production executor
/// without real waiting, Vision recognition, device capture or input.
@Suite struct WaitTextDeadlineTests {
    private func image(device: String, texts: [String]) throws -> Data {
        let context = try #require(CGContext(data: nil, width: 16, height: 16, bitsPerComponent: 8, bytesPerRow: 0,
            space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue))
        context.setFillColor(CGColor(gray: 1, alpha: 1))
        context.fill(CGRect(x: 0, y: 0, width: 16, height: 16))
        let bitmap = NSBitmapImageRep(cgImage: try #require(context.makeImage()))
        let data = try #require(bitmap.representation(using: .png, properties: [:]))
        let result = ScreenOCR.recognize(data, device: device,
            recognition: { _ in texts.map { .init(text: $0, x: 1, y: 2) } })
        #expect(result.items.map(\.text) == texts)
        return data
    }

    private func request(timeout: TimeInterval = 0.25) throws -> ActRequest {
        try ActRequest(["steps": [
            ["type": "wait_text", "text": "ready", "exact": true, "timeout": timeout],
            ["type": "home"], ["type": "type", "text": "owned", "use_clipboard": false],
        ]], directKeyboardConfigured: false, requireFrameTouch: true)
    }

    private func expectTimeout(_ response: HTTPResponse) throws {
        #expect(response.status == 400)
        let body = try #require(try JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(body["ok"] as? Bool == false)
        #expect(body["failed_step"] as? Int == 1 && body["completed"] as? Int == 0)
        #expect((body["error"] as? String)?.contains("wait_text timed out") == true)
        let receipts = try #require(body["step_receipts"] as? [[String: Any]])
        #expect(receipts.count == 1 && receipts[0]["ok"] as? Bool == false)
        #expect(receipts[0]["type"] as? String == "wait_text")
    }

    @Test(arguments: [0.25, 0.251])
    func matchingCaptureAtOrAfterDeadlineCannotExecuteHomeOrType(_ captureSeconds: TimeInterval) throws {
        let device = UUID().uuidString
        let data = try image(device: device, texts: ["ready"])
        var clock = 10.0, captures = 0
        var paths: [String] = []
        let response = try request().perform(device: device, capture: { _, _ in
            captures += 1
            clock += captureSeconds
            return (device, data)
        }, sleep: { _ in Issue.record("A late capture must time out immediately") }, now: { clock },
        execute: { path, _, _ in paths.append(path); return .json(["ok": true]) })
        try expectTimeout(response)
        #expect(captures == 1 && paths.isEmpty)
    }

    @Test func matchingCaptureInsideDeadlineAdmitsFollowingInput() throws {
        let device = UUID().uuidString
        let data = try image(device: device, texts: ["ready"])
        var clock = 10.0, captures = 0
        var paths: [String] = []
        let response = try request().perform(device: device, capture: { _, _ in
            captures += 1
            clock += 0.249
            return (device, data)
        }, sleep: { _ in Issue.record("A match inside the deadline must not poll again") }, now: { clock },
        execute: { path, _, _ in paths.append(path); return .json(["ok": true]) })
        #expect(response.status == 200 && captures == 1)
        #expect(paths == ["/home", "/type"])
        let body = try #require(try JSONSerialization.jsonObject(with: response.body) as? [String: Any])
        #expect(body["completed"] as? Int == 3)
    }

    @Test func deadlineCrossingAfterCaptureStillRejectsTheOCRMatch() throws {
        let device = UUID().uuidString
        let data = try image(device: device, texts: ["ready"])
        var captured = false, afterCaptureChecks = 0, inputs = 0
        let response = try request().perform(device: device, capture: { _, _ in
            captured = true
            return (device, data)
        }, sleep: { _ in Issue.record("An expired match cannot start another poll") }, now: {
            guard captured else { return 10 }
            afterCaptureChecks += 1
            // Capture returned inside the window; time has crossed the deadline
            // when the executor checks the completed OCR match.
            return afterCaptureChecks == 1 ? 10.1 : 10.3
        }, execute: { _, _, _ in inputs += 1; return .json(["ok": true]) })
        try expectTimeout(response)
        #expect(captured && afterCaptureChecks >= 2 && inputs == 0)
    }

    @Test func expiredPollDeadlineDoesNotStartAnotherCapture() throws {
        let device = UUID().uuidString
        let data = try image(device: device, texts: [])
        var clock = 10.0, captures = 0, inputs = 0
        var delays: [TimeInterval] = []
        let response = try request().perform(device: device, capture: { _, _ in
            captures += 1
            return (device, data)
        }, sleep: { delay in
            delays.append(delay)
            clock += 0.3 // Simulate a delayed wake-up past the absolute deadline.
        }, now: { clock }, execute: { _, _, _ in inputs += 1; return .json(["ok": true]) })
        try expectTimeout(response)
        #expect(captures == 1 && inputs == 0)
        #expect(delays == [0.1])
    }

    @Test func zeroTimeoutStartsNeitherCaptureNorFollowingInput() throws {
        var captures = 0, inputs = 0
        let response = try request(timeout: 0).perform(device: "fixture", capture: { _, _ in
            captures += 1
            return ("fixture", Data())
        }, sleep: { _ in Issue.record("An immediate deadline cannot sleep") }, now: { 10 },
        execute: { _, _, _ in inputs += 1; return .json(["ok": true]) })
        try expectTimeout(response)
        #expect(captures == 0 && inputs == 0)
    }
}
