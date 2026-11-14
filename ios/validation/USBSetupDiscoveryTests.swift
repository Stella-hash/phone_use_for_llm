import Foundation
import Testing
@testable import iPhoneUse

@Suite struct USBSetupDiscoveryTests {
    private let usb = "00000000-1111111111111111"

    private final class Fixture {
        var physical = ["00000000-1111111111111111"]
        var pin: USBValeriaConfigurator.PinnedUSBDevice? = .init(registryEntryID: 1, serial: "000000001111111111111111")
        var pending = false
        var restoreOK = true
        var currentConfiguration = 6
        var terminalConfiguration = 6
        var duringRestore: ((Fixture) -> Void)?
        var duringFinalRead: ((Fixture) -> Void)?
        var cancelled = false
        var throwOnRead: Int?
        var events: [String] = []
        var reads = 0
        enum Failure: Error { case unavailable }
        func dependencies() -> USBSetupDiscovery.Dependencies {
            .init(physical: {
                self.events.append("physical")
                self.reads += 1
                if self.throwOnRead == self.reads { throw Failure.unavailable }
                if self.reads > 1 { self.duringFinalRead?(self) }
                return self.physical
            }, singlePin: {
                self.events.append("pin")
                return self.pin
            }, pendingRestore: { self.pending }, restore: {
                self.events.append("restore")
                self.currentConfiguration = self.terminalConfiguration
                self.duringRestore?(self)
                return self.restoreOK
            }, cancelled: {
                self.events.append("cancelled")
                return self.cancelled
            })
        }
    }

    @Test func solePhysicalDeviceProducesOneCanonicalIdentityWithoutAVOrUSBMutation() {
        let fixture = Fixture()
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        let candidate = result["config_candidate"] as? [String: Any]
        #expect(result["status"] as? String == "configuration_candidate")
        #expect(candidate?["usbDeviceId"] as? String == usb)
        #expect(candidate?["port"] as? Int == 7390)
        #expect(candidate?.count == 2)
        #expect(result["capture_devices"] == nil)
        #expect(result["usb_configuration"] as? String == "not_attempted")
        #expect(result["cleanup"] as? String == "not_needed")
        for key in ["config_written", "phone_input_sent", "capture_session_started", "bluetooth_started", "pairing_attempted"] {
            #expect(result[key] as? Bool == false)
        }
        #expect(fixture.events == ["physical", "pin", "physical", "pin", "cancelled"])
    }

    @Test func exactModernAndLegacyUDIDsAreAcceptedWithoutRewriting() {
        for value in ["0123abcd-ABCDEF0123456789", String(repeating: "AbCdEf0123", count: 4)] {
            let fixture = Fixture()
            fixture.physical = [value]
            fixture.pin = .init(registryEntryID: 1, serial: value.replacingOccurrences(of: "-", with: "").uppercased())
            let result = USBSetupDiscovery.collect(fixture.dependencies())
            #expect(result["status"] as? String == "configuration_candidate")
            #expect((result["config_candidate"] as? [String: Any])?["usbDeviceId"] as? String == value)
        }
    }

    @Test func malformedOrOpaqueCaptureIDsCannotBecomePhysicalCandidates() {
        for value in ["", String(repeating: "a", count: 25), String(repeating: "a", count: 39),
            String(repeating: "a", count: 41), "00000000-0000-4000-8000-000000000001",
            "0123456-0123456789abcdef", "01234567-0123456789abcdeg", usb + "\n", usb + "\r", usb + "\u{2028}"] {
            let fixture = Fixture()
            fixture.physical = [value]
            let result = USBSetupDiscovery.collect(fixture.dependencies())
            #expect(result["status"] as? String == "physical_usb_identity_invalid")
            #expect(result["config_candidate"] == nil)
            #expect(!fixture.events.contains("pin"))
        }
    }

