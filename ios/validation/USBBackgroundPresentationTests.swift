import Foundation
import Testing

@testable import iPhoneUse

/// Pure presentation/window-state checks; no NSApplication, windows, phone,
/// capture, Bluetooth manager or helper process is instantiated.
@Suite struct USBBackgroundPresentationTests {
    @Test func activationAndWindowPolicyPreserveTheLegacyModes() {
        for mode in AppRunMode.allCases {
            for bluetooth in [false, true] {
                let expectedWindows = mode == .desktop || bluetooth
                #expect(mode.permitsNativeWindows(bluetoothEnabled: bluetooth) == expectedWindows)
                #expect(mode.activationPolicy(bluetoothEnabled: bluetooth) == (expectedWindows ? .regular : .accessory))
            }
        }
    }

    @Test func usbQuietRejectsStartupHotplugAndExplicitReopenWithoutAPlaceholder() {
        var state = ControlWindowState(mode: .residentQuiet, bluetoothEnabled: false)
        for devices in [[], ["phone-a"], ["phone-a", "phone-b"]] {
            for reason in [ControlWindowUpdateReason.discovery, .userRequest, .resumeDesktopMode] {
                #expect(state.update(connectedIDs: devices, reason: reason).isEmpty)
                #expect(state.deviceIDs.isEmpty)
                #expect(!state.needsWaitingWindow)
            }
        }
        let closeResult1 = state.close(deviceID: nil)
        #expect(!closeResult1)
    }

    @Test func usbDesktopToQuietClosesWithoutTerminatingAndCanReturnToDesktop() {
        var state = ControlWindowState(mode: .desktop, bluetoothEnabled: false)
        #expect(state.update(connectedIDs: ["phone-a", "phone-b"]) == ["phone-a", "phone-b"])
        state.setMode(.residentQuiet)
        #expect(!state.permitsNativeWindows)
        #expect(state.update(connectedIDs: ["phone-a", "phone-b"], reason: .userRequest).isEmpty)
        // The coordinator changes mode before closing its actual controllers.
        let closeResult2 = state.close(deviceID: "phone-a")
        #expect(!closeResult2)
        let closeResult3 = state.close(deviceID: "phone-b")
        #expect(!closeResult3)
        #expect(!state.needsWaitingWindow)
        state.setMode(.desktop)
        #expect(state.update(connectedIDs: ["phone-a", "phone-b"], reason: .resumeDesktopMode) == ["phone-a", "phone-b"])
        let closeResult4 = state.close(deviceID: "phone-a")
        #expect(!closeResult4)
        let closeResult5 = state.close(deviceID: "phone-b")
        #expect(closeResult5)
    }

    @Test func usbWaitingWindowAlsoClosesOnQuietTransitionWithoutReopening() {
        var state = ControlWindowState(mode: .desktop, bluetoothEnabled: false)
        #expect(state.update(connectedIDs: []).isEmpty)
        #expect(state.needsWaitingWindow)
        state.setMode(.residentQuiet)
        #expect(!state.needsWaitingWindow)
        let closeResult6 = state.close(deviceID: nil)
        #expect(!closeResult6)
        #expect(state.update(connectedIDs: ["phone-a"], reason: .discovery).isEmpty)
        state.setMode(.desktop)
        #expect(state.update(connectedIDs: [], reason: .resumeDesktopMode).isEmpty)
        #expect(state.needsWaitingWindow)
    }

    @Test func legacyQuietStillAllowsExplicitPreviewAndPreservesAnExistingPlaceholder() {
        var state = ControlWindowState(mode: .desktop, bluetoothEnabled: true)
        #expect(state.update(connectedIDs: []).isEmpty)
        state.setMode(.residentQuiet)
        #expect(state.permitsNativeWindows)
        #expect(state.needsWaitingWindow)
        #expect(state.update(connectedIDs: ["phone-a"], reason: .discovery) == ["phone-a"])
        let closeResult7 = state.close(deviceID: "phone-a")
        #expect(!closeResult7)
        #expect(state.update(connectedIDs: ["phone-a"], reason: .discovery).isEmpty)
        #expect(state.update(connectedIDs: ["phone-a"], reason: .userRequest) == ["phone-a"])
    }
}
