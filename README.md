# phone-use for LLMs

Give an LLM a phone, and leave room for something interesting to happen.

Read an illustrated article together. Try a puzzle. Follow a detail neither of
you planned to look for. A phone can be a place for a human and a language model
to explore, not only a device on which to finish errands.

**phone-use** connects a dedicated Android phone to your chosen MCP-capable
client. It provides screen text, images and controls; the person and model using
it choose what to do with them. Small pieces of infrastructure keep the mechanics
from taking over: reuse text already obtained, look at a useful post-action
frame, and recover a dropped response without repeating the touch.

This is a self-hosted developer project, not a one-click companion app. You need
a trusted computer, a USB-connected Android phone, and a client able to reach the
computer's authenticated local MCP endpoint. It does not include a language
model, a hosted connector, or an unattended controller.

**0.11 is available as public GitHub source.** Check the
[validation runs](https://github.com/Stella-hash/phone_use_for_llm/actions)
attached to the exact commit you deploy. It defaults to one
authenticated owner and per-input approval, with explicit opt-in grants for
appropriate games and empty sandboxes. Use a dedicated, resettable spare phone
without real accounts or irreplaceable data, and an isolated host/network. Here,
"disposable" describes the data and setup, not an invitation to discard hardware.
This repository contains code and synthetic fixtures, with a fresh Git history;
it does not import private device data, credentials or activity logs.

## Find your way in

- **Why give an LLM a phone?** Read [A small place to explore together](docs/WHY-A-PHONE.md)
  or [中文：留一小块可以一起探索的地方](docs/WHY-A-PHONE.zh-CN.md).
- **Ready to try it?** Start with [a first small outing](#a-first-small-outing),
  then the [setup instructions](#install-and-configure-the-strict-default).
- **Setting the boundaries?** [SAFETY.md](SAFETY.md) explains the deployment;
  [AGENT-SAFETY.md](AGENT-SAFETY.md) is the contract for the model operating it.
- **Reviewing the code?** See the current commit's checks and the historical
  [R2 validation](docs/R2-VALIDATION.md) and
  [release preparation](docs/RELEASE-PREPARATION.md) records. Synthetic checks are not
  physical-phone acceptance or a security certification.

## Choose a starting point

All three choices need owner setup. Broader permissions are optional, not a
requirement for a worthwhile first experience.

| Start with | What this makes room for | What remains deliberate |
| --- | --- | --- |
| Look together | Manually open an allowed page and let the model observe and discuss it | The phone is awake and unlocked; inputs still need exact-request approval |
| One offline game | Let the model try moves within a selected game using an [explicit game grant](#explicit-game-grants) | No real accounts, purchases or messages; only the selected touch tools are preapproved |
| A wider empty sandbox | Give trusted operators more room within exact app/tool scope using [expert grants](#expert-sandbox-broader-owner-authorization) | Authentication, app checks, receipts and quotas stay; all keys and explicit wake still require separate approval |

The strict starting point does not mean a human must sign every swipe forever.
A grant is an owner's advance decision about a specific, suitable space, not
permission for an agent to widen its own access.

## What it does

| Workflow | Capability |
| --- | --- |
| Observe | Native UI text, blank editable controls, bounded PNG previews, focused Chrome DOM/accessibility text and CSS bounds |
| Act | Tap, double tap, long press, swipe, drag, continuous paths, ASCII/Unicode input, keys and orientation |
| Wait | Optional 0–5000 ms delay before the post-action frame; elapsed time is never called completion |
| Recover | Query a caller-chosen request ID after transport failure; a recorded ID never executes another input |
| Keep a reading place | Saved-text overlap for Xiaohongshu post captions and moomoo CA articles; observed image index/total remain separate from text position |
| Resume | Single-owner history and optional source-linked model summaries |
| Keep a moment | Optional named screenshot keepsakes in host storage, with a separate budget and owner export |
| Inspect an animation | Optional 1–5 second silent clips, actual frame timestamps and copied clip/frame keepsakes |
| Monitor | Power, battery temperature and framework thermal status without waking or reading UI |

Reading cursors do not choose interests, scroll automatically, or nag about unseen
pictures. Games still need an operator to choose moves and judge outcomes. The
core service and the two bundled [skills](skills/) need no additional model API
key. Your chosen client's model access, costs and data handling are separate.
Live native text, screenshots and Chrome reading are distinct from the
app-specific saved-text cursor; the cursor is not universal OCR or image
comprehension. Market reading is limited to the logged-out or disposable,
unfunded read-only scope in [SAFETY.md](SAFETY.md).

## A first small outing

Once setup is complete, begin with something you would not mind resetting: one
offline puzzle, or a public page in an allowed app or supported Chrome tab.

1. Choose the space together. The owner configures the exact app/domain scope,
   unlocks the phone and opens it manually. Leave optional summaries off for now;
   the saved-text cursor also needs a separate retention choice if you want it.
2. Start by looking. Ask the model what it can actually see and what catches its
   attention. No input grant is needed for an allowed observation. A current view
   matters more than an old screenshot or a guessed position.
3. If you want to continue, approve one exact input, or configure a suitable
   game grant before playing. Look at what happened afterward. If the response
   disappears, recover its receipt rather than repeating an uncertain touch.
4. Stop when you have had enough, and talk about what was interesting. The owner
   can put the phone to sleep manually. An interesting question or a failed puzzle
   is a perfectly reasonable thing to bring back.

Ordinary screen text and images go to the connected MCP client and may then go
to its model provider. Review that client's data settings before the outing;
running this service on localhost does not make the whole interaction local.

## Install and configure the strict default

Use `main` for the integrated source. Historical review scope and validation
limits are recorded in [release preparation](docs/RELEASE-PREPARATION.md) and
[R2 validation](docs/R2-VALIDATION.md); use the checks attached to the exact commit
you deploy. The commands below assume you are already in that source checkout.

Requirements: Node.js 24 or newer, pnpm 11.25.0, and Android platform-tools for
actual device use. Windows and POSIX permission handling differ; see validation
limits in [docs/VALIDATION.md](docs/VALIDATION.md). Tests also need Python 3.11+
for synthetic helper packaging checks; no SDK is needed.

```sh
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm verify:clean
```

`verify:clean` runs the actual startup and owner setup/approval commands using a
fake device transport and newly generated credentials. It requires no existing
`.env`. It never enumerates or contacts a real phone.

Create two **empty** directories outside the checkout. The signing directory
belongs to the human owner; do not mount it into the agent/client environment.
The host and signing account must remain trusted: two folders alone do not
isolate an unrestricted shell agent running as the same OS account. Use absolute
paths appropriate to your OS:

```sh
node scripts/owner-setup.mjs /absolute/service-directory /absolute/owner-signing-directory owner
```

This creates owner-only permissions (POSIX modes or Windows ACLs), a bearer token,
an Ed25519 approval key pair and `security.json`. The private signing key is outside
the service directory; the service reads only its public key. Keep both directories
out of shared folders, source control and untrusted backups.

Edit the generated `security.json` as the owner:

```json
{
  "allowedApps": ["org.example.game"],
  "allowedDomains": [],
  "retainObservationText": false,
  "allowModelSummary": false,
  "gameGrants": []
}
```

This is a **partial example**: preserve the generated owner, token, key and data
fields. Entries are exact package/domain names; there are no wildcard grants.

Live UI access requires an unambiguous focused-window owner on a single default
display (display 0). Multi-display setups, shared UIDs with multiple packages and
unsupported WindowManager metadata formats are rejected. See [focus identity
limits](SAFETY.md) before using a different Android/vendor build.
Enable `retainObservationText` explicitly to use the saved-text reading cursor.
Allowed Chrome pages require `com.android.chrome`, an exact HTTPS domain, and
`expectedUrl` matching the focused visible tab. Other browser engines are not
supported by the Chrome observation adapter.
Use `android_open_url` with an exact allowed HTTPS `url` to start Chrome;
`android_launch_app` cannot start Chrome. All key inputs require separate owner
approval, including in an expert sandbox. Key aliases are normalized before
signing, authorization, execution and receipt hashing.

Copy `.env.example` to a local `.env`, set `PHONE_SECURITY_FILE` and the dedicated
USB serial in `PHONE_DEVICE`, then run `pnpm start`. The listener binds only to
`127.0.0.1:17761`. Missing/insecure configuration fails before startup. There is no
automatic device discovery, network-ADB connection, wake or keyguard dismissal.
Unlock/wake the phone manually for ordinary UI work.

Connect an MCP client supporting Streamable HTTP at `http://127.0.0.1:17761/mcp`
with `Authorization: Bearer <contents of token.key>`. The header is required for
health checks and tool discovery too. Multiple clients with that token share one
owner's phone/history; this is **not a multi-tenant service**. Actor/session labels
are not identities. Do not expose a raw ADB server or Chrome debugging socket.

`pnpm doctor` checks configuration offline. Only `pnpm doctor --device` contacts the
configured phone. `node --env-file=.env scripts/check-mcp.mjs` checks the authenticated
catalog without phone work. A network tunnel is outside this project's validated
deployment and is not a substitute for service authentication.

## Approve an input and recover its receipt

Put the exact request in an owner-only file, outside Git. For example:

```json
{
  "name": "android_tap",
  "arguments": {
    "x": 120, "y": 240,
    "expectedPackage": "org.example.game",
    "requestId": "example-owner-action-0001",
    "observeAfterMs": 1000,
    "imageMode": "deferred"
  }
}
```

These coordinates are illustrative. The human reviews the full request file and
uses the separate local approval utility:

```sh
node scripts/owner-approve.mjs /absolute/service-directory/security.json /absolute/owner-signing-directory/approval.key /absolute/private-request.json /absolute/private-approved.json
node --env-file=.env scripts/call.mjs /absolute/private-approved.json
```

The utility creates a normalized read-only review copy in the owner's signing
directory. Review that copy at the printed path; duplicate JSON keys are rejected.
It checks the original and review copy again after confirmation and refuses a
changed file. The signer account and its directory must remain trusted.
The utility asks for confirmation bound to the request digest. A grant lasts two
minutes and binds the owner, tool and **all** arguments, including request ID. It
is not available over MCP. Changing the request invalidates the grant. An agent
must not run the owner signer, read its private key, or change owner policy.

If transport or image delivery fails, query:

```json
{
  "name": "android_activity_open",
  "arguments": {"requestId": "example-owner-action-0001", "receiptOnly": true}
}
```

`execution=acknowledged` means the input command was acknowledged, not that the
app achieved the goal. `unconfirmed` and `unknown_expired` remain uncertain.
Never bypass recovery by replaying under a new ID. `includeScreenshot=true` reads
the retained original from host storage without contacting the phone. An absent
image leaves the text receipt available. `phoneImage` gives source/preview sizes
and coordinate scaling; Chrome bounds instead use CSS pixels.

If a preview appears black, an optional first recovery is reopening the same
archived event with `android_activity_open({eventId, includeScreenshot:true,
imageMaxEdge:768})`, trying a different preview size before navigating the app.
This reads the saved image without phone contact. It is not a guaranteed fix:
the cause can be in capture or downstream presentation and may remain unknown.

Receipts include `requestBinding.tool` and `requestBinding.argsDigest`. Verify both
against `actionBinding(name, arguments)` from `dist/operation.js` before using a
recovered receipt. `android_activity_open` accepts `expectedTool` and
`expectedArgsDigest` for that check. The local client does it automatically:

```sh
node --env-file=.env scripts/call.mjs --recover /absolute/private-approved.json
```

Read operations cannot reserve IDs. Legacy expired receipts without a binding
remain unknown and replay-blocked. `callOutcome=policy_drift` is an error even
when `execution=acknowledged`: the input was sent, but a later lock/focus/URL check
failed or could not verify state. Text inputs run metadata-only post-checks;
they do not return a new UI dump or screenshot of the entered text.

## Explicit game grants

For a dedicated offline game without real accounts, purchases or messages, the
owner can grant selected touch tools in `security.json`:

```json
{
  "gameGrants": [{
    "package": "org.example.game",
    "tools": ["android_tap", "android_swipe", "android_gesture"],
    "disposableOfflineGame": true
  }]
}
```

The package must also be in `allowedApps`. These tools then need no per-input
signature for that package; `requestId`, current focused-window checks, lock
checks and all bounds still apply. Text entry, app launch and power transitions
remain separately approved unless explicitly supported by the expert profile.
Restart the service after an owner changes policy. Revoke a grant before adding
accounts, commerce or communication features to the device.

`android_capture_clip` can also be granted for an explicitly enabled clip app.
Its optional tap needs that exact tool grant or a signed request; an
`android_tap` grant alone does not authorize it. Recording without a tap needs
owner clip opt-in and a recovery ID, but grants no phone input.

## Data, bounds and optional components

Live observations and returned image previews are delivered to your MCP client.
That client may send them to a remote model provider and retain its own copies;
consult its settings and terms. The service's local storage controls do not
control client history, provider retention or the phone apps' own networking.

Raw input strings and approval signatures are not journaled or echoed in tool
errors. Text-input actions omit their follow-up text/image to avoid copying the
input. Separately requested observations can still contain app text and secrets;
password masking is narrow and cannot detect every private field.

Receipts and the replay ledger retain `requestBinding.argsDigest`: a deterministic,
unkeyed SHA-256 of the tool and all normalized arguments except `approval`, including
input `text`. **This binds a request; it is not encryption or a confidentiality
mechanism.** A reader with access in the same owner domain who knows the other
arguments can compare guesses for short, predictable text, including OTPs. The
digest survives source-record expiry and `context.private`; protect receipts and
exports as sensitive metadata, and keep real secrets out of this dedicated phone.

History and images are bound to one owner directory. Screenshots stream directly
from Android to that host; this service does not create phone-gallery files.
An existing unbound or
different-owner directory is rejected. Source records expire after seven days or
at 2,000 events; images also have 200-file / 64 MiB limits (16 MiB per image).
Cleanup runs at admission and every minute while the process runs. SQLite and WAL
have bounded storage and private permissions. Expired images are not recaptured.
Request hashes remain in a separate 20,000-entry replay ledger after source expiry;
when that ledger is full, new request-ID operations stop for owner maintenance.
Do not erase that ledger while keeping the same authorization epoch: rotate the
service token and signing key as part of a deliberate fresh installation.

Optional derived summaries have a different lifetime: maintenance retains the
newest eight checkpoints without a seven-day age cutoff, and newer summaries can
carry earlier milestones forward. Disabling summary generation does not erase
existing checkpoints. These are operational notes, not permanent model memory;
source evidence they refer to may already have expired.

The service accepts at most 64 KiB JSON bodies, no JSON-RPC batches, 16 connections,
and eight queued/running tools. Fields, collections, XML depth, Chrome responses
and archived payloads are bounded. Tool calls share a 25-second budget. Limits
are defined in [src/limits.ts](src/limits.ts). Quota failure can omit observation
data or reject admission; it never authorizes a repeated action.

`node --env-file=.env scripts/export-activity.mjs /absolute/private-export-directory`
exports a SQLite snapshot with receipts/replay ledger, excluding images. Exports
and client-saved images require separate owner retention and protection.

### Optional screenshot keepsakes

Keepsakes are **off by default**. The owner can opt in through `security.json`,
then restart the service:

```json
"screenshotKeepsakes": {
  "enabled": true,
  "maxBytes": 268435456,
  "maxCount": 1000
}
```

This grants authenticated clients permission to preserve an **existing** retained
event image with `android_screenshot_keep({eventId, title, note?, requestId})`.
It changes host storage and uses the same bound-request/recovery ledger as other
mutations; it does not capture a new image, contact the phone or grant phone-input
authority. `context.private=true` calls and private source events cannot be saved.
If the source image has expired, saving fails without recapturing it.

`android_screenshot_keepsakes({limit?, before?})` lists saved moments;
`android_screenshot_keepsakes({id, includeScreenshot:true})` reopens one after its
source event/cache expires. These reads work while the phone is disconnected.
Titles are limited to 160 characters, notes to 4,096; each original PNG is at most
16 MiB. Immutable records retain the event/tool, capture-time provenance, save
time and image SHA-256. Saving the same source image again returns its existing
record, preserving its original title/note.

The separate budget counts PNG and metadata bytes. Keep/list responses report
usage and recommend migration at 80% of either the byte or count limit. A new
save that would exceed either limit is refused. Keepsakes never expire and are
never automatically deleted, including when the feature is later disabled.
All clients of the same owner can read that owner's enabled keepsake collection.

For an owner-operated, checksum-verified export to a **new** private directory:

```sh
node --env-file=.env scripts/export-keepsakes.mjs /absolute/new-private-directory
```

The utility copies original PNGs and provenance and writes `manifest.json` only
after verification. It never deletes the source; an incomplete export without
that manifest is not a verified migration. Export also works with the feature
disabled. Stop the service before a final migration so no saves occur afterward.
To free the active quota without deleting memories, first verify the export,
then move the **whole** `dataDirectory/keepsakes` directory to a separate private
archive outside the active data directory using the owner's filesystem tools.
Restarting creates a new empty active collection. Preserve the journal/replay
ledger and the archived collection; older keepsakes remain in that archive and
export, not in the new active list. No agent tool accepts arbitrary paths or
deletes/moves keepsakes. Exports and archives need their own owner retention and
backup policy.

A crashed writer can leave `.write.lock` or `.pending-*` entries. Pending files
reserve quota and produce an inspection warning; they are never silently erased.
Stop the service and preserve/inspect these entries before owner maintenance.

### Optional short clips and frames

`android_capture_clip` records a bounded silent clip, optionally with one tap;
`android_clip_open` lists clips or opens selected zero-based frames;
`android_clip_keep` copies an entire clip or one frame into permanent keepsakes.
The feature is off by default. Linux capture needs owner-installed scrcpy,
Python 3, FFmpeg and ffprobe. Reading saved media does not contact the phone.

The public cache defaults to seven days, 256 MiB and 32 clips, with a 64 MiB
per-clip ceiling. Old verified cache entries can be evicted sooner for capacity.
Clip keepsakes are separately off by default and have their own byte/count
budget, a migration warning at 80%, and no automatic deletion. Kept media and
provenance are copied, so source-cache expiry does not erase a kept moment.

Enable only suitable non-browser apps. Endpoint checks cannot inspect every
video frame: notifications, overlays or a temporary app change may be recorded.
Owner setup requires explicit acceptance of this interval. A browser cannot be
enabled for clips, since a full-screen stream cannot enforce the service's exact
URL boundary throughout a recording. See [short-clip setup, usage and retention](docs/SHORT-CLIPS.md).

Unicode input and continuous gestures need the optional Android helper. Its
[source build instructions](docs/HELPER-BUILD.md) require a fresh compilation and
an explicit signing mode. No prebuilt APK or actual SDK/device acceptance is
included in this candidate. Installing a locally built APK is a separate owner
action, not part of tests.

Model summaries require both `allowModelSummary=true` and a credential; they send
retained excerpts to the configured summary provider (currently OpenAI Responses).
The experimental visual judge is a library plus an explicitly invoked local
`evaluate-visual-goal.mjs --send-selected-images` utility; it is not an MCP action
or an automatic controller. Its selected images leave the host. Core tests mock
model transport; no model quality or current endpoint availability is claimed.

## Expert sandbox: broader owner authorization

This optional interface is for people who trust the operators, use an empty
disposable phone, understand the ADB/host/network boundary, and accept the risk.
The recommended starting point remains the strict configuration above.

The 31-tool catalog covers status, apps, native and Chrome observations, all the
touch/gesture/text/key/orientation controls, and four activity/reading endpoints.
The owner can grant exposed input tools except `android_press_key` for exact allowed packages through
`expertSandbox.grants`, for example:

```json
{
  "expertSandbox": {
    "trustedOperators": true,
    "disposablePhone": true,
    "isolatedEnvironment": true,
    "acceptsRisk": true,
    "grants": [{
      "package": "org.example.game",
      "tools": ["android_launch_app", "android_tap", "android_swipe", "android_gesture", "android_set_orientation"]
    }]
  }
}
```

This can make a sandbox freely usable within the owner's explicit scope. It does
not disable authentication, allowlists, lock/foreground checks, receipts or quotas.
All key inputs and explicit wake require separate approval. Package changes are checked,
but a coordinate tap cannot reveal whether a button buys, publishes or walks;
never attach real accounts or money to a broadly delegated sandbox. Real banking,
trading, payments, identity, health, work and account-security operations are
unsupported and prohibited in every profile, even with approval. HTTPS checks are not a firewall for native apps
or redirects already followed by the browser; isolate the device network too.

The project is provided under the [MIT License](LICENSE), including its warranty
and liability disclaimer. Operators are responsible for their deployment, access
and use. This is not a promise of security or a guarantee of legal immunity.

Based on [qalvinahmad/android-mcp](https://github.com/qalvinahmad/android-mcp),
upstream revision `04f3bf02096e4e0a9809edf3a57c213a94cb1d8b`; the original copyright
and MIT notice are retained. The original broad stdio entrypoint and direct-device
verification scripts are not shipped as public service entrypoints.
