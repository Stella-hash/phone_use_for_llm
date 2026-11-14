# iOS USB source preview validation

Codex-E · `Stella-hash/phone_use_for_llm` · 2026-11-14.
Status: HOLD / draft after review of `7aff1e1`; repairs await independent review of the new PR head. No binary/package release.
Initial review base: `41651b77369033958d551a73d43f571fcd92cfb8`; updated by a
normal merge from `main@169cbb79ee4fdef54852c766f9179f4927b9e53c` after Android
PR #13 landed. The iOS source recipe is unchanged by that merge.
Native input: `YueChen-C/iPhone-use@577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c`
plus ordered patches 0001–0043. The PR head identifies the integration revision.
This page adds iOS evidence; it does not supersede the Android validation records.

## Remediation after the 7aff1e1 review

Patch 0043 replaces the managed AV capture selector with a physical USB screenshot
read from the same exact UDID as input. It verifies the sole USB attachment before
and after screenshots and immediately before input commit. Managed startup and
shutdown do not enter the old AV/Valeria/Bluetooth lifecycle. Mismatched legacy
capture/USB configuration is rejected before a helper or clipboard operation.
The native tree is `fbbf99283c329740dea740fda893b2dcdf8ef4e1`.

The same patch separates HID and clipboard effects, compares OCR against retained
pre-input pixels from the current call, and marks every internal screenshot as
observation-only. Only standalone screenshots mint touch references. The private
assistant caller was migrated to explicitly fetch one before its next input.
The direct ungated touch helper path is removed. Python runs isolated with the
complete hash locks; launcher/native UDID formats agree. Dynamic HTTP responses
carry `Cache-Control: no-store`.

Local acceptance: 23 launcher tests, 64 offline AX tests, 44 USB helper tests,
and 142 isolated Swift tests in 18 suites passed. All seven physical-target tests
passed, including capture A / USB B, wrong device, legacy AV token, changed USB
attachment during capture/preflight, and a full 128-reference cache. Swift tests
also cover clipboard uncertainty, same-call OCR and native Home commit/receipts.
The final guide/skill edits do not change those tested production files.

A dedicated USB iPhone on iOS 26.5 supplied real screenshots from the physical
service (observed standalone calls approximately 0.75–1.47 seconds). A frame-bound
tap navigated Settings. Clipboard text was visible in the search field after the
system paste confirmation; HID and clipboard statuses remained separate. The
previous Command-H Home shortcut and a system-edge swipe did not leave that field.
Home now uses the existing native USB button through the same target/commit guard,
and was observed to return to the Home screen. No raw device evidence or identifiers
are exported. No native AX tree was fetched during this remediation.

Some 3-second post-input observations timed out while returning a useful current
image; that does not mean input failed or that the app completed. Action images
contained no touch token. System paste permission remains an OS interaction and
is not bypassed. Multi-iPhone operation, other iOS/device combinations and universal
system-gesture behavior are not established by these observations.

Hosted CI now also invokes the complete isolated Swift overlay, runs only PR
checks for task branches, and cancels obsolete runs. Full XCTest and release
protocol results must be checked on the exact new PR head; earlier green results
below are retained as historical evidence, not acceptance of these repairs.

## What is included

The independent [`ios/` entry](../ios/README.md) provides a managed USB launcher,
pinned native source recipe, deterministic AX reading, touch/keyboard helpers,
synthetic tests and upstream notices. The MCP catalog has seven tools and one
input tool, `act`. Managed configuration rejects Bluetooth selection and disabled
USB input routes. Legacy MCP tool names and their compatibility executor have
been removed; all native modes reject those names before device access. Existing
callers use the seven-tool catalog and `act.steps`; archived journal data stays
readable.

The default AX result has one full reading payload in `content[0].text` and small
status/archive metadata in `structuredContent`. Original source IDs, native parent
relationships and sparse fields remain recoverable. Local detail reads use the
same archived snapshot. No provider call is part of this compression.

The export excludes device captures, identifiers, private history, assistant
providers, background agents and application/game-specific experiments. It ships
no native executable, Python environment or combined runtime. See the separate
[iOS trust boundary](../ios/SECURITY.md) and [dependency notices](../ios/THIRD_PARTY_NOTICES.md).
Android authorization and owner-signing claims do not cover this host.

