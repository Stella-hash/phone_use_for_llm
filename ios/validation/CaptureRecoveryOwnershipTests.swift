import Foundation
import Testing
@testable import iPhoneUse

private final class OwnershipRecoverySource: CaptureValeriaRecoverySource {
    let id = "synthetic-source"
    let instanceID = UUID()
    let pinnedUSBDevice: USBValeriaConfigurator.PinnedUSBDevice? = .init(registryEntryID: 1, serial: nil)
    let isDeviceConnected = true
    let hasFrame = false
    let hasCaptureError = false
    var restarts = 0
    func restart() { restarts += 1 }
    func recordRecoveryError(_ message: String) {}
}

/// Coordinator tests use the same ownership component as ScreenCaptureManager;
/// a permissive protocol-default host would miss ownership admission regressions.
private final class OwnershipRecoveryHost: CaptureValeriaRecoveryHost {
    let recoveryLock = NSLock()
    let recoveryQueue = DispatchQueue(label: "capture-ownership-test.recovery")
    var isRecoveryStoppedLocked = false
    var recoveryLifecycleGenerationLocked: UInt64 = 1
    var recoverySourcesLocked: [String: OwnershipRecoverySource] = [:]
    var recoveryIdentityGenerationLocked: UInt64 = 1
    var recoveryVerificationStateLocked: ScreenCaptureIdentityState = .singleDevice
    var tracker = CaptureValeriaRecoveryTracker()
    var ownership = CaptureLifecycleOwnership()
    var denyNextAdmission = false

    func permitsRecoveryUSBLocked(sourceID: String?, entryID: UInt64?, excluding: UUID?) -> Bool {
        ownership.permitsUSB(sourceID: sourceID, entryID: entryID, excluding: excluding)
    }
    func beginRecoveryUSBOperationLocked(
        sourceID: String?, entryID: UInt64?, expectedLifecycle: UInt64
    ) -> CaptureResourceLease? {
        guard !isRecoveryStoppedLocked, recoveryLifecycleGenerationLocked == expectedLifecycle else { return nil }
        if denyNextAdmission { denyNextAdmission = false; return nil }
        let token = UUID()
        let lease = CaptureResourceLease(token: token) { [weak self] in
            guard let self else { return }
            self.recoveryLock.withLock {
                _ = self.ownership.release(token)
                self.scheduleReadyLocked()
            }
        }
        return ownership.reserveUSB(sourceID: sourceID, entryID: entryID, lease: lease) ? lease : nil
    }
    func deferRecoveryUSBRestoreLocked(
        entryID: UInt64, expectedLifecycle: UInt64, reusing: CaptureResourceLease?,
        whenReady: @escaping (CaptureResourceLease) -> Void
    ) {
        guard !isRecoveryStoppedLocked, recoveryLifecycleGenerationLocked == expectedLifecycle else { return }
        let token = UUID()
        let lease = CaptureResourceLease(token: token) { [weak self] in
            guard let self else { return }
            self.recoveryLock.withLock {
                _ = self.ownership.release(token)
                self.scheduleReadyLocked()
            }
        }
        _ = ownership.deferUSBRestore(entryID: entryID, lease: lease, reusing: reusing, whenReady: whenReady)
        scheduleReadyLocked()
    }
    private func scheduleReadyLocked() {
        for (lease, attempt, body) in ownership.takeReadyUSBRestores() {
            recoveryQueue.async {
                body(lease)
                if self.recoveryLock.withLock({ self.ownership.completedUSBRestoreAttempt(lease.token, attempt: attempt) }) { lease.finish() }
            }
        }
    }
    func withValeriaTrackerLocked<T>(_ body: (inout CaptureValeriaRecoveryTracker) -> T) -> T { body(&tracker) }
    func enterMultiDevicePendingForValeriaLocked() {
        recoveryIdentityGenerationLocked += 1
        recoveryVerificationStateLocked = .pending
    }
    func notifyScreensChangedAfterValeriaGate() {}
    func scheduleValeriaIdentityVerification(generation: UInt64, sources: [String: OwnershipRecoverySource]) {}
}

struct CaptureRecoveryOwnershipTests {
    @Test func runtimeErrorMergesWhileTheFirstProbeOwnsItsLease() {
        let host = OwnershipRecoveryHost(), source = OwnershipRecoverySource()
        host.recoverySourcesLocked = [source.id: source]
        let entered = DispatchSemaphore(value: 0), release = DispatchSemaphore(value: 0)
        CaptureValeriaRecoveryCoordinator.recoverIfNeeded(
            host: host, for: source, restartSource: false, postSwitchRestoreDelay: -1,
            activateUSB: { _, _, _, shouldProceed in
                #expect(shouldProceed())
                entered.signal()
                #expect(release.wait(timeout: .now() + 2) == .success)
                return .notActivated
            }, restoreUSB: { _ in .notTracked })
        #expect(entered.wait(timeout: .now() + 1) == .success)
        CaptureValeriaRecoveryCoordinator.recoverIfNeeded(
            host: host, for: source, restartSource: true, postSwitchRestoreDelay: -1,
            activateUSB: { _, _, _, _ in Issue.record("merged request must not activate separately"); return .notActivated },
            restoreUSB: { _ in .notTracked })
        release.signal()
        host.recoveryQueue.sync {}
        #expect(source.restarts == 1)
        #expect(host.tracker.entries[source.instanceID]?.runtimeRestartsUsed == 1)
    }

