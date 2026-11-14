import Foundation
import Testing
@testable import iPhoneUse

struct HTTPBoundaryTests {
    private func wire(_ method: String = "GET", _ path: String = "/viewer",
                      headers: [String] = ["Host: 127.0.0.1:7390"], body: String? = nil) -> Data {
        let length = body.map { ["Content-Length: \($0.utf8.count)"] } ?? []
        return Data((["\(method) \(path) HTTP/1.1"] + headers + length).joined(separator: "\r\n").utf8)
            + Data("\r\n\r\n\(body ?? "")".utf8)
    }

    private func response(_ data: Data, expected: Int, calls: Int) throws {
        let request = try #require(HTTPRequest.parse(data))
        var dispatched = 0
        let result = HTTPServer.response(to: request, listeningPort: 7390) { _ in
            dispatched += 1
            return .json(["synthetic": true])
        }
        #expect(result.status == expected)
        #expect(dispatched == calls)
        #expect(result.headers["Cross-Origin-Resource-Policy"] == "same-origin")
        #expect(result.headers["X-Content-Type-Options"] == "nosniff")
        if calls == 0 {
            let body = try #require(try JSONSerialization.jsonObject(with: result.body) as? [String: Any])
            #expect(body["input_sent"] as? Bool == false)
        }
    }

    @Test func nativeJSONAndSameOriginViewerReachTheHandler() throws {
        try response(wire(), expected: 200, calls: 1)
        try response(wire("GET", "/screenshot", headers: ["Host: 127.0.0.1:7390",
            "Origin: http://127.0.0.1:7390", "Sec-Fetch-Site: same-origin"]), expected: 200, calls: 1)
        try response(wire("GET", "/viewer", headers: ["Host: localhost:7390",
            "Origin: http://localhost:7390", "Sec-Fetch-Site: none"]), expected: 200, calls: 1)
        try response(wire("POST", "/home", headers: ["Host: 127.0.0.1:7390",
            "Content-Type: application/json; charset=utf-8"], body: "{}"), expected: 200, calls: 1)
    }

    @Test func crossOriginSimpleJSONNeverDispatchesInput() throws {
        for origin in ["https://example.invalid", "null", "http://localhost:7390",
                       "http://127.0.0.1:7391", "http://127.0.0.1:7390/path"] {
            try response(wire("POST", "/type", headers: ["Host: 127.0.0.1:7390",
                "Origin: \(origin)", "Content-Type: text/plain"], body: #"{"text":"synthetic"}"#),
                expected: 403, calls: 0)
        }
    }

    @Test func nonJSONInputAndCrossSiteMetadataNeverReachTheHandler() throws {
        for contentType in ["text/plain", "application/x-www-form-urlencoded", "multipart/form-data"] {
            try response(wire("POST", "/home", headers: ["Host: 127.0.0.1:7390",
                "Content-Type: \(contentType)"], body: "{}"), expected: 415, calls: 0)
        }
        try response(wire("POST", "/home", body: "{}"), expected: 415, calls: 0)
        for site in ["cross-site", "same-site", "unexpected"] {
            try response(wire("GET", "/screenshot", headers: ["Host: 127.0.0.1:7390",
                "Sec-Fetch-Site: \(site)"]), expected: 403, calls: 0)
        }
    }

    @Test func hostMustBeLiteralLoopbackWithTheActualListeningPort() throws {
        for host in ["example.invalid:7390", "127.0.0.1:7391", "127.0.0.1", "127.1:7390",
                     "[::1]:7390", "localhost:7390.example.invalid", "127.0.0.1:7390, example.invalid"] {
            try response(wire(headers: ["Host: \(host)"]), expected: 403, calls: 0)
        }
        try response(wire(headers: []), expected: 403, calls: 0)
        let request = try #require(HTTPRequest.parse(wire(headers: ["Host: localhost:7400"])))
        #expect(request.rejection(listeningPort: 7400) == nil)
        #expect(request.rejection(listeningPort: 7390)?.status == 403)
    }

    @Test func duplicateSingletonHeadersAndMalformedLinesAreExplicitFailures() {
        for name in ["Host", "Origin", "Content-Length", "Content-Type", "Sec-Fetch-Site", "Sec-Fetch-Mode", "Sec-Fetch-Dest"] {
            let data = wire(headers: ["\(name): value", "\(name.lowercased()): value"])
            guard case .invalid = HTTPRequest.decode(data) else {
                Issue.record("Duplicate \(name) was not rejected"); continue
            }
        }
        for header in ["Host : 127.0.0.1:7390", " Host: 127.0.0.1:7390", "MissingColon",
                       "Origin: null\u{0}", "Transfer-Encoding: chunked"] {
            guard case .invalid = HTTPRequest.decode(wire(headers: [header])) else {
                Issue.record("Malformed header was not rejected"); continue
            }
        }
    }

    @Test func badLengthsAndNonObjectBodiesNeverBecomeEmptyInput() {
        for length in ["-1", "+2", "1.5", "bad", "9999999999999999999999999", "8388609"] {
            let data = wire("POST", "/home", headers: ["Content-Length: \(length)"])
            guard case .invalid = HTTPRequest.decode(data) else {
                Issue.record("Invalid Content-Length was not rejected"); continue
            }
        }
        for body in ["", "broken", "null", "[]", "42"] {
            guard case .invalid = HTTPRequest.decode(wire("POST", "/home", body: body)) else {
                Issue.record("Invalid JSON body was not rejected"); continue
            }
        }
    }

    @Test func fragmentedUTF8AndValidDuplicateQueryBehaviorRemainSupported() throws {
        let data = wire("POST", "/type?device=first&device=last&flag",
                        headers: ["hOsT: 127.0.0.1:7390", "Content-Type: application/json"], body: #"{"text":"你好"}"#)
        guard case .incomplete = HTTPRequest.decode(Data(data.dropLast())) else {
            Issue.record("Fragmented body was not retained"); return
        }
        let request = try #require(HTTPRequest.parse(data))
        #expect(request.body["text"] as? String == "你好")
        #expect(request.query == ["device": "last", "flag": ""])
        #expect(request.rejection(listeningPort: 7390) == nil)
        #expect(HTTPRequest.parse(data + Data("ignored next request".utf8)) != nil)
    }

    @Test func malformedTargetsAndOversizedHeadersFailBeforeDispatch() {
        for target in ["http://example.invalid/type", "//example.invalid/type", "/type#fragment"] {
            guard case .invalid = HTTPRequest.decode(wire("POST", target, body: "{}")) else {
                Issue.record("Non-origin-form target was not rejected"); continue
            }
        }
        let data = Data(repeating: 65, count: HTTPRequest.maximumHeaderBytes + 1)
        guard case .invalid = HTTPRequest.decode(data) else { Issue.record("Oversized header was not rejected"); return }
    }
}
