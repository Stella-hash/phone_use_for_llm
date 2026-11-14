import Foundation
import Testing
@testable import iPhoneUse

@Suite struct USBSetupDiscoveryTests {
    private let usb = "00000000-1111111111111111"
    private let capture = USBSetupDiscovery.Capture(id: "00000000-0000-4000-8000-000000000001", name: "Fixture phone")

    private final class Fixture {
        var physical = ["00000000-1111111111111111"]
        var captureSamples: [[USBSetupDiscovery.Capture]] = []
        var pin: USBValeriaConfigurator.PinnedUSBDevice? = .init(registryEntryID: 1, serial: "000000001111111111111111")
        var pending = false
        var restoreOK = true
        var currentConfiguration = 6
        var terminalConfiguration = 6
        var duringRestore: ((Fixture) -> Void)?
        var cancelled = false
        var topologyChanges = false
        var throwAfterActivation = false
        var outcome: USBValeriaConfigurator.ActivationOutcome = .switched(.init(registryEntryID: 1, previousConfiguration: 6, requestedConfiguration: 5))
        var events: [String] = []
        var reads = 0
        enum Failure: Error { case unavailable }
        func dependencies() -> USBSetupDiscovery.Dependencies {
            .init(physical: {
                self.events.append("physical")
                self.reads += 1
                if self.throwAfterActivation && self.reads > 1 { throw Failure.unavailable }
                return self.topologyChanges && self.reads > 1 ? [] : self.physical
            }, captures: {
                self.events.append("captures")
                if self.captureSamples.count > 1 { return self.captureSamples.removeFirst() }
                return self.captureSamples.first ?? []
            }, singlePin: {
                self.events.append("pin")
                return self.pin
            }, pendingRestore: { self.pending }, activate: { _, _ in
                self.events.append("activate")
                self.currentConfiguration = 5
                return self.outcome
            }, restore: {
                self.events.append("restore")
                self.currentConfiguration = self.terminalConfiguration
                self.duringRestore?(self)
                return self.restoreOK
            }, wait: { self.events.append("wait") }, cancelled: { self.cancelled })
        }
    }

    @Test func exposedSoleDeviceProducesCandidateWithoutUSBMutation() {
        let fixture = Fixture()
        fixture.captureSamples = [[capture]]
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "configuration_candidate")
        #expect((result["config_candidate"] as? [String: Any])?["usbDeviceId"] as? String == usb)
        #expect(result["config_written"] as? Bool == false)
        #expect(!fixture.events.contains("activate"))
        #expect(!fixture.events.contains("restore"))
    }

    @Test func dormantSoleDeviceActivatesOnceThenRestoresBeforeReturning() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "configuration_candidate")
        #expect(result["usb_configuration"] as? String == "temporarily_activated")
        #expect(result["cleanup"] as? String == "settled")
        #expect(fixture.events.filter { $0 == "activate" }.count == 1)
        #expect(fixture.events.contains("restore"))
        #expect(fixture.events.lastIndex(of: "physical")! > fixture.events.lastIndex(of: "restore")!)
    }

    @Test func multiplePhonesHaveNoAutomaticPairingOrActivation() {
        let fixture = Fixture()
        fixture.physical.append("00000000-2222222222222222")
        fixture.captureSamples = [[capture]]
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "ambiguous_devices")
        #expect(result["config_candidate"] == nil)
        #expect(!fixture.events.contains("activate"))
    }

    @Test func topologyFailureStillRestoresAndSuppressesCandidate() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.topologyChanges = true
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_topology_changed")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.contains("restore"))
        #expect(fixture.events.lastIndex(of: "physical")! > fixture.events.lastIndex(of: "restore")!)
    }

    @Test func restoreFailureCannotReportAConfigurationCandidate() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.restoreOK = false
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_restore_pending")
        #expect(result["cleanup"] as? String == "pending")
        #expect(result["config_candidate"] == nil)
    }

    @Test func cancelledOrUnconfirmedTopologyNeverActivates() {
        for mode in ["cancelled", "unknown", "mismatch"] {
            let fixture = Fixture()
            fixture.cancelled = mode == "cancelled"
            if mode == "unknown" { fixture.pin = nil }
            if mode == "mismatch" { fixture.pin = .init(registryEntryID: 2, serial: "different") }
            let result = USBSetupDiscovery.collect(fixture.dependencies())
            #expect(result["config_candidate"] == nil)
            #expect(!fixture.events.contains("activate"))
        }
    }

    @Test func pendingOldRestoreBlocksDiscoveryUntilSettled() {
        let fixture = Fixture()
        fixture.pending = true
        fixture.restoreOK = false
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "previous_usb_restore_pending")
        #expect(fixture.events == ["restore"])
    }

    @Test func USBNetworkProtectionDoesNotBecomeAForcedFallback() {
        let fixture = Fixture()
        fixture.outcome = .blockedByActiveUSBNetwork
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "capture_unavailable")
        #expect(result["usb_configuration"] as? String == "blocked_by_usb_network")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.filter { $0 == "activate" }.count == 1)
        #expect(!fixture.events.contains("restore"))
    }

    @Test func unavailableFinalInventoryStillRestores() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.throwAfterActivation = true
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "physical_usb_inventory_unavailable")
        #expect(result["config_candidate"] == nil)
        #expect(fixture.events.contains("restore"))
        #expect(fixture.events.lastIndex(of: "physical")! > fixture.events.lastIndex(of: "restore")!)
    }


    @Test func detachDuringTerminalCleanupSuppressesTheOldCandidate() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.duringRestore = { state in state.physical = []; state.pin = nil }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["cleanup"] as? String == "settled")
        #expect(result["status"] as? String == "usb_topology_changed_during_cleanup")
        #expect(result["config_candidate"] == nil)
    }

    @Test func reattachDuringCleanupIsDetectedEvenWithTheSameUDID() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.duringRestore = { state in
            state.pin = .init(registryEntryID: 2, serial: "000000001111111111111111")
        }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["status"] as? String == "usb_topology_changed_during_cleanup")
        #expect(result["config_candidate"] == nil)
    }

    @Test func supersededTerminalCleanupNeverClaimsOriginalConfigurationRestored() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        // Mirrors the aggregate API's true result for an external configuration
        // superseding our change. USB identity stays the same; configuration 6 was not restored.
        fixture.terminalConfiguration = 7
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(fixture.currentConfiguration == 7)
        #expect(result["cleanup"] as? String == "settled")
        #expect((result["cleanup_scope"] as? String)?.contains("superseded") == true)
        #expect(result["capture_inventory_phase"] as? String == "before_usb_cleanup")
        #expect(fixture.events.lastIndex(of: "physical")! > fixture.events.lastIndex(of: "restore")!)
    }

    @Test func cancellationDuringCleanupCannotReturnSuccess() {
        let fixture = Fixture()
        fixture.captureSamples = [[], [capture]]
        fixture.duringRestore = { $0.cancelled = true }
        let result = USBSetupDiscovery.collect(fixture.dependencies())
        #expect(result["cleanup"] as? String == "settled")
        #expect(result["status"] as? String == "cancelled_or_deadline")
        #expect(result["config_candidate"] == nil)
    }

    @Test func distinctNonopaqueIdentifiersDoNotBecomeAMapping() {
        let other = USBSetupDiscovery.Capture(id: "00000000-2222222222222222", name: "Other")
        #expect(USBSetupDiscovery.candidate(captures: [other], physical: [usb]) == nil)
    }
}
