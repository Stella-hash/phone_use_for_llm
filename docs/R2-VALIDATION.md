# Second review repairs — 2026-11-04

Status: private candidate; local builder verification passed. Independent review
of the final commit is required before public release. Baseline:
`e600879c80284496c9aa837519f8e3648e818613`; repair branch: `gc/red-team-r2`.
This record documents defensive changes and synthetic evidence, not a private
review report, device history or exploit reproduction.

## Repairs and their limits

| Boundary | Change |
| --- | --- |
| Keys | One normalizer for signing, authorization, execution and receipt binding. Every key requires exact approval; expert key pregrants are rejected at configuration load. |
| Chrome | Generic Chrome launch is denied before launch; explicit open validates the allowed URL before dispatch. Failed post-checks return `policy_drift` while preserving execution acknowledgement. Only the supported Chrome package can be configured as the browser. |
| Recovery | Passive reads cannot reserve IDs. Action ledger entries retain tool and normalized argument digest through source expiry. Recovery clients verify both. Known legacy passive reservations are released; expired unknown entries remain replay-blocked. |
| Owner signer | Reject duplicate JSON keys; review a normalized read-only snapshot under the human signer directory, then compare file identity and digest after confirmation. The trusted signing OS account is outside the adversarial boundary. |
| Text | ASCII and helper input run lock/focus/Chrome identity post-checks without returning typed UI text or screenshots. Failed checks preserve acknowledgement and report an error. Host/app state is not an atomic transaction. |
| Transport | Startup and doctor use one local serial validator, rejecting network addresses and wireless ADB mDNS/TLS forms without discovery. |
| Helper | Fresh classes/dex per build, checked toolchain metadata, explicit development or owner signing, non-debuggable release manifest, verified-before-copy output. Synthetic packaging sinks only; no actual SDK/phone acceptance or prebuilt APK release. |
| Usage | Real financial/identity/health/work/security-account workflows are prohibited in every public profile; article reading is logged-out or unfunded disposable/test read-only scope. This is a deployment contract, not a claim that coordinates reveal transaction meaning. |
| Distribution | Owner approved MIT for new code with Stella-hash and contributors attribution. Upstream notice retained. `private: true` stays; GitHub source only. |

## Verification

Windows, Node.js 24.22.1, pnpm 11.25.0, Python 3.11. An indexed source tree was
exported without `.env`, dependencies, prior runtime files or Git history. A fresh
pnpm store downloaded all 105 packages (zero reused). No private configuration or
phone/model environment was used.

| Check | Observed result |
| --- | --- |
| Frozen cold-cache install and build | Passed |
| Complete Node suite in source export | 87 tests: 86 passed, zero failed, one POSIX-only subprocess test skipped on Windows |
| Actual clean setup/start/approval/recovery/export | Passed with generated owners and synthetic ADB; the local `--recover` client verified the bound receipt |
| Production dependency audit | Zero known advisories at verification time |
| Gitleaks 8.30.1 | Passed on the precise Git source export; official binary checksum verified |
| detect-secrets 1.5.0 | No unreviewed findings on the same export; nine explicit non-secret fingerprints plus exact lockfile SRI hash forms accounted for |
| Workflow syntax | actionlint 1.7.12 passed; official binary checksum verified |
| Bundled reading skill | Format validation passed; public account scope reviewed |

The first full run hit two 5-second fixture-startup timeouts during concurrent
Windows ACL checks. Only the fixture startup allowance changed to a bounded 20
seconds; production action deadlines remain unchanged. The complete source-export
suite then passed. Clean-start verification exposed synchronous child helpers
blocking connection lifecycle processing; async helpers fixed it without retrying
input. Clean-start and local receipt-client checks passed again after that fix.

Hosted Windows subsequently found a real provisioning gap: directory ACLs passed,
but newly created files did not pass the individual-owner check. Path/descriptor
identity metadata agreed. Windows elevated tokens can default object ownership
to an administrator group; see Microsoft's [object ownership documentation](https://learn.microsoft.com/en-us/windows/win32/secauthz/owner-of-a-new-object).
New private files and SQLite files now explicitly receive the current user owner
and the same user/SYSTEM-only DACL. Read checks remain strict. A dedicated snapshot
test was added; the focused file, signer and journal tests all passed locally.
The final hosted suite includes that additional test (88 total); use the exact
commit's checks for its outcome, rather than the earlier local count above.

Repeat the two source scans with `python scripts/scan-source.py HEAD GITLEAKS_BINARY`
in an environment containing detect-secrets 1.5.0. The fingerprint exceptions in
`scripts/secret-scan-baseline.json` carry reasons; no entire source file is skipped.
Neither scanner proves absence of every possible secret.

CI definitions use pinned action commits, minimal permissions and generated
synthetic owners; no phone/model/signing credentials. Hosted results are attached
to their exact GitHub commit and are separate from these local observations.

Tests and source scans do not establish physical-device compatibility, deployment
safety or independent reviewer acceptance. The original household checkout,
deployment, private skills and play records are outside this repair.

## Hosted publication gates

GitHub authenticated metadata confirmed the repository is private on 2026-11-04.
The private repository's branch-protection endpoint returns HTTP 403 requiring
GitHub Pro or public visibility. Private vulnerability reporting is unavailable
here. Do not change visibility just to claim these checks have passed.
Dependabot vulnerability alerts and security-update PRs are enabled. Actions'
default token permissions are read-only and workflow PR approval is disabled.

After independent review, the owner must arrange branch protection (paid private
support or a controlled visibility change), enable and verify private vulnerability
reporting, and obtain successful hosted checks at the reviewed commit before
announcement. CodeQL is configured for public visibility; it is explicitly skipped
while the private candidate lacks GitHub Code Security. No CodeQL result is claimed.

Recommended next decisive action: independent targeted review of the final SHA,
especially normalization, pre-launch validation and request binding. Keep private
until that review and the publication gates are resolved.