The current managed configuration has one identity, `usbDeviceId`: a physical
USB UDID shared by screenshots, AX and input. An old `captureId` is accepted only
when it exactly equals that UDID; a different AV capture ID is rejected with
migration instructions. Setup discovery enumerates physical USB devices and
rechecks the sole matching IOKit pin. It does not discover AV capture IDs, infer
an AV-to-USB mapping, enable CoreMediaIO exposure or activate a new USB
configuration. Multiple, absent, unavailable or changing devices do not produce
a candidate. Previous versions' pending restoration records still receive bounded
reconciliation; `settled` includes restored, detached and superseded outcomes.
The earlier live discovery/capture observations below belong to their stated
recipe versions; they do not validate this replacement path.

USB Python dependencies are installed into the ignored private CPython 3.12
venv from complete macOS 14+ arm64/x86_64 locks, with exact transitive pins,
SHA-256 checks and source builds disabled. The profile is selected from the
actual interpreter architecture. Hashes constrain downloaded artifacts; they are
not a security or license assessment of their contents. See the
[dependency profile and regeneration rules](../ios/USB-DEPENDENCIES.md).

## Earlier local verification (recipe through 0042)

The source recipe was assembled independently in the public checkout and built
successfully on the development Mac. Its native Git tree was
`3362be624053940f0ca2880b50511c1623d9daf9`. Patch 0040 removes unused MCP
compatibility handlers and migrates protocol/driver assertions to `act.steps`.
Both checkouts built this recipe. The 115-test native overlay and 116-test release
protocol suite passed on the same production source; the final recipe additionally
corrects a test-only numeric cast, the architecture file inventory, and the
expected-error test helper (0041) and observation HTTP fixtures (0042);
production source remains unchanged.

| Check | Observed result |
| --- | --- |
| Managed launcher, including child cancellation | 17 tests passed |
| Portable AX source and reading | 63 tests passed; exact five-case synthetic fixture set required |
| USB keyboard/touch helpers | 21 tests passed |
| Isolated production-source Swift Testing | 115 tests in 14 suites passed |
| Actual release Python protocol tests | 116 tests passed |
| Release MCP handshake | Initialize, notifications, seven tools and ping passed; clean JSON-RPC stdout |
| Android regression after merging current main | 168 tests: 163 passed, five skipped |
| Android clean-start verification | Owner setup/approval, 36 authenticated tools, delegation disabled by default, passive latency, receipt recovery and private export passed with synthetic transport |
| Android/Node production dependencies (`pnpm audit --prod`) | No known vulnerabilities reported with `fast-xml-parser` 5.12.0 (also supplied by current main); Python dependencies were not audited |

**Migration trap:** the isolated native check replaces the test directory with
selected production-source suites because the local CLT does not provide XCTest.
Its pass proves neither full-suite compilation nor full-suite success. Historical
patches and tests can describe retired APIs; do not restore an unused runtime
interface to make them pass. Preserve meaningful validation and failure tests on
the current contract. Journal decoding is separate from executable-tool support. The [iOS workflow](../.github/workflows/ios.yml)
runs full `swift test`, every suite in `ios/validation/` through
`check-native-input.mjs`, and release protocol checks on a hosted Mac. The Swift
Testing macro plugin is resolved from the selected Swift toolchain, supporting
both Command Line Tools and full Xcode layouts. CI pushes are limited to `main`;
pull requests retain coverage, and each workflow/ref cancels superseded runs.
CodeQL analyzes JavaScript/TypeScript and Python only; it does not analyze Swift.
Swift coverage here comes from the native test workflows, not CodeQL.
Read hosted results at the exact PR head; local success is not a hosted pass.
The first hosted full-suite compilation exposed stale localization tests that
referenced retired normalized-coordinate strings and the old tool catalog.
Patch 0038 updates those tests to the seven-tool, nested `act` and frame-bound
contracts, retaining bilingual schema/validation coverage. It adds no legacy
runtime interface or test skip. The following full run exposed three remaining
legacy routing assertions; 0039 tests frame-bound MCP → JSON HTTP → USB contact
program behavior and rejection of normalized/unbound input. The old pointer
driver's continuous-drag regression remains a separate driver-level test.
The next run reached 541 XCTest cases with nine failures in one newly migrated
assertion: contact IDs generated alongside coordinates were `Double(0)`, not
Swift `Int`. Patch 0040 compares the exact numeric value and retains contact
count, endpoints and final all-up checks. It also migrates all successful Python
protocol inputs to explicit `act.steps`; the generic test exchange is unchanged.
Valid old-tool payloads are rejected in both USB and non-USB modes with zero
HTTP requests and a not-sent receipt. No tests are skipped to retire these APIs.

