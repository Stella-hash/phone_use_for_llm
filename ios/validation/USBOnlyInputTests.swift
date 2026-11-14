import Foundation
import Testing

@testable import iPhoneUse

/// No Bluetooth manager, USB helper, capture or phone is created by these checks.
@Suite struct USBOnlyInputTests {
    @Test func usbOnlyPreviewDoesNotClaimGUIInputOrRequestBluetoothPairing() {
        for hasMatchedHost in [false, true] {
            let status = ControlConnectionStatus.resolve(
                hasScreen: true, hasMatchedHost: hasMatchedHost, bluetoothState: .connected,
                inputIsCurrent: true, inputIsReady: true, screenPermitsInput: true, bluetoothEnabled: false)
            #expect(status == .usbPreviewOnly)
            #expect(status != .connected)
            #expect(!status.showsOverlay)
            #expect(!status.showsBluetoothGuidance(bluetoothEnabled: false))
        }
        let waiting = ControlConnectionStatus.resolve(
            hasScreen: false, hasMatchedHost: false, bluetoothState: .disconnected,
            inputIsCurrent: false, inputIsReady: false, screenPermitsInput: false, bluetoothEnabled: false)
        #expect(waiting == .waitingForDevice)
        #expect(waiting.showsOverlay)
        #expect(!waiting.showsBluetoothGuidance(bluetoothEnabled: false))
        #expect(ControlConnectionStatus.disconnected.showsBluetoothGuidance(bluetoothEnabled: true))
    }

    @Test func disabledBluetoothSurvivesDemandAndWakeTransitions() {
        var policy = HIDLifecyclePolicy(allowBluetooth: false)
        let window = UUID()
        policy.start(initialDisplayState: .unknown)
        policy.setUSBScreenDemand(true, revision: 1)
        policy.beginWindowDemand(window)
        #expect(!policy.shouldRunCoreBluetooth)
        #expect(policy.inactiveReason == .disabled)
        #expect(policy.nextUnknownDisplayRetry()?.generation == nil)

        policy.systemWillSleep()
        policy.systemDidWake(displayState: .noOnlineDisplays)
        policy.screensDidSleep()
        policy.screensDidWake()
        policy.setUSBScreenDemand(false, revision: 2)
        policy.setUSBScreenDemand(true, revision: 3)
        #expect(!policy.shouldRunCoreBluetooth)
        #expect(policy.inactiveReason?.stateDescription == "disabled")

        policy.endWindowDemand(window)
        policy.stop()
        policy.start()
        #expect(!policy.allowBluetooth)
        #expect(!policy.shouldRunCoreBluetooth)
        #expect(policy.inactiveReason == .disabled)
    }

    @Test func legacyBluetoothStillFollowsDemandAndSystemSleep() {
        var policy = HIDLifecyclePolicy()
        policy.start()
        policy.setUSBScreenDemand(true, revision: 1)
        #expect(policy.allowBluetooth)
        #expect(policy.shouldRunCoreBluetooth)
        policy.systemWillSleep()
        #expect(!policy.shouldRunCoreBluetooth)
        policy.systemDidWake(displayState: .noOnlineDisplays)
        #expect(policy.shouldRunCoreBluetooth)
    }

    @Test func usbHomeUsesTheCommandHProgramAndCountsAgainstBatchBudget() throws {
        let home = try CoreDeviceKeyboardProgram.home()
        let chord = try CoreDeviceKeyboardProgram.key(KeyRequest(["key": "h", "modifiers": ["command"]]))
        #expect(home.samples.map { $0["usages"] as! [Int] } == chord.samples.map { $0["usages"] as! [Int] })
        #expect(home.samples.last?["usages"] as? [Int] == [])
        #expect(home.samples.last?["at_ms"] as? Int == 320)

        let waits: [[String: Any]] = Array(repeating: ["type": "delay", "seconds": 6], count: 4)
        let overBudget = waits + [["type": "delay", "seconds": 5.8], ["type": "home"]]
        #expect(throws: (any Error).self) {
            try ActRequest(["steps": overBudget], directKeyboardConfigured: true)
        }
        _ = try ActRequest(["steps": overBudget], directKeyboardConfigured: false)
        _ = try ActRequest(["steps": waits + [["type": "delay", "seconds": 5.6], ["type": "home"]]],
            directKeyboardConfigured: true)
    }
}