    @Test func multiplePhonesHaveNoAutomaticSelection() {
        let fixture = Fixture()
        fixture.physical.append("00000000-2222222222222222")
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "ambiguous_devices")
        #expect(result["config_candidate"] == nil)
        #expect(!fixture.events.contains("pin"))
        #expect(!fixture.events.contains("restore"))
    }

    @Test func noPhysicalPhoneIsAnExplicitNonSuccess() {
        let fixture = Fixture()
        fixture.physical = []
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "no_usb_device")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.reads == 2)
    }

    @Test func unavailableFirstOrFinalInventoryCannotReturnSuccess() {
        for read in [1, 2] {
            let fixture = Fixture()
            fixture.throwOnRead = read
            let result = USBSetupDiscovery.collect(fixture.dependencies())
            #expect(result["status"] as? String == "physical_usb_inventory_unavailable")
            #expect(result["config_candidate"] == nil)
        }
    }

    @Test func absentOrMismatchedPinCannotConfirmADevice() {
        for pin in [nil, USBValeriaConfigurator.PinnedUSBDevice(registryEntryID: 2, serial: "different")] {
            let fixture = Fixture()
            fixture.pin = pin
            let result = USBSetupDiscovery.collect(fixture.dependencies())
            #expect(result["status"] as? String == "usb_topology_unconfirmed")
            #expect(result["config_candidate"] == nil)
        }
    }

    @Test func detachDuringFinalInventorySuppressesTheCandidate() {
        let fixture = Fixture()
        fixture.duringFinalRead = { $0.physical = []; $0.pin = nil }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_topology_changed")
        #expect(result["config_candidate"] == nil)
    }

    @Test func changedFinalPinIsDetectedEvenWithTheSameUDID() {
        let fixture = Fixture()
        fixture.duringFinalRead = { $0.pin = .init(registryEntryID: 2, serial: "000000001111111111111111") }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_topology_changed")
        #expect(result["config_candidate"] == nil)
    }

    @Test func pendingOldRestoreBlocksDiscoveryUntilSettled() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.restoreOK = false
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "previous_usb_restore_pending")
        #expect(result["cleanup"] as? String == "pending")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events == ["physical", "pin", "restore", "cancelled"])
    }

    @Test func oldRestoreStillRunsWhenInitialInventoryIsUnavailable() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.throwOnRead = 1
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "physical_usb_inventory_unavailable")
        #expect(result["cleanup"] as? String == "settled")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.contains("restore"))
    }

    @Test func detachDuringOldCleanupSuppressesTheOldCandidate() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.duringRestore = { $0.physical = []; $0.pin = nil }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["cleanup"] as? String == "settled")
        #expect(result["status"] as? String == "usb_topology_changed_during_cleanup")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.lastIndex(of: "physical")! > fixture.events.lastIndex(of: "restore")!)
    }

    @Test func reattachDuringOldCleanupIsDetectedEvenWithTheSameUDID() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.duringRestore = { $0.pin = .init(registryEntryID: 2, serial: "000000001111111111111111") }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_topology_changed_during_cleanup")
        #expect(result["config_candidate"] == nil)
    }

    @Test func supersededTerminalCleanupNeverClaimsOriginalConfigurationRestored() {
        let fixture = Fixture()
        fixture.pending = true
        // The aggregate API can return true for an external configuration that
        // superseded a previous run's change. It did not restore configuration 6.
        fixture.terminalConfiguration = 7
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(fixture.currentConfiguration == 7)
        #expect(result["cleanup"] as? String == "settled")
        #expect((result["cleanup_scope"] as? String)?.contains("superseded") == true)
        #expect(result["status"] as? String == "configuration_candidate")
        #expect(result["usb_configuration"] as? String == "not_attempted")
        #expect(fixture.events.lastIndex(of: "pin")! > fixture.events.lastIndex(of: "restore")!)
    }

    @Test func cancellationDuringOldCleanupCannotReturnSuccess() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.duringRestore = { $0.cancelled = true }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["cleanup"] as? String == "settled")
        #expect(result["status"] as? String == "cancelled_or_deadline")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.last == "cancelled")
    }

    @Test func cancelledInventoryCannotReturnSuccess() {
        let fixture = Fixture()
        fixture.cancelled = true
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "cancelled_or_deadline")
        #expect(result["config_candidate"] == nil)
        #expect(!fixture.events.contains("restore"))
    }

    @Test func pendingCleanupRetainsItsActionableFailureDuringCancellation() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.restoreOK = false
        fixture.duringRestore = { $0.cancelled = true }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "previous_usb_restore_pending")
        #expect(result["cleanup"] as? String == "pending")
        #expect(result["config_candidate"] == nil)
    }
}