    @Test func deniedEmptyProbeAdmissionRefundsItsUnexecutedAttempt() {
        let host = OwnershipRecoveryHost()
        let topology = USBValeriaConfigurator.IOSUSBTopologyObservation.observed(
            .init(attachedEntryIDs: [1], singleDevice: .init(registryEntryID: 1, serial: nil)))
        host.denyNextAdmission = true // ownership changed after topology evaluation
        var activations = 0
        let activate: CaptureValeriaRecoveryCoordinator.USBActivator = { _, _, _, _ in
            activations += 1
            return .notActivated
        }
        CaptureValeriaRecoveryCoordinator.recoverEmptyDiscoveryIfNeeded(
            host: host, queryTopology: { topology }, activateUSB: activate, restoreUSB: { _ in .notTracked })
        host.recoveryQueue.sync {}
        #expect(activations == 0)
        #expect(!host.tracker.emptyDiscoveryInFlight)
        #expect(host.tracker.emptyDiscoveryAttemptedEntries.isEmpty)
        CaptureValeriaRecoveryCoordinator.recoverEmptyDiscoveryIfNeeded(
            host: host, queryTopology: { topology }, activateUSB: activate, restoreUSB: { _ in .notTracked })
        host.recoveryQueue.sync {}
        #expect(activations == 1)
    }