The 0040 hosted run compiled and executed 542 XCTest cases plus 28 Swift Testing
cases. All 96 failures originated in the same new `actRequest` test helper:
wrapping a throwing validator inside `XCTUnwrap` records an unexpected failure
before an outer `XCTAssertThrowsError` can inspect it. Patch 0041 evaluates the
validator first, then unwraps its optional result. Every successful-input and
invalid-input assertion remains; production source is unchanged. The corrected
full suite must be read at the new head, not inferred from the earlier run.

The subsequent hosted head passed all 542 XCTest and 28 Swift Testing cases.
Its release protocol run had one error among 116 tests: a 0.2-second fixture
assumed an observation HTTP request started before the window elapsed. The
runtime may legitimately exhaust that window before its first capture GET, in
which case no HTTP error detail exists. Patch 0042 gives the integration fixture
a five-second window, confirms that the action GET entered the mock service,
and holds its response with an Event until the HTTP timeout. Only after reading
the action result does the same MCP process request recovery, so that recovery
cannot masquerade as the tested GET. A related 503 fixture also confirms an
actual GET. All timeout classification, not-replayed input, receipt and recovery
assertions remain; minimum/maximum budget validation remains in native tests.
The two fixtures passed three consecutive runs (6/6), and the full local release
suite passed 116/116 in 68.642 seconds. No production code, retry or skip changed.

The actual loopback listener accepted passive status and the same-origin viewer.
It rejected foreign Host, cross-origin input, cross-site screenshot and non-JSON
input requests before routing, with `input_sent:false`. An incomplete-body
connection closed at EOF and the listener remained responsive. These browser
admission checks do not authenticate trusted local processes.

## Device evidence and limits

With the reading/USB recipe through patch 0035, on one dedicated iPhone 15 running
iOS 26.5, fresh managed clients exercised
screenshot/frame-bound touch, Settings navigation, Unicode clipboard input and
native AX field readback. A same-snapshot archived detail read also succeeded.
Those observations are device acceptance, not a complete OS/hardware matrix.
Real screenshots, raw AX and identifiers remain private.

With the 0037 recipe, the independently built public host returned a fresh
Home screenshot with matching client/host executable identities, and USB Home
input plus its following image succeeded. A Home AX read returned an explicit
timeout/unavailable result. The private development host initially had empty
capture inventory after restart; after a public-host comparison, its unchanged
binary/configuration again captured Home successfully. This does not establish a
repair for intermittent capture startup, and no speculative recovery was added.
Final private-host Settings navigation and AX reading also succeeded with 0037:
12 reading nodes, one text payload, and metadata without duplicated nodes. The
phone was returned to Home after verification.

The 0040 recipe also completed a fresh managed-client check: client and host
native identities matched; USB touch plus Unicode clipboard input in one `act`
batch produced the visible Settings search result. A frame-bound tap opened
Settings, then AX returned status `ok`, 12 reading nodes, one text payload and
metadata without duplicate nodes. An old `home` tool call returned not-sent with
zero requests started/acknowledged; current `act` Home visibly returned to Home.
Startup again temporarily reported empty capture
inventory. After managed stop/discovery/start and a bounded recheck, capture
returned. This observation does not identify or repair that intermittent cause.

Configuration-free discovery returned one USB/capture candidate matching the
existing local configuration without input, Bluetooth, pairing or a config write.
The configurator returned `not_activated`, then bounded polling found the capture
device; `cleanup` was `not_needed`. This is not evidence of no activation attempt,
or acceptance of a successful temporary configuration switch and restoration.
That branch, cancellation and cleanup outcomes have synthetic test coverage and
still require cold-device acceptance. A candidate is inventory
evidence, not proof that normal capture will start or remain available.

Known limits include intermittent capture interruption, editor-dependent keyboard
modifiers and paste permissions, incomplete/non-atomic AX, frames without an age
expiry or orientation epoch, and no task ownership across clients. Observe again
after an uncertain input; do not replay it. Existing MCP processes must reconnect
after native updates to load the new executable.

Background delegation is deferred: per-call input serialization does not give a
background task ownership across model waits and competing clients. No additional
transport or task-control tool is exposed by this preview.

## Review and release boundary

The repository is already public. This candidate is a reviewed source addition on
a task branch, not a visibility change of a private repository, a merge to `main`
or an announcement. Keep the draft pending exact-head review and hosted checks.
Source scans inspect the selected public tree; they do not inspect or certify the
excluded private history. Narrow scanner exceptions name synthetic test markers
and a pinned upstream Git SHA, not real credentials.

Keep `package.json` private. A future combined binary/environment distribution
needs its own dependency-license review; the separately installed GPL dependency
does not become MIT merely because these integration modules use MIT terms.
