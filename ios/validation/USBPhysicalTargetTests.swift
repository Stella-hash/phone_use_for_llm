import Foundation
import ImageIO
import Testing
@testable import iPhoneUse

@Suite(.serialized) struct USBPhysicalTargetTests {
    private let a = "11111111-1111111111111111"
    private let b = "22222222-2222222222222222"

    private final class Harness {
        var captures = 0, keyboardOpens = 0, touchOpens = 0, commits = 0, clipboardWrites = 0
        var attachment: UInt64 = 42
        var changeDuringCapture = false, changeBeforeCommit = false
        let target: String
        let references = ScreenshotReferences(capacity: 128)
        init(_ target: String) { self.target = target }
        var dependencies: USBControlAPI.Dependencies {
            var d = USBControlAPI.Dependencies()
            d.environment = ["IPHONE_USE_DEVICE_ID": target, "IPHONE_USE_USB_DEVICE_ID": target,
                "IPHONE_USE_USB_CLIPBOARD_PYTHON": "/usr/bin/python3",
                USBScreenCapture.helperKey: "/private/synthetic/screenshot.py"]
            d.pin = { .init(registryEntryID: self.attachment, serial: self.target) }
            d.references = references
            d.capture = { _ in
                self.captures += 1
                if self.changeDuringCapture { self.attachment += 1 }
                let context = CGContext(data: nil, width: 2, height: 4, bitsPerComponent: 8, bytesPerRow: 0,
                    space: CGColorSpaceCreateDeviceRGB(), bitmapInfo: CGImageAlphaInfo.noneSkipLast.rawValue)!
                let data = NSMutableData()
                let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
                CGImageDestinationAddImage(destination, context.makeImage()!, nil)
                #expect(CGImageDestinationFinalize(destination))
                return data as Data
            }
            d.touch = { _, reference, env, before in
                self.touchOpens += 1
                #expect(reference.device == self.target)
                #expect(env["IPHONE_USE_USB_DEVICE_ID"] == self.target)
                if self.changeBeforeCommit { self.attachment += 1 }
                try before(DeviceDisplayMapping(rotationDegrees: 0, nativeWidth: 2, nativeHeight: 4))
                self.commits += 1
                return ["input_status": "sent_unverified"]
            }
            d.keyboard = { _, _, _, before, clipboard in
                self.keyboardOpens += 1
                if self.changeBeforeCommit { self.attachment += 1 }
                try before()
                try clipboard?()
                try before()
                self.commits += 1
                return ["input_status": "sent_unverified", "hid_input_status": "sent_unverified",
                    "clipboard_status": clipboard == nil ? "not_requested" : "written_unverified"]
            }
            d.clipboard = { _, _, before in try before(); self.clipboardWrites += 1 }
            return d
        }
        func call(_ path: String, body: [String: Any] = [:], query: [String: String] = [:],
            dependencies: USBControlAPI.Dependencies? = nil) -> HTTPResponse {
            USBControlAPI.handle(HTTPRequest(method: body.isEmpty && ["/screenshot", "/devices", "/status"].contains(path)
                ? "GET" : "POST", path: path, query: query, body: body), dependencies: dependencies ?? self.dependencies)
        }
    }

    @Test func captureAAndTargetBFailBeforeAnyHelperOrClipboard() throws {
        let h = Harness(b)
        var d = h.dependencies
        d.environment["IPHONE_USE_DEVICE_ID"] = a
        let actions: [(String, [String: Any])] = [
            ("/home", [:]), ("/key", ["key": "a"]), ("/type", ["text": "synthetic", "use_clipboard": true]),
            ("/tap", ["frame_id": UUID().uuidString, "x": 0, "y": 0]),
            ("/act", ["steps": [["type": "home"], ["type": "type", "text": "synthetic"]]]),
            ("/screenshot", [:]),
        ]
        for (path, body) in actions {
            let response = h.call(path, body: body, dependencies: d)
            #expect(response.status == 409)
            let json = try #require(JSONSerialization.jsonObject(with: response.body) as? [String: Any])
            #expect(json["input_sent"] as? Bool == false)
        }
        #expect(h.captures == 0 && h.keyboardOpens == 0 && h.touchOpens == 0)
        #expect(h.commits == 0 && h.clipboardWrites == 0)
    }

