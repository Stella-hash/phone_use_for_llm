# Public release preparation

Status: private candidate; no release approval. Project: phone-use for LLMs.
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

## Finish review before selecting the public entrypoint

The R2 repair candidate is `gc/red-team-r2` at
`e396c4879d79cad3a2bbff67ccdf57b5600cebe5`. At the documentation review on
2026-11-04, the default branch was still `gc/public-hardening` at the older
`e600879c80284496c9aa837519f8e3648e818613` baseline. A green check on the R2
branch does not update what a visitor receives from the default branch.

Before release, the owner must deliberately integrate the approved repairs and
documentation, choose the public default branch, and review/check that exact
resulting commit. Refresh candidate-specific setup wording at that point.
An independent documentation/source review is evidence for that decision, not
authorization to merge, publish, or claim physical-device acceptance.

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
   The current CodeQL workflow intentionally skips private repositories. Record
   actual results and update the candidate status only after the gates are met.

This checklist does not perform or authorize a visibility change. No npm package
or prebuilt helper distribution is added by completing it.
