# Deployment boundary

This release candidate is for a dedicated, disposable Android device. It has
not received independent approval for public release. No fixture test establishes
production safety or compatibility with a particular physical phone.

Use a trusted, patched host, USB connection, disposable accounts and an isolated
network. Do not use a daily-driver phone with real banking, identity, health,
work, security settings, private messages or irreplaceable data. ADB and Chrome
debugging are privileged capabilities. Host administrators and processes running
as the service OS account can bypass this service; protect that account and keep
the human approval key away from agent-accessible files.

Current-version prohibition in every profile, including signed and expert input:
do not use real banking, brokerage/trading, payments, identity verification,
health records, workplace accounts, account recovery or security administration.
Owner approval does not make these supported workflows. Market/news reading,
including moomoo, is limited to logged-out pages or an unfunded disposable/test
read-only account without trading or payment authority. Do not enable grants on
a device holding real accounts. Package checks cannot detect every such context.

The bearer token authenticates a single owner. Every authorized client of that
owner shares history/images and one phone; actor/session fields are not tenant
boundaries. Use separate processes, tokens, data directories and devices for
separate owners. Loopback and tunnels alone do not authenticate requests.

The strict profile requires short-lived, exact-request, independently signed
owner approval for input. Local owner game/expert grants are explicit exceptions.
Generic touch coordinates cannot classify a purchase or message; do not turn a
disposable sandbox into a sensitive account environment while keeping its grants.
Phone-side changes can occur between checks; there is no atomic transaction over
the owner, OS, app and UI. The service stops when lock, focus or Chrome identity
cannot be established. It never dismisses a keyguard. The owner enters credentials
directly with the service/ADB disconnected when appropriate.

App allowlists restrict live UI operations to the focused package. Chrome URL
checks restrict returned observations and explicit opens to configured HTTPS
domains and expected URLs. They do not control native app networking, embedded
WebViews, browser redirects already followed, DNS, installed app behavior or
device-side backups. Enforce network isolation outside this program. Other
browser engines do not have a supported domain-aware observation adapter.

Raw input text is omitted from this service's journal and diagnostics; that says
nothing about app/Android logs, keyboard learning, screenshots taken elsewhere,
backups or future independent observations. `context.private` is an archival
choice, not authentication or a general incognito detector. Password masking
catches known password controls, not arbitrary secret-looking content.

New screenshots live only in owner-protected host storage. Data, SQLite sidecars
and images have size/count/retention limits. Automatic expiry runs while the
service is running; exports, client image copies, filesystem snapshots and
backups need owner retention. Secure deletion is best effort and does not prove
erasure from SSDs or backups. The replay ledger deliberately retains request
hashes after source expiry, then stops new ID-bearing operations at capacity.
History is operational evidence, not a tamper-proof audit log.

Optional summaries and explicitly invoked visual judging send data to an external
model provider. A key alone never enables background summaries. Review retained
content and enable egress deliberately. Models cannot grant authority or resolve
uncertain input execution by guessing.

On a suspected boundary failure: stop the service, disconnect the device/ADB,
preserve a minimal private record, and rotate exposed credentials as appropriate.
Do not publish raw screenshots, tokens, config files or personal logs in issues.
Report a minimal synthetic case without exploit chains or private target data.
See [SECURITY.md](SECURITY.md) for the reporting and release gate.

The software is supplied under the [MIT License](LICENSE). It carries no warranty;
read its disclaimer and evaluate your own deployment obligations.
