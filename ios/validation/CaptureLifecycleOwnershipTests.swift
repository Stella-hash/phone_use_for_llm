import Foundation
import Testing
@testable import iPhoneUse

private final class HeldCaptureStop: StoppableCaptureSource {
    var stopCalls = 0
    var completion: (() -> Void)?
    func stop(completion: (() -> Void)?) {
        stopCalls += 1
        self.completion = completion
    }
    func drain() { completion?(); completion = nil }
}

private final class OwnershipFixture {
    let lock = NSLock()
    var state = CaptureLifecycleOwnership()
    func lease() -> CaptureResourceLease {
        let token = UUID()
        return CaptureResourceLease(token: token) { [weak self] in
            guard let self else { return }
            self.lock.withLock { _ = self.state.release(token) }
        }
    }
}

struct CaptureLifecycleOwnershipTests {
    @Test func discoveryRequestsCoalesceAndRejectOldLifecycle() throws {
        var state = CaptureLifecycleOwnership()
        #expect({ state.requestDiscovery(generation: 1) }())
        let old = try #require({ state.nextDiscovery() }())
        // While its snapshot is held, concurrent callers cannot enqueue a
        // second worker that could apply a newer snapshot ahead of this one.
        for _ in 0..<1000 { #expect({ !state.requestDiscovery(generation: 1) }()) }
        #expect(state.accepts(old, generation: 1))
        let next = try #require({ state.nextDiscovery() }())
        #expect(next.sequence == old.sequence + 1)
        #expect({ state.nextDiscovery() == nil }())

        #expect({ state.requestDiscovery(generation: 1) }())
        let interrupted = try #require({ state.nextDiscovery() }())
        state.invalidateDiscovery()
        #expect({ !state.requestDiscovery(generation: 3) }())
        #expect(!state.accepts(interrupted, generation: 3))
        let resumed = try #require({ state.nextDiscovery() }())
        #expect(resumed.generation == 3)
        #expect(state.accepts(resumed, generation: 3))
        #expect({ state.nextDiscovery() == nil }())
    }

    @Test func inFlightConstructorRemainsOwnedAcrossBoundedStopAndRestart() throws {
        let fixture = OwnershipFixture()
        let old = fixture.lease()
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: old) }())
        // The factory has not attached a source yet when global stop snapshots.
        let shutdown = fixture.state.beginShutdown()
        #expect(shutdown.leases.count == 1)
        let restoreEntered = DispatchSemaphore(value: 0)
        let result = CaptureShutdownCoordinator.stop(
            waitTimeout: 0, activeSources: shutdown.leases,
            notifyQueue: DispatchQueue(label: "capture-ownership-test.shutdown"),
            restoreAllUSB: { _ in restoreEntered.signal(); return false })
        #expect(!result.captureDrained)
        #expect(!result.usbRestored)
        #expect(restoreEntered.wait(timeout: .now()) == .timedOut)
        #expect({ !fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())

        let lateSource = HeldCaptureStop()
        old.attach(lateSource)
        #expect(lateSource.stopCalls == 1)
        #expect({ !fixture.state.publish(old) }())
        // Another stop waiter must neither lose the constructor nor issue a
        // second stopRunning against the same source.
        var drained = false
        old.stop { drained = true }
        #expect(!drained)
        #expect(lateSource.stopCalls == 1)
        lateSource.drain()
        #expect(drained)
        #expect(restoreEntered.wait(timeout: .now() + 1) == .success)
        // Even with capture drained, a timed-out restore can still be running.
        #expect({ !fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())
        fixture.state.finishShutdown(shutdown.token)
        let replacement = fixture.lease()
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: replacement) }())
        #expect({ fixture.state.publish(replacement) }())
        old.finish() // duplicate/late completion cannot release the new token
        #expect({ !fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())
    }

    @Test func removedSourceRemainsOwnedWithoutBlockingKnownOtherDevice() throws {
        let fixture = OwnershipFixture()
        let a = fixture.lease(), b = fixture.lease()
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: a) }())
        #expect({ fixture.state.publish(a) }())
        #expect({ fixture.state.reserveSource(id: "B", entryID: 2, lease: b) }())
        #expect({ fixture.state.publish(b) }())
        let aSource = HeldCaptureStop(), bSource = HeldCaptureStop()
        a.attach(aSource); b.attach(bSource)
        let retired = try #require({ fixture.state.retireSource(id: "A") }())
        retired.stop(completion: nil)
        #expect({ !fixture.state.reserveSource(id: "A-new-UID", entryID: 1, lease: fixture.lease()) }())
        #expect(!fixture.state.permitsUSB(sourceID: "A", entryID: 1))
        #expect(fixture.state.permitsUSB(sourceID: "B", entryID: 2))
        #expect(bSource.stopCalls == 0)
        let c = fixture.lease()
        #expect({ fixture.state.reserveSource(id: "C", entryID: 3, lease: c) }())
        c.finish()
        let first = fixture.state.beginShutdown()
        let second = fixture.state.beginShutdown()
        #expect(first.leases.count == 2)
        #expect(second.leases.count == 2)
        for lease in first.leases + second.leases { lease.stop(completion: nil) }
        #expect(aSource.stopCalls == 1)
        #expect(bSource.stopCalls == 1)
        aSource.drain(); bSource.drain()
        fixture.state.finishShutdown(first.token)
        #expect(fixture.state.hasShutdown)
        fixture.state.finishShutdown(second.token)
        #expect(!fixture.state.hasShutdown)
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())
    }

    @Test func failedConstructorDoesNotRequestAnImmediateRetryLoop() throws {
        var state = CaptureLifecycleOwnership()
        #expect({ state.requestDiscovery(generation: 1) }())
        _ = try #require({ state.nextDiscovery() }())
        let failed = CaptureResourceLease()
        #expect({ state.reserveSource(id: "A", entryID: 1, lease: failed) }())
        #expect({ !state.release(failed.token) }()) // manager must not enqueue refresh
        #expect({ state.nextDiscovery() == nil }())
        // An actual later timer/notification still retries normally.
        #expect({ state.requestDiscovery(generation: 1) }())
    }

    @Test func admittedUSBOperationIsIncludedInShutdownDrain() {
        let fixture = OwnershipFixture()
        let operation = fixture.lease()
        #expect({ fixture.state.reserveUSB(sourceID: "A", entryID: 1, lease: operation) }())
        #expect(fixture.state.permitsUSB(sourceID: "A", entryID: 1, excluding: operation.token))
        #expect({ !fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())
        let shutdown = fixture.state.beginShutdown()
        let restored = DispatchSemaphore(value: 0)
        let result = CaptureShutdownCoordinator.stop(
            waitTimeout: 0, activeSources: shutdown.leases,
            pendingUSBOperations: shutdown.usbOperations,
            notifyQueue: DispatchQueue(label: "capture-ownership-test.usb"),
            restoreAllUSB: { _ in restored.signal(); return true })
        #expect(result.captureDrained)
        #expect(!result.usbRestored)
        #expect(restored.wait(timeout: .now()) == .timedOut)
        operation.finish()
        #expect(restored.wait(timeout: .now() + 1) == .success)
        #expect(fixture.state.hasShutdown)
        fixture.state.finishShutdown(shutdown.token)
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: fixture.lease()) }())
    }

    @Test func deferredRestoresCoalesceAndShutdownCancelsUnstartedWork() {
        let fixture = OwnershipFixture()
        let capture = fixture.lease()
        #expect({ fixture.state.reserveSource(id: "A", entryID: 1, lease: capture) }())
        #expect({ fixture.state.publish(capture) }())
        _ = fixture.state.retireSource(id: "A")
        var calls: [Int] = []
        let a = fixture.lease(), b = fixture.lease()
        let first = fixture.state.deferUSBRestore(entryID: 1, lease: a, reusing: nil) { _ in calls.append(1) }
        let duplicate = fixture.state.deferUSBRestore(entryID: 1, lease: fixture.lease(), reusing: nil) { _ in calls.append(99) }
        let distinct = fixture.state.deferUSBRestore(entryID: 2, lease: b, reusing: nil) { _ in calls.append(2) }
        #expect(first && !duplicate && distinct)
        // A's drain does not block a proven different physical entry.
        let ready = fixture.state.takeReadyUSBRestores()
        #expect(ready.count == 1)
        for (lease, _, body) in ready { body(lease); lease.finish() }
        #expect(calls == [2])
        #expect({ !fixture.state.reserveSource(id: "replacement", entryID: 1, lease: fixture.lease()) }())
        let shutdown = fixture.state.beginShutdown()
        #expect(shutdown.cancelledRestores.count == 1)
        for lease in shutdown.cancelledRestores { lease.finish() }
        capture.finish()
        #expect(fixture.state.takeReadyUSBRestores().isEmpty)
        #expect(calls == [2]) // full shutdown's restore-all owns A's obligation
    }

    @Test func olderDeferredCallbackCannotReleaseAReadmittedAttempt() throws {
        var state = CaptureLifecycleOwnership()
        let lease = CaptureResourceLease()
        let enqueued = state.deferUSBRestore(entryID: 1, lease: lease, reusing: nil) { _ in }
        #expect(enqueued)
        let first = try #require(state.takeReadyUSBRestores().first)
        // During callback 1 a new drain forces requeue. That drain finishes and
        // admits callback 2 before callback 1 reaches its completion check.
        _ = state.deferUSBRestore(entryID: 1, lease: CaptureResourceLease(), reusing: lease) { _ in }
        let second = try #require(state.takeReadyUSBRestores().first)
        #expect(second.attempt == first.attempt + 1)
        #expect(!state.completedUSBRestoreAttempt(lease.token, attempt: first.attempt))
        #expect({ !state.reserveSource(id: "replacement", entryID: 1, lease: CaptureResourceLease()) }())
        #expect(state.completedUSBRestoreAttempt(lease.token, attempt: second.attempt))
        _ = state.release(lease.token)
        #expect(!state.permitsUSB(sourceID: nil, entryID: 1, excluding: lease.token))
    }
}
