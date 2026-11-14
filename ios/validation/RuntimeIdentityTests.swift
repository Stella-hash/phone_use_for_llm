import Foundation
import Testing

@testable import iPhoneUse

/// Offline checks: the production reader inspects only this test process's
/// loaded image; host responses are synthetic and no phone service is called.
@Suite struct RuntimeIdentityTests {
    private let first = "12345678-1234-1234-1234-123456789abc"
    private let second = "87654321-4321-4321-4321-cba987654321"

    private func command(_ value: String) -> Data {
        var uuid = UUID(uuidString: value)!.uuid
        var bytes = Data([0x1b, 0, 0, 0, 24, 0, 0, 0])
        withUnsafeBytes(of: &uuid) { bytes.append(contentsOf: $0) }
        return bytes
    }

    private func status(_ uuid: Any, pid: Any = 202) throws -> Data {
        try JSONSerialization.data(withJSONObject: [
            "runtime_identity": ["image_uuid": uuid, "pid": pid], "private": "DO_NOT_COPY_HOST_STATUS",
        ])
    }

    @Test func parsesUUIDAmongOtherCommandsAndRejectsMalformedTail() {
        let other = Data([0xfe, 0xff, 0xff, 0x7f, 8, 0, 0, 0])
        #expect(RuntimeIdentity.imageUUID(loadCommands: other + command(first), commandCount: 2) == first)
        #expect(RuntimeIdentity.imageUUID(loadCommands: command(first) + other, commandCount: 2) == first)
        #expect(RuntimeIdentity.imageUUID(loadCommands: command(first) + Data([1, 2, 3]), commandCount: 1) == nil)
        #expect(RuntimeIdentity.imageUUID(loadCommands: command(first) + Data(repeating: 0, count: 8), commandCount: 2) == nil)
    }

    @Test func rejectsTruncatedDuplicateZeroAndInvalidCommandTables() {
        let valid = command(first)
        let bad: [(Data, Int)] = [
            (Data(), 1), (valid, -1), (valid, Int.max), (valid.dropLast(), 1),
            (Data([0x1b, 0, 0, 0, 0xff, 0xff, 0xff, 0xff]), 1),
            (Data([0x1b, 0, 0, 0, 7, 0, 0, 0]), 1),
            (valid + valid, 2), (command("00000000-0000-0000-0000-000000000000"), 1),
        ]
        for (data, count) in bad {
            #expect(RuntimeIdentity.imageUUID(loadCommands: data, commandCount: count) == nil)
        }
    }

    @Test func actualLoadedMainImageHasStableUUIDAndCurrentPID() throws {
        let actual = RuntimeIdentity.current
        let uuid = try #require(actual.imageUUID)
        #expect(UUID(uuidString: uuid) != nil)
        #expect(actual.pid == Int(ProcessInfo.processInfo.processIdentifier))
        #expect(RuntimeIdentity.loadedMainImageUUID() == uuid)
        #expect(RuntimeIdentity.current == actual)
    }

    @Test func everyContextReadsPassiveHostAgainAndComparesUUIDNotPID() throws {
        let client = RuntimeIdentity.Image(imageUUID: first, pid: 101)
        var calls: [(String, TimeInterval)] = []
        var next = first.uppercased()
        func read(_ path: String, _ timeout: TimeInterval) throws -> Data {
            calls.append((path, timeout))
            return try status(next)
        }
        let match = RuntimeIdentity.context(client: client, readHost: read)
        #expect(match["comparison"] as? String == "match")
        #expect((match["host"] as? [String: Any])?["pid"] as? Int == 202)
        next = second
        let mismatch = RuntimeIdentity.context(client: client, readHost: read)
        #expect(mismatch["comparison"] as? String == "mismatch")
        #expect(calls.count == 2)
        #expect(calls.allSatisfy { $0.0 == "/status?wake=0" && $0.1 == 0.5 })
        let json = String(decoding: try JSONSerialization.data(withJSONObject: match), as: UTF8.self)
        #expect(!json.contains("DO_NOT_COPY_HOST_STATUS"))
    }

    @Test func legacyMalformedAndUnavailableIdentitiesStayUnknown() throws {
        let client = RuntimeIdentity.Image(imageUUID: first, pid: 101)
        var responses = [Data("{}".utf8), Data("not json".utf8), Data("[]".utf8)]
        for invalid: Any in [true, 0, -1, 1.5, "202", Double(Int32.max) + 1] {
            responses.append(try status(first, pid: invalid))
        }
        for invalid: Any in [true, "not-a-uuid", "00000000-0000-0000-0000-000000000000"] {
            responses.append(try status(invalid))
        }
        for response in responses {
            let result = RuntimeIdentity.context(client: client) { _, _ in response }
            #expect(result["comparison"] as? String == "unknown")
            #expect(result["host_reason"] is String)
        }
        let noHostUUID = RuntimeIdentity.context(client: client) { _, _ in try status(NSNull()) }
        #expect(noHostUUID["host_reason"] as? String == "host_image_uuid_unavailable")
        #expect((noHostUUID["host"] as? [String: Any])?["pid"] as? Int == 202)
        let noClientUUID = RuntimeIdentity.context(client: .init(imageUUID: nil, pid: 101)) { _, _ in try status(first) }
        #expect(noClientUUID["comparison"] as? String == "unknown")
        #expect(noClientUUID["client_reason"] as? String == "client_image_uuid_unavailable")
    }

    @Test func failedStatusReadIsNotRetriedAndDoesNotThrow() {
        var calls = 0
        let result = RuntimeIdentity.context(client: .init(imageUUID: first, pid: 101)) { _, _ in
            calls += 1
            throw URLError(.timedOut, userInfo: [NSLocalizedDescriptionKey: "DO_NOT_COPY_ERRORS"])
        }
        #expect(calls == 1)
        #expect(result["comparison"] as? String == "unknown")
        #expect(result["host_reason"] as? String == "host_status_unavailable")
        #expect(!String(describing: result).contains("DO_NOT_COPY_ERRORS"))
    }
}