    @Test func soleWrongPhoneOrMissingPhysicalCaptureNeverAuthorizesInput() {
        let h = Harness(a)
        var d = h.dependencies
        d.pin = { .init(registryEntryID: 42, serial: self.b) }
        #expect(h.call("/home", dependencies: d).status == 409)
        d = h.dependencies
        d.environment.removeValue(forKey: USBScreenCapture.helperKey)
        #expect(h.call("/home", dependencies: d).status == 409)
        d = h.dependencies
        d.pin = { nil }
        #expect(h.call("/home", dependencies: d).status == 409)
        #expect(h.keyboardOpens == 0 && h.commits == 0)
    }

    @Test func onlySamePhysicalScreenshotCanCommitOneTouch() throws {
        let h = Harness(a)
        let image = h.call("/screenshot")
        #expect(image.status == 200 && image.headers["X-Device"] == a)
        #expect(image.headers["X-Frame-Source"] == "coredevice-usb:42")
        #expect(image.headers["Cache-Control"] == "no-store")
        let token = try #require(image.headers["X-Frame-ID"])
        let body: [String: Any] = ["frame_id": token, "x": 0, "y": 0]
        #expect(h.call("/tap", body: body).status == 200)
        #expect(h.call("/tap", body: body).status == 409)
        #expect(h.touchOpens == 1 && h.commits == 1)
    }

    @Test func wrongDeviceAndLegacyAVTokensCannotReachTouchHelper() {
        let h = Harness(b)
        for (device, source) in [(a, "coredevice-usb:42"), (b, "opaque-av-capture-session")] {
            let token = h.references.issue(device: device, source: source,
                screenSize: CGSize(width: 2, height: 4), imageSize: (2, 4))
            #expect(h.call("/tap", body: ["frame_id": token.id, "x": 0, "y": 0]).status == 409)
        }
        #expect(h.touchOpens == 0 && h.commits == 0)
    }

    @Test func detachDuringCaptureOrPreflightCannotMintOrCommit() throws {
        let h = Harness(a)
        h.changeDuringCapture = true
        let rejected = h.call("/screenshot")
        #expect(rejected.status == 409 && rejected.headers["X-Frame-ID"] == nil)
        h.changeDuringCapture = false
        let image = h.call("/screenshot")
        let token = try #require(image.headers["X-Frame-ID"])
        h.changeBeforeCommit = true
        #expect(h.call("/tap", body: ["frame_id": token, "x": 0, "y": 0]).status == 409)
        #expect(h.call("/type", body: ["text": "synthetic", "use_clipboard": true]).status == 409)
        #expect(h.commits == 0 && h.clipboardWrites == 0)
    }

    @Test func internalCaptureDoesNotEvictFullReferenceStore() throws {
        let h = Harness(a)
        var first: String?
        for _ in 0..<128 {
            let token = h.references.issue(device: a, source: "coredevice-usb:42",
                screenSize: CGSize(width: 2, height: 4), imageSize: (2, 4)).id
            if first == nil { first = token }
        }
        #expect(h.call("/screenshot", query: ["observationOnly": "1"]).headers["X-Frame-ID"] == nil)
        #expect(h.call("/tap", body: ["frame_id": try #require(first), "x": 0, "y": 0]).status == 200)
    }

    @Test func managedModeHasNoUnboundOrAlternateTransportInputRoute() {
        let h = Harness(a)
        #expect(h.call("/tap", body: ["x": 0, "y": 0]).status == 409)
        #expect(h.call("/pair", body: ["host": UUID().uuidString]).status == 404)
        #expect(h.call("/tap_text", body: ["text": "synthetic"]).status == 404)
        #expect(h.touchOpens == 0 && h.keyboardOpens == 0 && h.commits == 0)
        let serialized = String(decoding: HTTPResponse(contentType: "image/png", headers: [:]).serialized, as: UTF8.self)
        #expect(serialized.contains("Cache-Control: no-store\r\n"))
    }
}