    @Test func unconfirmedActivationOwnsAdmissionThroughRollback() {
        let host = OwnershipRecoveryHost()
        var restored = false
        CaptureValeriaRecoveryCoordinator.recoverEmptyDiscoveryIfNeeded(
            host: host,
            queryTopology: { .observed(.init(attachedEntryIDs: [1], singleDevice: .init(registryEntryID: 1, serial: nil))) },
            activateUSB: { _, _, _, _ in
                .unconfirmedSwitch(.init(registryEntryID: 1, previousConfiguration: 6,
                    requestedConfiguration: 7, readbackConfirmed: false))
            },
            restoreUSB: { _ in
                restored = true
                let admitted = host.recoveryLock.withLock {
                    host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease())
                }
                #expect(!admitted)
                return .restored
            })
        host.recoveryQueue.sync {}
        #expect(restored)
        #expect({ host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease()) }())
    }
    @Test func liveRestoreWaitsForRemovedSourceThenRunsOnce() {
        let host = OwnershipRecoveryHost()
        let source = CaptureResourceLease()
        #expect({ host.ownership.reserveSource(id: "removed", entryID: 1, lease: source) }())
        #expect({ host.ownership.publish(source) }())
        _ = host.ownership.retireSource(id: "removed")
        var restoreCalls = 0
        let restore: CaptureValeriaRecoveryCoordinator.USBRestorer = { _ in
            restoreCalls += 1
            return .transientFailure // attempted failure must not auto-retry
        }
        for _ in 0..<2 {
            #expect(CaptureValeriaRecoveryCoordinator.performGatedLiveRestore(
                host: host, entryID: 1, expectedLifecycle: 1, restoreUSB: restore) == .transientFailure)
        }
        host.recoveryQueue.sync {}
        #expect(restoreCalls == 0)
        #expect({ !host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease()) }())
        let ready = host.recoveryLock.withLock { () -> [(lease: CaptureResourceLease, attempt: UInt64, body: (CaptureResourceLease) -> Void)] in
            _ = host.ownership.release(source.token)
            return host.ownership.takeReadyUSBRestores()
        }
        #expect(ready.count == 1)
        for (lease, _, body) in ready { body(lease); lease.finish() }
        host.recoveryQueue.sync {}
        #expect(restoreCalls == 1)
        #expect(host.ownership.takeReadyUSBRestores().isEmpty)
        #expect({ host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease()) }())
    }

    @Test func lateSwitchedActivationIsRestoredByShutdownBeforeNewAdmission() {
        final class DelayedUSBSession: USBConfigDeviceSession {
            let registryEntryID: UInt64 = 1
            var configuration: UInt8 = 6
            var setHistory: [UInt8] = []
            let entered: DispatchSemaphore
            let release: DispatchSemaphore
            init(entered: DispatchSemaphore, release: DispatchSemaphore) {
                self.entered = entered
                self.release = release
            }
            func getConfiguration() -> UInt8? { configuration }
            func openSafely() -> Bool { true }
            func close() {}
            func setConfiguration(_ value: UInt8) -> Bool {
                configuration = value
                setHistory.append(value)
                if value == 7 {
                    entered.signal()
                    #expect(release.wait(timeout: .now() + 2) == .success)
                }
                return true
            }
        }

        let host = OwnershipRecoveryHost()
        let usbQueue = DispatchQueue(label: "capture-ownership-test.late-switch-usb")
        let switchEntered = DispatchSemaphore(value: 0), releaseSwitch = DispatchSemaphore(value: 0)
        let restoreEntered = DispatchSemaphore(value: 0), releaseRestore = DispatchSemaphore(value: 0)
        let shutdownSettled = DispatchSemaphore(value: 0)
        let session = DelayedUSBSession(entered: switchEntered, release: releaseSwitch)
        var ledger = USBSwitchLedger() // in-memory; all ledger/session access uses fake USB queue
        var liveRollbackCalls = 0, fullRestoreCalls = 0
        let descriptors: [USBValeriaConfigurator.ConfigurationDescriptorInfo] = [
            .init(value: 6, name: "PTP", interfaceClasses: [0x06]),
            .init(value: 7, name: "PTP + Valeria", interfaceClasses: [0x06, 0xFF]),
        ]
        CaptureValeriaRecoveryCoordinator.recoverEmptyDiscoveryIfNeeded(
            host: host,
            queryTopology: { .observed(.init(attachedEntryIDs: [1], singleDevice: .init(registryEntryID: 1, serial: nil))) },
            activateUSB: { _, _, _, shouldProceed in
                let outcome = usbQueue.sync {
                    ledger.activate(
                        session: session, descriptors: descriptors, allowPrimaryNetworkPreemption: false,
                        inspectEnvironment: { (.inspected(activeHostInterfaces: []), nil) },
                        shouldProceed: shouldProceed)
                }
                // SetConfiguration began in generation 1; its confirmed result
                // returns only after stop and a new start request (generation 3).
                #expect(host.recoveryLock.withLock { host.recoveryLifecycleGenerationLocked } == 3)
                if case .switched = outcome {} else { Issue.record("expected late confirmed switch") }
                return outcome
            },
            restoreUSB: { entryID in
                usbQueue.sync {
                    liveRollbackCalls += 1
                    return ledger.restore(registryEntryID: entryID, session: session)
                }
            })
        #expect(switchEntered.wait(timeout: .now() + 1) == .success)
        let shutdown = host.recoveryLock.withLock {
            host.isRecoveryStoppedLocked = true
            host.recoveryLifecycleGenerationLocked += 1
            _ = host.tracker.reset()
            let shutdown = host.ownership.beginShutdown()
            host.isRecoveryStoppedLocked = false
            host.recoveryLifecycleGenerationLocked += 1
            return shutdown
        }
        for lease in shutdown.cancelledRestores { lease.finish() }
        #expect(shutdown.usbOperations.count == 1)
        let stopped = CaptureShutdownCoordinator.stop(
            waitTimeout: 0, activeSources: shutdown.leases, pendingUSBOperations: shutdown.usbOperations,
            notifyQueue: DispatchQueue(label: "capture-ownership-test.late-switch-shutdown"),
            restoreAllUSB: { _ in
                let restored = usbQueue.sync {
                    fullRestoreCalls += 1
                    #expect(ledger.trackedEntryIDs == [1])
                    restoreEntered.signal()
                    #expect(releaseRestore.wait(timeout: .now() + 2) == .success)
                    return ledger.restore(registryEntryID: 1, session: session) == .restored
                }
                // Model the manager's asynchronous USB queue settlement callback;
                // the bounded stop return itself cannot release this fence.
                usbQueue.async {
                    host.recoveryLock.withLock { host.ownership.finishShutdown(shutdown.token) }
                    shutdownSettled.signal()
                }
                return restored
            })
        #expect(stopped.captureDrained && !stopped.usbRestored)
        #expect(restoreEntered.wait(timeout: .now()) == .timedOut)
        #expect(!host.recoveryLock.withLock {
            host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease())
        })
        releaseSwitch.signal()
        #expect(restoreEntered.wait(timeout: .now() + 1) == .success)
        #expect(!host.recoveryLock.withLock {
            host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease())
        })
        releaseRestore.signal()
        #expect(shutdownSettled.wait(timeout: .now() + 1) == .success)
        host.recoveryQueue.sync {}
        usbQueue.sync {
            #expect(liveRollbackCalls == 0)
            #expect(fullRestoreCalls == 1)
            #expect(ledger.trackedEntryIDs.isEmpty)
            #expect(session.configuration == 6)
            #expect(session.setHistory == [7, 6])
        }
        #expect(host.recoveryLock.withLock {
            host.tracker.pendingEmptyDiscoverySwitch == nil &&
                host.ownership.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease())
        })
    }
}
