// Codex-E /root/leaf_parsers · phone-use · 2026-11-07.
// Isolated production-source acceptance overlay for assembled tree
// b1dac0940205bad2cfeb17fc528d2117f1b3966c (patch 0021): 16/16 pass.
// Prior tree 2c0d3d92efa80f1fe133cb975588afb244bda697 failed the
// per-point metadata/Act preflight regression; all other 15 tests passed.
// Maintained for MCP pointer-tool retirement on 2026-11-07; earlier tree results
// above remain historical. HTTP pointer validation retains its live consumer.
// No listener, HID manager, USB, phone, clipboard, or provider operation.
import Foundation
import Testing

@testable import iPhoneUse

@Suite(.serialized) struct SharedInputValidationTests {
    private let size = CGSize(width: 100, height: 200)
    private let frame = "00000000-0000-4000-8000-000000000001"

    @Test func retiredPointerToolsHaveNeitherCatalogNorDispatch() throws {
        let retired = ["move_pointer", "adjust_pointer", "click_pointer", "tap", "long_press", "swipe",
                       "touch_sequence", "type_text", "press_key", "home", "keyboard_sequence", "tap_text"]
        for language in [AppLanguage.en, .zh] {
            let catalog = MCPToolCatalog.tools(for: language)
            let names = catalog.compactMap { $0["name"] as? String }
            #expect(names.count == 7)
            for name in retired {
                #expect(!names.contains(name))
                #expect(try MCPToolRequest.action(named: name,
                    arguments: ["x": 10, "y": 20, "dx": 1, "dy": 0],
                    longEdge: 1000, language: language) == nil)
            }
        }
        // Historical records retain their old names and coordinates when decoded.
        let json = Data(#"{"tool":"move_pointer","x":12,"y":34,"coordinates":"image-pixels"}"#.utf8)
        let old = try JSONDecoder().decode(MCPContextStore.Action.self, from: json)
        #expect(old.tool == "move_pointer" && old.x == 12 && old.y == 34)
        let saved = try JSONDecoder().decode(MCPContextStore.Action.self, from: JSONEncoder().encode(old))
        #expect(saved.tool == old.tool && saved.x == old.x && saved.y == old.y && saved.coordinates == old.coordinates)
    }

    private func reject(_ action: () throws -> Void) {
        do { try action(); Issue.record("Malformed input unexpectedly passed") }
        catch { }
    }

    private final class Reports {
        var rows: [(ReportID, [UInt8])] = []
        var ready: Set<ReportID> = [.keyboard, .relativeMouse, .absolutePointer, .consumer]
        var allowed = true
        lazy var input = DeviceInput(
            host: UUID(), session: UUID(), heldDragProfile: .notConfigured,
            inputIsAllowed: { [unowned self] in self.allowed }, sleep: { _ in },
            reportSender: { [unowned self] in self.rows.append(($0, $1)) },
            reportReadiness: { [unowned self] report, _, _ in self.ready.contains(report) })
    }

    @Test func malformedKeyAndModifiersAreRejectedAcrossCurrentParsers() {
        let bad: [[String: Any]] = [
            ["key": "not-a-key"], ["key": ""], ["key": true],
            ["key": "a", "modifiers": "command"], ["key": "a", "modifiers": [1]],
            ["key": "a", "modifiers": ["unknown"]], ["key": "a", "modifiers": NSNull()],
        ]
        for body in bad {
            reject { try ControlAPI.validateLeaf(path: "/key", body: body, screenSize: size) }
            reject { _ = try MCPToolRequest.action(named: "act",
                arguments: ["steps": [body.merging(["type": "key"]) { _, v in v }]], longEdge: 1000) }
            reject { _ = try ActRequest(["steps": [body.merging(["type": "key"]) { _, v in v }]], screenSize: size, requireGeometry: true) }
        }
    }

    @Test func validKeysKeepNamesAndModifiersAcrossCurrentParsers() throws {
        let body: [String: Any] = ["key": "RETURN", "modifiers": ["CMD", "shift"]]
        try ControlAPI.validateLeaf(path: "/key", body: body, screenSize: nil)
        let translated = try MCPToolRequest.action(named: "act",
            arguments: ["steps": [body.merging(["type": "key"]) { _, v in v }]], longEdge: 1000)
        let mcp = try #require(translated)
        #expect(mcp.path == "/act")
        let step = try #require((mcp.body["steps"] as? [[String: Any]])?.first)
        #expect(step["key"] as? String == "RETURN")
        #expect(step["modifiers"] as? [String] == ["CMD", "shift"])
        _ = try ActRequest(["steps": [body.merging(["type": "key"]) { _, v in v }]], requireGeometry: true)
    }

    @Test func keyboardMapReturnsNilInsteadOfTrappingForUnknownMulticharacterKeys() {
        for key in ["", "no-such-key", "aa", "🙂🙂", "enter\u{0}"] { #expect(KeyboardMap.code(for: key) == nil) }
        #expect(KeyboardMap.code(for: "RETURN") == 0x28)
        #expect(KeyboardMap.code(for: "A") == 0x04)
    }

    @Test func malformedHoldRejectedAtHTTPMCPAndActBeforeInput() {
        for hold: Any in [true, "1", NSNull(), Double.nan, Double.infinity, -1, 61] {
            reject { try ControlAPI.validateLeaf(path: "/tap", body: ["x": 10, "y": 20, "hold": hold], screenSize: size) }
            reject { _ = try MCPToolRequest.action(named: "act",
                arguments: ["steps": [["type": "tap", "frame_id": frame, "x": 10, "y": 20, "hold": hold]]], longEdge: 1000) }
            reject { _ = try ActRequest(["steps": [["type": "tap", "x": 10, "y": 20, "hold": hold]]], screenSize: size, requireGeometry: true) }
            reject { _ = try TextTapRequest(["text": "synthetic", "hold": hold]) }
        }
    }

    @Test func malformedNudgeRejectsInsteadOfBecomingSuccessfulNoOp() {
        for value: Any in [true, "1", NSNull(), Double.nan, Double.infinity, 0.5, -33, 33] {
            for key in ["dx", "dy"] {
                var body: [String: Any] = ["dx": 0, "dy": 0]
                body[key] = value
                reject { try ControlAPI.validateLeaf(path: "/nudge", body: body, screenSize: nil) }
            }
        }
        for value: Any in [0, 1, "true", NSNull()] {
            reject { try ControlAPI.validateLeaf(path: "/nudge", body: ["click": value], screenSize: nil) }
        }
    }

    @Test func coordinatesRejectBooleanNonfiniteAndPixelOrFractionOverflow() throws {
        for value: Any in [true, "1", NSNull(), Double.nan, Double.infinity, -1] {
            for path in ["/tap", "/move"] {
                reject { try ControlAPI.validateLeaf(path: path, body: ["x": value, "y": 0], screenSize: size) }
            }
            reject { _ = try MCPToolRequest.action(named: "act",
                arguments: ["steps": [["type": "tap", "frame_id": frame, "x": value, "y": 0]]], longEdge: 1000) }
        }
        for body: [String: Any] in [
            ["x": 100, "y": 0], ["x": 0, "y": 200], ["x": 0, "y": 0, "width": 0],
            ["x": 1.01, "y": 0, "fraction": true], ["x": 0, "y": 0, "fraction": 1],
        ] { reject { try ControlAPI.validateLeaf(path: "/tap", body: body, screenSize: size) } }
        try ControlAPI.validateLeaf(path: "/tap", body: ["x": 0, "y": 1, "fraction": true], screenSize: nil)
        let p = try RequestCoordinates.point(["x": 337.5, "y": 600, "maxEdge": 1200.9], "x", "y", screenSize: CGSize(width: 750, height: 1334), screenName: "synthetic")
        #expect(p.0 == 0.5 && p.1 == 0.5)
    }

    @Test func normalizedHTTPDiagnosticsRemainAvailableWhileMCPRequiresFramePixels() throws {
        let body: [String: Any] = ["x": 0.25, "y": 1, "fraction": true]
        try ControlAPI.validateLeaf(path: "/tap", body: body, screenSize: nil)
        let point = try CoordinateRequest(body).point(screenSize: nil)
        #expect(point.0 == 0.25 && point.1 == 1)
        for unsupported in ["normalized", "fraction"] {
            reject { _ = try MCPToolRequest.action(named: "act",
                arguments: ["steps": [["type": "tap", "frame_id": frame, "x": 250, "y": 800, unsupported: true]]],
                longEdge: 1000) }
        }
    }

    @Test func actGeometryPreflightRejectsLateBadTapAndSwipeBeforeAnyStep() {
        let badSteps: [[String: Any]] = [
            ["type": "tap", "x": 100, "y": 20],
            ["type": "swipe", "points": [["x": 10, "y": 20], ["x": 100, "y": 20]]],
            ["type": "tap", "x": 10, "y": 20, "hold": true],
            ["type": "key", "key": "a", "modifiers": "command"],
        ]
        for bad in badSteps {
            var executed = 0
            reject {
                let batch = try ActRequest(["steps": [["type": "home"], bad]], screenSize: size, requireGeometry: true)
                _ = try batch.perform(device: "synthetic", capture: { _, _ in throw InputRequestError("unexpected capture") }, execute: { _, _, _ in
                    executed += 1
                    return .json(["ok": true])
                })
            }
            #expect(executed == 0)
        }
        reject { _ = try ActRequest(["steps": [["type": "tap", "x": 0, "y": 0]]], requireGeometry: true) }
    }

    @Test func actPerPointMetadataCannotBypassWholePathGeometryPreflight() {
        // SwipeRequest deliberately ignores point-level dimensions/fraction.
        // The Act preflight must apply that same interpretation before step 1.
        let badSwipe: [String: Any] = [
            "type": "swipe", "width": 100, "height": 200,
            "points": [["x": 10, "y": 20], ["x": 150, "y": 20, "width": 200]],
        ]
        var executed: [String] = []
        do {
            let batch = try ActRequest(["steps": [["type": "home"], badSwipe]], screenSize: size, requireGeometry: true)
            _ = try batch.perform(device: "synthetic", capture: { _, _ in throw InputRequestError("unexpected capture") }, execute: { path, body, _ in
                executed.append(path)
                try ControlAPI.validateLeaf(path: path, body: body, screenSize: size)
                return .json(["ok": true])
            })
        } catch { }
        #expect(executed.isEmpty, "A bad later point must not allow the preceding home action")
    }

    @Test func keyboardReadinessFailureEmitsNoReportsIncludingWindowEntryPoints() {
        let harness = Reports()
        harness.ready.remove(.keyboard)
        #expect(!harness.input.isKeyboardReady)
        reject { try harness.input.key("v", modifiers: ["command"]) }
        reject { try harness.input.type("abc") }
        #expect(!harness.input.keyFromKeyboard("return"))
        #expect(!harness.input.typeFromKeyboard("abc"))
        #expect(harness.rows.isEmpty)
    }

    @Test func consumerReadinessFailureEmitsNoReports() {
        let harness = Reports()
        harness.ready.remove(.consumer)
        #expect(!harness.input.isConsumerReady)
        #expect(!harness.input.consumer(0x0223))
        #expect(!harness.input.consumer(0x0030))
        #expect(harness.rows.isEmpty)
    }

    @Test func relativeReadinessFailureEmitsNoReportsAtDirectDeviceInput() {
        let harness = Reports()
        harness.ready.remove(.relativeMouse)
        #expect(!harness.input.isRelativePointerReady)
        reject { try harness.input.nudge(dx: 1, dy: 0, click: false) }
        reject { try harness.input.nudge(dx: 0, dy: 0, click: true) }
        #expect(harness.rows.isEmpty)
    }

    @Test func associationDeniedRejectsAllThreeChannelsBeforeGeneration() {
        let harness = Reports()
        harness.allowed = false
        reject { try harness.input.key("a", modifiers: []) }
        reject { try harness.input.type("abc") }
        reject { try harness.input.nudge(dx: 1, dy: 0, click: true) }
        #expect(!harness.input.consumer(0x0223))
        #expect(harness.rows.isEmpty)
    }

    @Test func validKeyboardOnlyChordKeepsExactBytesWithoutRequiringPointer() throws {
        let harness = Reports()
        harness.ready = [.keyboard]
        #expect(harness.input.isKeyboardReady)
        #expect(!harness.input.isPointerReady)
        try harness.input.key("v", modifiers: ["command"])
        #expect(harness.rows.allSatisfy { $0.0 == .keyboard })
        #expect(harness.rows.map { $0.1 } == [
            [0x08, 0, 0, 0, 0, 0, 0, 0], [0x08, 0, 0x19, 0, 0, 0, 0, 0],
            [0x08, 0, 0, 0, 0, 0, 0, 0], [0, 0, 0, 0, 0, 0, 0, 0],
        ])
    }

    @Test func validConsumerAndRelativeBytesRemainUnchanged() throws {
        let consumer = Reports()
        consumer.ready = [.consumer]
        #expect(consumer.input.consumer(0x0223))
        #expect(consumer.rows.map { $0.1 } == [HIDReportPayload.consumer(0x0223), HIDReportPayload.consumer(0)])
        let relative = Reports()
        relative.ready = [.relativeMouse]
        try relative.input.nudge(dx: -32, dy: 32, click: true)
        #expect(relative.rows.map { $0.1 } == [
            HIDReportPayload.relativeMouse(buttons: 0, dx: -32, dy: 32),
            HIDReportPayload.relativeMouse(buttons: 1), HIDReportPayload.relativeMouse(buttons: 0),
        ])
    }

    @Test func readinessIsNotAClaimOfSubsequentDelivery() throws {
        let harness = Reports()
        var accepted: [[UInt8]] = []
        var offered = 0
        let input = DeviceInput(
            host: UUID(), session: UUID(), heldDragProfile: .notConfigured,
            sleep: { _ in }, reportSender: { _, bytes in
                offered += 1
                if offered == 1 { harness.ready.remove(.keyboard) }
                if harness.ready.contains(.keyboard) { accepted.append(bytes) }
            }, reportReadiness: { report, _, _ in harness.ready.contains(report) })
        try input.key("v", modifiers: ["command"])
        #expect(offered == 4)
        #expect(accepted.isEmpty)
    }
}
