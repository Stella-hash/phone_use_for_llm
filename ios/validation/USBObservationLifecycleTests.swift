import Darwin
import Foundation
import ImageIO
import Testing
@testable import iPhoneUse

@Suite(.serialized) struct USBObservationLifecycleTests {
    private final class Harness {
        let device = "33333333-3333333333333333"
        let captureEntered = DispatchSemaphore(value: 0)
        let captureReturned = DispatchSemaphore(value: 0)
        let releaseCapture = DispatchSemaphore(value: 0)
        let inputEntered = DispatchSemaphore(value: 0)
        let releaseInput = DispatchSemaphore(value: 0)
        let eventsLock = NSLock()
        var events: [String] = []
        var blockCapture = true, failCapture = false, blockInput = false
        func record(_ event: String) { eventsLock.withLock { events.append(event) } }
        var recorded: [String] { eventsLock.withLock { events } }
        var dependencies: USBControlAPI.Dependencies {
            var d = USBControlAPI.Dependencies()
            d.environment = ["IPHONE_USE_DEVICE_ID": device, "IPHONE_USE_USB_DEVICE_ID": device,
                "IPHONE_USE_USB_CLIPBOARD_PYTHON": "/usr/bin/python3",
                USBScreenCapture.helperKey: "/private/synthetic/screenshot.py"]
            d.pin = { .init(registryEntryID: 53, serial: self.device) }
            d.capture = { _ in
                defer { self.captureReturned.signal() }
                self.record("capture-open")
                self.captureEntered.signal()
                if self.blockCapture {
                    guard self.releaseCapture.wait(timeout: .now() + 8) == .success else {
                        throw DeviceError("fixture capture was not released")
                    }
                }
                // The production capture returns only after child/tunnel cleanup.
                self.record("capture-closed")
                if self.failCapture { throw DeviceError("synthetic capture cleanup failed") }
                let context = CGContext(data: nil, width: 2, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
                let data = NSMutableData()
                let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, context.makeImage()!, nil)
                guard CGImageDestinationFinalize(destination) else { throw DeviceError("fixture PNG failed") }
                return data as Data
            }
            d.keyboard = { _, _, _, before, clipboard in
                self.record("input-open")
                self.inputEntered.signal()
                if self.blockInput {
                    guard self.releaseInput.wait(timeout: .now() + 8) == .success else {
                        throw DeviceError("fixture input was not released")
                    }
                }
                try before(); try clipboard?(); try before()
                self.record("input-closed")
                return ["input_status": "sent_unverified", "hid_input_status": "sent_unverified",
                    "clipboard_status": "not_requested"]
            }
            return d
        }
        func handle(_ request: HTTPRequest) -> HTTPResponse {
            USBControlAPI.handle(request, dependencies: dependencies)
        }
    }

    private func unusedLoopbackPort() throws -> UInt16 {
        let fd = Darwin.socket(AF_INET, SOCK_STREAM, 0)
        try #require(fd >= 0)
        defer { Darwin.close(fd) }
        var address = sockaddr_in()
        address.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        address.sin_family = sa_family_t(AF_INET)
        address.sin_addr.s_addr = inet_addr("127.0.0.1")
        let bound = withUnsafePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) {
                Darwin.bind(fd, $0, socklen_t(MemoryLayout<sockaddr_in>.size))
            }
        }
        try #require(bound == 0)
        var length = socklen_t(MemoryLayout<sockaddr_in>.size)
        let read = withUnsafeMutablePointer(to: &address) { pointer in
            pointer.withMemoryRebound(to: sockaddr.self, capacity: 1) { getsockname(fd, $0, &length) }
        }
        try #require(read == 0)
        return UInt16(bigEndian: address.sin_port)
    }

    // Exercise the actual concurrent HTTP listener and the same timed client as
    // MCP. A canceled response must not hand device ownership to the next POST.
    @Test(arguments: ["baseline", "post-action", "burst", "capture-error"])
    func timedOutHTTPObservationCannotOverlapInput(_ mode: String) throws {
        let h = Harness()
        h.failCapture = mode == "capture-error"
        let port = try unusedLoopbackPort()
        let server = HTTPServer(port: port, handler: h.handle)
        try server.start()
        defer { h.releaseCapture.signal(); server.stop() }
        let client = MCPHTTPClient(base: URL(string: "http://127.0.0.1:\(port)")!, language: .en)
        let readyBy = ProcessInfo.processInfo.systemUptime + 3
        while (try? client.get("/status", timeout: 0.1)) == nil {
            try #require(ProcessInfo.processInfo.systemUptime < readyBy)
            Thread.sleep(forTimeInterval: 0.01)
        }
        let observed = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let path = "/screenshot?observationOnly=1" + (mode == "baseline" ? "&format=png&stability=1" : "&ocr=1")
            #expect(throws: (any Error).self) {
                _ = try client.get(path, timeout: mode == "baseline" ? 2 : 0.1)
            }
            observed.signal()
        }
        try #require(h.captureEntered.wait(timeout: .now() + 3) == .success)
        try #require(observed.wait(timeout: .now() + 3) == .success)
        #expect(h.recorded == ["capture-open"])
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            do { _ = try client.post("/home", [:]) }
            catch { Issue.record("Home request failed: \(error)") }
            finished.signal()
        }
        #expect(h.inputEntered.wait(timeout: .now() + 0.15) == .timedOut)
        h.releaseCapture.signal()
        try #require(h.captureReturned.wait(timeout: .now() + 3) == .success)
        try #require(finished.wait(timeout: .now() + 3) == .success)
        #expect(h.recorded == ["capture-open", "capture-closed", "input-open", "input-closed"])
    }

    @Test func screenshotWaitsUntilInputCleanupFinishes() throws {
        let h = Harness(); h.blockInput = true; h.blockCapture = false
        let inputFinished = DispatchSemaphore(value: 0), captureFinished = DispatchSemaphore(value: 0)
        defer { h.releaseInput.signal() }
        DispatchQueue.global().async {
            #expect(h.handle(HTTPRequest(method: "POST", path: "/home", query: [:], body: [:])).status == 200)
            inputFinished.signal()
        }
        try #require(h.inputEntered.wait(timeout: .now() + 3) == .success)
        DispatchQueue.global().async {
            #expect(h.handle(HTTPRequest(method: "GET", path: "/screenshot",
                query: ["observationOnly": "1"], body: [:])).status == 200)
            captureFinished.signal()
        }
        #expect(h.captureEntered.wait(timeout: .now() + 0.15) == .timedOut)
        h.releaseInput.signal()
        try #require(inputFinished.wait(timeout: .now() + 3) == .success)
        try #require(captureFinished.wait(timeout: .now() + 3) == .success)
        #expect(h.recorded == ["input-open", "input-closed", "capture-open", "capture-closed"])
    }

    @Test func batchAndTextPreflightReenterTheSameDeviceLock() throws {
        let h = Harness(); h.blockCapture = false
        let finished = DispatchSemaphore(value: 0)
        DispatchQueue.global().async {
            let body: [String: Any] = ["steps": [
                ["type": "type", "text": "a", "ensure_chinese_ime": true, "use_clipboard": false],
                ["type": "home"],
            ]]
            #expect(h.handle(HTTPRequest(method: "POST", path: "/act", query: [:], body: body)).status == 200)
            finished.signal()
        }
        try #require(finished.wait(timeout: .now() + 3) == .success)
        #expect(h.recorded == ["capture-open", "capture-closed", "input-open", "input-closed",
            "input-open", "input-closed"])
    }
}
