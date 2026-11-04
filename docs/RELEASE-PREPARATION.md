# Public release preparation

Status: private integration into `main`; no public release approval. Project: phone-use for LLMs.
Maintainer: the repository owner, public handle `Stella-hash`.

## Owner decision: license for new work

The existing upstream MIT notice remains intact. The owner approved the following
additional notice for the new implementation:

> Copyright (c) 2026 Stella-hash and contributors

Owner decision on 2026-11-04: apply the existing MIT terms to the new work as well, while
preserving the upstream attribution in LICENSE and a separate NOTICE file.
The license and attribution decision is complete. Public release still requires
independent review of the repaired commit and the remaining publication gates.

## Publication boundary

Publish reviewed GitHub source only. Keep `package.json` private; no npm package
or prebuilt helper APK is an approved distribution. A reviewed source commit,
independent review, security reporting route, scans and repository protections
are required before announcement. No private reports or raw operational evidence
belong in the public tree.

## Integrate privately, then review the final change range

The independently reviewed R2 repair is
`e396c4879d79cad3a2bbff67ccdf57b5600cebe5`. E reported the three earlier blockers
closed and a conditional GO. Sol's documentation review and seven-file update are
preserved in [PR #1](https://github.com/Stella-hash/phone_use_for_llm/pull/1), at
`f604547c8bfdc982f0530e924759634256dce2b0`. Their acceptance applies to those
inputs, not automatically to subsequent changes. The private reports and raw
operational evidence remain outside this repository.

On 2026-11-04, the owner authorized final cleanup and integration into `main`
while keeping the repository private. `main` is the selected integration/default
branch, replacing the older `gc/public-hardening` entrypoint. Keep the existing
review commits and branches; do not rewrite their history. Future changes should
use task branches, with checks and review bound to the precise resulting commit.

The final change range adds:

- `argsDigest` privacy disclosure in README, SAFETY and its source definition;
  the digest and signing formats are unchanged.
- An exact expert-grant allowlist shared by config validation, runtime
  authorization and public tool descriptions. Unknown and legacy names cannot
  become dormant grants for a future tool.
- An outer owner-signer cleanup guard and publication after successful review
  cleanup. A complete private staged file replaces an exclusively reserved empty
  output atomically, so existing output is preserved and handled write/rename
  failures issue no approval. Persistent cleanup denial stops publication and
  may leave a protected review snapshot for owner cleanup. Forced termination,
  power loss and an untrusted host account are not covered by this guarantee.
- Synthetic regressions for early review-write failure, cleanup failure, staged
  write failure, publication failure, existing output and unknown grant names.

Builder validation on Windows: build passed; the full suite had 93 passes and
one existing POSIX-only subprocess-deadline skip (94 total); the focused signer
and security suite passed 34/34. `verify:clean` passed setup, exact approval,
default startup, authenticated tools, bound receipt recovery and private export
using generated owners and synthetic transport. Production dependency audit
reported no known vulnerabilities. The seven integration documents passed 36
relative-link/anchor checks. Two source scanners passed the staged tree. Hosted
matrix results must be read at the resulting commit; private CodeQL is skipped,
not passed. No real phone, model service or household deployment was contacted.

Review this final range at the exact `main` SHA before publication. E's earlier
conditional GO is not a review of this new range. Builder tests also do not
establish physical-phone acceptance.

## Order the hosted gates explicitly

Some hosted controls are unavailable to this private candidate under its current
GitHub access. [R2 validation](R2-VALIDATION.md) records those limits. Do not count
an unavailable or skipped check as passed, or change visibility merely to obtain
a green badge.

Whether to remain private with supported controls or arrange a controlled public
transition is still an owner decision, not an adopted release route or a passed gate.

1. **While private:** complete independent review of the intended source,
   preserve license/attribution, run available synthetic checks and source scans,
   and agree on the exact public commit and reporting/protection plan.
2. **Before any visibility change:** obtain an explicit owner publication
   decision. Prefer resolving hosted controls while private where supported. If
   that is not available, any staged public transition needs the owner's explicit
   acceptance of the remaining hosted gates and a plan to resolve them. Changing
   visibility is already public disclosure, not a private staging step; making a
   repository private again cannot recall copies. Without that decision, stay private.
3. **Before announcing a release:** verify branch protection on the chosen
   public entrypoint, enable and test private vulnerability reporting, and obtain
   successful source validation and CodeQL results for the reviewed public commit.
   Verify continuous secret scanning and its alert route as well; source-tree
   scanning in CI does not establish the hosted platform setting.
   The current CodeQL workflow intentionally skips private repositories. Record
   actual results and update the candidate status only after the gates are met.

This checklist does not perform or authorize a visibility change. No npm package
or prebuilt helper distribution is added by completing it.
