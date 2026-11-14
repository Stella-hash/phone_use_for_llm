# iOS USB source preview validation

Codex-E · `Stella-hash/phone_use_for_llm` · 2026-11-14.
Status: source preview prepared for independent review; no binary/package release.
Initial review base: `41651b77369033958d551a73d43f571fcd92cfb8`; updated by a
normal merge from `main@169cbb79ee4fdef54852c766f9179f4927b9e53c` after Android
PR #13 landed. The iOS source recipe is unchanged by that merge.
Native input: `YueChen-C/iPhone-use@577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c`
plus ordered patches 0001–0039. The PR head identifies the integration revision.
This page adds iOS evidence; it does not supersede the Android validation records.

## What is included

The independent [`ios/` entry](../ios/README.md) provides a managed USB launcher,
pinned native source recipe, deterministic AX reading, touch/keyboard helpers,
synthetic tests and upstream notices. The MCP catalog has seven tools and one
input tool, `act`. Managed configuration rejects Bluetooth selection and disabled
USB input routes; legacy native MCP input aliases are inaccessible in that mode.

The default AX result has one full reading payload in `content[0].text` and small
status/archive metadata in `structuredContent`. Original source IDs, native parent
relationships and sparse fields remain recoverable. Local detail reads use the
same archived snapshot. No provider call is part of this compression.

The export excludes device captures, identifiers, private history, assistant
providers, background agents and application/game-specific experiments. It ships
no native executable, Python environment or combined runtime. See the separate
[iOS trust boundary](../ios/SECURITY.md) and [dependency notices](../ios/THIRD_PARTY_NOTICES.md).
Android authorization and owner-signing claims do not cover this host.

## Local verification

The source recipe was assembled independently in the public checkout and built
successfully on the development Mac. Its native Git tree was
`5dbbfab6f3b7c46421c8ccff252fb33ea2501282`. Patches 0038–0039 change native tests only;
the device-tested runtime source is unchanged from the 0037 recipe.

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

The isolated native check replaces the test directory with the selected production
source acceptance suites because the local CLT does not provide XCTest. It is
not a full native suite result. The [iOS workflow](../.github/workflows/ios.yml)
runs full `swift test` as well as release protocol checks on a hosted Mac.
Read hosted results at the exact PR head; local success is not a hosted pass.
The first hosted full-suite compilation exposed stale localization tests that
referenced retired normalized-coordinate strings and the old tool catalog.
Patch 0038 updates those tests to the seven-tool, nested `act` and frame-bound
contracts, retaining bilingual schema/validation coverage. It adds no legacy
runtime interface or test skip. The following full run exposed three remaining
legacy routing assertions; 0039 tests frame-bound MCP → JSON HTTP → USB contact
program behavior and rejection of normalized/unbound input. The old pointer
driver's continuous-drag regression remains a separate driver-level test.

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

With the final 0037 recipe, the independently built public host returned a fresh
Home screenshot with matching client/host executable identities, and USB Home
input plus its following image succeeded. A Home AX read returned an explicit
timeout/unavailable result. The private development host initially had empty
capture inventory after restart; after a public-host comparison, its unchanged
binary/configuration again captured Home successfully. This does not establish a
repair for intermittent capture startup, and no speculative recovery was added.
Final private-host Settings navigation and AX reading also succeeded with 0037:
12 reading nodes, one text payload, and metadata without duplicated nodes. The
phone was returned to Home after verification.

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
