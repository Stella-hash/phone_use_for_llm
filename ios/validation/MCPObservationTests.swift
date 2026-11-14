import Foundation
import Testing

@testable import iPhoneUse

/// Focused CLT counterparts for the native MCP/OCR regression tests; no device or listener.
@Suite struct MCPObservationTests {
    private func sample(
        _ texts: [String], hash: String, sequence: UInt64 = 1, at: TimeInterval = 10
    ) -> MCPServer.ObservationFrame {
        MCPServer.ObservationFrame(
            image: Data(hash.utf8), device: "phone-1", width: "500", height: "1000", mimeType: "image/png",
            identity: .init(source: "capture-1", sequence: sequence, receivedAt: at), signature: hash,
            ocr: .init(width: 500, height: 1000,
                items: texts.map { .init(text: $0, x: 20, y: 30) }, screenHash: hash))
    }

    @Test func ocrDiffUsesSameCallBaselineInsteadOfPreviousToolObservation() throws {
        let history = sample(["prior-client-history"], hash: "history")
        let baseline = sample(["before-input", "kept"], hash: "before")
        let current = sample(["after-input", "kept"], hash: "after")
        _ = MCPServer.screenshotContent(history, includeImage: false, diff: false)
        let observation = MCPServer.ObservationResult(status: .changed, frame: current, baselineFrame: baseline.identity)
        for _ in 0..<2 {
            let result = MCPServer.observationContent(observation, includeImage: true, diff: true, baseline: baseline)
            let metadata = try #require(result["structuredContent"] as? [String: Any])
            let comparison = try #require(metadata["ocr_diff"] as? [String: Any])
            #expect(comparison["status"] as? String == "compared")
            #expect(comparison["comparison_reference"] as? String == "this_call_pre_input_capture")
            #expect(comparison["baseline_screen_hash"] as? String == "before")
            #expect(comparison["current_screen_hash"] as? String == "after")
            #expect(comparison["added"] as? [String] == ["after-input"])
            #expect(comparison["removed"] as? [String] == ["before-input"])
            #expect(comparison["unchanged"] as? Bool == false)
            let blocks = try #require(result["content"] as? [[String: Any]])
            let text = try #require(blocks.first?["text"] as? String)
            #expect(text.contains("+after-input") && text.contains("-before-input"))
            #expect(!text.contains("prior-client-history"))
            #expect(!blocks.contains { $0["type"] as? String == "image" })
            #expect(metadata["frame"] == nil)
        }
    }

    @Test func unavailableBaselineNeverBecomesAnEmptyScreenOrClientHistory() throws {
        let current = sample(["current"], hash: "current")
        _ = MCPServer.screenshotContent(sample(["history"], hash: "history"), includeImage: false, diff: false)
        for baseline in [nil, sample([], hash: "")] as [MCPServer.ObservationFrame?] {
            let result = MCPServer.ocrDifferenceContent(current, baseline: baseline)
            let metadata = try #require(result["structuredContent"] as? [String: Any])
            let comparison = try #require(metadata["ocr_diff"] as? [String: Any])
            #expect(comparison["status"] as? String == "baseline_unavailable")
            #expect(comparison["baseline_available"] as? Bool == false)
            #expect(comparison["current_available"] as? Bool == true)
            #expect(comparison["unchanged"] is NSNull)
            #expect(comparison["added"] == nil && comparison["removed"] == nil)
            let text = try #require((result["content"] as? [[String: Any]])?.first?["text"] as? String)
            #expect(text.contains("baseline_unavailable") && !text.contains("+current"))
        }
        let validEmpty = sample([], hash: "recognized-empty")
        let result = MCPServer.ocrDifferenceContent(current, baseline: validEmpty)
        let comparison = try #require((result["structuredContent"] as? [String: Any])?["ocr_diff"] as? [String: Any])
        #expect(comparison["status"] as? String == "compared")
        #expect(comparison["added"] as? [String] == ["current"])
    }

    @Test func missingPostInputOCRRemainsExplicitInActionMetadata() throws {
        for frame in [nil, sample([], hash: "")] as [MCPServer.ObservationFrame?] {
            let observation = MCPServer.ObservationResult(status: .unobserved, frame: frame)
            let result = MCPServer.observationContent(observation, includeImage: false, diff: true,
                baseline: sample(["before"], hash: "before"))
            let metadata = try #require(result["structuredContent"] as? [String: Any])
            let comparison = try #require(metadata["ocr_diff"] as? [String: Any])
            #expect(comparison["status"] as? String == "current_unavailable")
            #expect(comparison["baseline_available"] as? Bool == true)
            #expect(comparison["current_available"] as? Bool == false)
            #expect(comparison["unchanged"] is NSNull)
            #expect(comparison["removed"] == nil)
        }
    }

    @Test func defaultObservationBudgetAllowsTwoUSBLatencyCapturesAndExplicitBudgetsRemainBounded() throws {
        for raw: Any in [true, "1", 0, 0.1, 5.01, Double.nan, Double.infinity, -Double.infinity] {
            #expect(throws: MCPServer.MCPError.self) { try MCPServer.observationTimeout(raw) }
        }
        let budget = try MCPServer.observationTimeout(nil)
        #expect(budget == 3.0)
        #expect(try MCPServer.observationTimeout(0.2) == 0.2)
        #expect(try MCPServer.observationTimeout(5) == 5)
        var clock: TimeInterval = 10
        var sequence: UInt64 = 1
        let result = MCPServer.observeAfterAction(
            baseline: sample(["before"], hash: "before", at: 9.9), acknowledgedAt: 10, timeout: budget,
            sleep: { clock += $0 }, now: { clock }, frame: { remaining in
                guard remaining >= 0.85 else { clock += remaining; return nil }
                clock += 0.85
                sequence += 1
                return sample(["after"], hash: "after", sequence: sequence, at: clock)
            })
        #expect(result.status == .changed)
        #expect(result.fresh && result.stable && result.changed == true)
        #expect(result.elapsed > 1.5 && result.elapsed < budget)
        #expect(sequence == 3)
    }
}
