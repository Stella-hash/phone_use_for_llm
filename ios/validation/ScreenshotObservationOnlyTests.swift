import Foundation
import Testing

@testable import iPhoneUse

/// Offline response-policy checks: no device, capture, listener or input is created.
@Suite struct ScreenshotObservationOnlyTests {
    private let screen = CGSize(width: 2556, height: 1180)

    private func headers(
        _ store: ScreenshotReferences, query: [String: String] = [:],
        sequence: UInt64 = 42, receivedAt: TimeInterval = 123.5
    ) throws -> [String: String] {
        ControlAPI.screenshotHeaders(
            device: "phone-a", source: "capture-a", screenSize: screen, imageSize: (1200, 554),
            sequence: sequence, receivedAt: receivedAt,
            observationOnly: try ControlAPI.screenshotObservationOnly(query), references: store)
    }

    private func consume(_ store: ScreenshotReferences, _ id: String) throws -> ScreenshotReferences.Reference {
        try store.consume(id, device: "phone-a", source: "capture-a", screenSize: screen)
    }

    @Test func onlyExplicitObservationOnlyOptOutChangesTheDefault() throws {
        for query in [
            [:], ["observationOnly": "0"],
            ["format": "png", "maxEdge": "1200", "ocr": "1", "device": "phone-a"],
            ["stability": "1"], ["unrelated": "preserved"],
        ] {
            #expect(try !ControlAPI.screenshotObservationOnly(query))
            let store = ScreenshotReferences()
            let result = try headers(store, query: query)
            let id = try #require(result["X-Frame-ID"])
            #expect(!id.isEmpty)
            let reference = try consume(store, id)
            #expect(reference.width == 1200)
            #expect(reference.height == 554)
            #expect(throws: ScreenshotReferences.Rejected.self) { try consume(store, id) }
        }
        #expect(try ControlAPI.screenshotObservationOnly(["observationOnly": "1"]))
    }

    @Test func malformedOptOutRejectsRatherThanSilentlyAllocatingAReference() throws {
        // wake=0 and a stopped, injected activity controller make this a passive
        // dispatch test. Parsing must reject before trying to resolve the device.
        let activity = QuietModeActivityController(environment: [:])
        let trace = PointerTraceWindow(now: { 0 })
        for invalid in ["", "true", "false", "yes", "01", " 1", "1 ", "-1", "2", "0.0"] {
            #expect(throws: DeviceError.self) {
                try ControlAPI.screenshotObservationOnly(["observationOnly": invalid])
            }
            let response = ControlAPI.handle(
                HTTPRequest(
                    method: "GET", path: "/screenshot",
                    query: ["observationOnly": invalid, "wake": "0", "device": "offline-fixture"], body: [:]),
                ocrCapture: { _, _ in
                    Issue.record("Invalid screenshot option must not invoke capture")
                    return ("unused", Data())
                }, activity: activity, pointerTrace: trace)
            #expect(response.status == 400)
            #expect(response.headers["X-Frame-ID"] == nil)
            let body = try #require(JSONSerialization.jsonObject(with: response.body) as? [String: String])
            #expect(body["error"] == "observationOnly must be 0 or 1")
        }
    }

    @Test func duplicateOptionsKeepTheExistingLastValueWinsRule() throws {
        for (query, expected) in [("observationOnly=0&observationOnly=1", true),
                                  ("observationOnly=1&observationOnly=0", false)] {
            let request = try #require(HTTPRequest.parse(Data("GET /screenshot?\(query) HTTP/1.1\r\n\r\n".utf8)))
            #expect(try ControlAPI.screenshotObservationOnly(request.query) == expected)
        }
    }

    @Test func previewHeadersPreserveEveryObservationFieldExceptTheInputReference() throws {
        let store = ScreenshotReferences()
        var ordinary = try headers(store)
        let allocatedID = ordinary.removeValue(forKey: "X-Frame-ID")
        let id = try #require(allocatedID)
        let preview = try headers(store, query: ["observationOnly": "1"])
        #expect(preview["X-Frame-ID"] == nil)
        #expect(preview == ordinary)
        #expect(preview == [
            "Cache-Control": "no-store",
            "X-Device": "phone-a", "X-Frame-Source": "capture-a", "X-Frame-Sequence": "42",
            "X-Frame-Received-At": "123.5", "X-Screen-Width": "2556", "X-Screen-Height": "1180",
            "X-Image-Width": "1200", "X-Image-Height": "554",
        ])
        #expect(try consume(store, id).id == id)
    }

    @Test func hundredsOfPreviewFramesCannotEvictOrConsumeAnActionableFrame() throws {
        let store = ScreenshotReferences()
        let first = try #require(headers(store)["X-Frame-ID"])
        let second = try #require(headers(store)["X-Frame-ID"])
        for sequence in 0..<512 {
            let preview = try headers(
                store, query: ["observationOnly": "1"], sequence: UInt64(sequence), receivedAt: Double(sequence))
            #expect(preview["X-Frame-ID"] == nil)
            #expect(preview["X-Frame-Sequence"] == String(sequence))
        }
        #expect(try consume(store, first).id == first)
        #expect(try consume(store, second).id == second)
        #expect(throws: ScreenshotReferences.Rejected.self) { try consume(store, first) }
    }

    @Test func ordinaryScreenshotsStillAllocateAndEvictAtTheExistingCapacity() throws {
        let store = ScreenshotReferences()
        let first = try #require(headers(store)["X-Frame-ID"])
        var latest = first
        for _ in 0..<128 {
            latest = try #require(headers(store)["X-Frame-ID"])
        }
        #expect(throws: ScreenshotReferences.Rejected.self) { try consume(store, first) }
        #expect(try consume(store, latest).id == latest)
    }

    @Test func internalBaselineBurstAndPollsPreserveEveryTokenInAFullCache() throws {
        let store = ScreenshotReferences(capacity: 128)
        let ids = try (0..<128).map { _ in try #require(headers(store)["X-Frame-ID"]) }
        // The first token is already the next eviction candidate before the
        // action's private baseline read. Internal observations must issue none.
        for query in [
            ["format": "png", "stability": "1", "observationOnly": "1"],
            ["ocr": "1", "observationOnly": "1"],
        ] {
            for sequence in 0..<256 {
                #expect(try headers(store, query: query, sequence: UInt64(sequence))["X-Frame-ID"] == nil)
            }
        }
        for id in ids { #expect(try consume(store, id).id == id) }
    }
}
