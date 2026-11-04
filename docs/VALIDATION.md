# Baseline release candidate validation — 2026-11-04

Historical scope: baseline `e600879c80284496c9aa837519f8e3648e818613` before the
second review repair. Current status is in [R2 validation](R2-VALIDATION.md).
This baseline record contains no
real device observations, private configurations, raw activity logs or red-team
report material.

## Reproduction and result

Environment: Windows, Node.js 24.22.1, pnpm 11.25.0. Selected source, tests, skills,
helper sources and package metadata were copied to a fresh directory containing
no `.env`, `node_modules`, build output, Git history or device data. Installation
used the lockfile and the package manager's ordinary dependency cache. Source
files were compared byte-for-byte against the final candidate after validation.

| Check | Result |
| --- | --- |
| `pnpm install --frozen-lockfile` | Passed, one pnpm lockfile |
| `pnpm build` | Passed |
| `pnpm test` | 70 tests: 69 passed, 0 failed, 1 skipped |
| `pnpm verify:clean` | Passed with generated owner keys, strict signed input, 26 authenticated tools, receipt recovery and private SQLite export |
| `pnpm audit --prod` | 0 known advisories at validation time |
| Bundled skill validation | Both skills passed format validation; instructions reviewed against the new authorization and retention behavior |
| Publication-content review | Selected-file migration; no old Git history, runtime data, credentials, reports or private play examples copied; targeted secret/private-path patterns had no findings |

The skipped test is the POSIX shell-based subprocess-deadline check on Windows.
This is not a claim of Linux/macOS or physical-device acceptance. No phone, NAS,
home-network service or account was contacted. Model requests were mocked.
Pattern scanning is limited evidence, not proof that arbitrary secrets can always
be detected.

## Defensive coverage

- Missing security configuration fails before listener/device work. Authentication
  protects health, discovery, tools and archived images. Data directories reject
  a different owner or unbound existing contents.
- An exact, expiring Ed25519 approval binds all arguments and the request ID.
  Altered calls and caller identity claims do not grant authority. Game and expert
  grants remain limited by explicit app/tool scope; power still needs approval.
- Locked and unknown lock states reject UI reads/input, including with the old
  auto-wake environment flag set. Sleeping screens do not wake for UI reads.
  Focus/lock changes after input suppress UI capture while preserving its receipt.
- Unauthenticated requests, batches, oversized bodies/fields, excessive collections
  and XML depth fail within explicit limits. Removed legacy tools are not exposed.
- Input failures do not return or persist the original text. A full queue rejects
  additional work. Optional model responses are bounded before parsing and are
  never echoed on errors.
- Source expiry leaves a replay tombstone. Ledger exhaustion rejects new actions;
  journal admission failure still allows a saved-receipt read. Owner-only image
  storage rejects path substitution and expires evidence without using ADB.
- A dropped image response recovers the original acknowledgement by request ID.
  Duplicate/concurrent retries do not repeat input. Invalid or unavailable PNGs
  preserve the action receipt, and deferred images do not require another touch.

Existing reading-cursor, media-index, image-scaling, continuous-gesture, Unicode
XML, Chrome identity/coordinates, deadline and visual-judgment tests also passed.
No exploit chain, vulnerability PoC or live adversarial experiment was performed.

## Decisions and remaining review boundary

One owner's clients deliberately share history; this service does not promise
cross-client tenancy. Actor/session strings are not authenticated principals.
This preserves shared-device continuity while keeping a real owner boundary.

Arbitrary touches cannot be semantically classified as movement, purchase or
publication. Strict inputs require separate owner approval; owner-granted games
and expert sandboxes require disposable scope. App/Chrome checks do not enforce
device networking, embedded WebView URLs, redirects already followed, or atomic
UI state. Protect the host/ADB and isolate the device network separately.

No deployed household service, helper APK, personal skill installation or private
history was changed. This repository is a separate release candidate, not a
deployment or a security certification. The optional model interfaces have no
new live availability or quality evidence. The companion APK was not rebuilt or
installed during this synthetic-only repair.

The smallest next step is an independent review of this exact commit, especially
the owner grant boundary, recovery under failure and publication contents. Decide
on public release only after that review; physical compatibility needs a separately
authorized dedicated-device check.
