# phone-use for LLMs

An Android MCP service for a dedicated phone: native accessibility text, bounded
screenshots, continuous gestures, post-action observations, and durable action
receipts. A dropped image response does not require repeating the touch.

**0.9 is a release candidate awaiting independent review.** It defaults to one
authenticated owner and per-input approval. Use a disposable device and isolated
host/network. Read [SAFETY.md](SAFETY.md) and [AGENT-SAFETY.md](AGENT-SAFETY.md).
This repository contains code and synthetic fixtures, with a fresh Git history;
it does not import private device data, credentials or activity logs.

## What it does

| Workflow | Capability |
| --- | --- |
| Observe | Native UI text, blank editable controls, bounded PNG previews, focused Chrome DOM/accessibility text and CSS bounds |
| Act | Tap, double tap, long press, swipe, drag, continuous paths, ASCII/Unicode input, keys and orientation |
| Wait | Optional 0–5000 ms delay before the post-action frame; elapsed time is never called completion |
| Recover | Query a caller-chosen request ID after transport failure; a recorded ID never executes another input |
| Read across screens | Deterministic text overlap and reading anchors; image index/total are a separate observed axis |
| Resume | Single-owner history and optional source-linked model summaries |
| Monitor | Power, battery temperature and framework thermal status without waking or reading UI |

Reading cursors do not choose interests, scroll automatically, or nag about unseen
pictures. Games still need an operator to choose moves and judge outcomes. The
core service and the two bundled [skills](skills/) need no model API key.

## Install and configure the strict default

Requirements: Node.js 24 or newer, pnpm 11.25.0, and Android platform-tools for
actual device use. Windows and POSIX permission handling differ; see validation
limits in [docs/VALIDATION.md](docs/VALIDATION.md). The synthetic check needs no SDK.

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
Use absolute paths appropriate to your OS:

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
Enable `retainObservationText` explicitly to use the saved-text reading cursor.
Allowed Chrome pages require `com.android.chrome`, an exact HTTPS domain, and
`expectedUrl` matching the focused visible tab. Other browser engines are not
supported by the Chrome observation adapter.

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

## Data, bounds and optional components

Raw input strings and approval signatures are not journaled or echoed in tool
errors. Text-input actions omit their follow-up text/image to avoid copying the
input. Separately requested observations can still contain app text and secrets;
password masking is narrow and cannot detect every private field.

History and images are bound to one owner directory. An existing unbound or
different-owner directory is rejected. Source records expire after seven days or
at 2,000 events; images also have 200-file / 64 MiB limits (16 MiB per image).
Cleanup runs at admission and every minute while the process runs. SQLite and WAL
have bounded storage and private permissions. Expired images are not recaptured.
Request hashes remain in a separate 20,000-entry replay ledger after source expiry;
when that ledger is full, new request-ID operations stop for owner maintenance.
Do not erase that ledger while keeping the same authorization epoch: rotate the
service token and signing key as part of a deliberate fresh installation.

The service accepts at most 64 KiB JSON bodies, no JSON-RPC batches, 16 connections,
and eight queued/running tools. Fields, collections, XML depth, Chrome responses
and archived payloads are bounded. Tool calls share a 25-second budget. Limits
are defined in [src/limits.ts](src/limits.ts). Quota failure can omit observation
data or reject admission; it never authorizes a repeated action.

`node --env-file=.env scripts/export-activity.mjs /absolute/private-export-directory`
exports a SQLite snapshot with receipts/replay ledger, excluding images. Exports
and client-saved images require separate owner retention and protection.

Unicode input and continuous gestures need the optional Android helper. Build it
locally with JDK 17 and Android SDK build-tools 34 using
`python scripts/build-android-helper.py --jdk JDK_DIR --platform PLATFORM_DIR --build-tools BUILD_TOOLS_DIR`.
The APK and local development signing key stay under ignored `.runtime/`. Installing
that APK on a dedicated phone is a separate owner action, not part of tests.

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

The 26-tool catalog covers status, apps, native and Chrome observations, all the
touch/gesture/text/key/orientation controls, and four activity/reading endpoints.
The owner can grant any exposed input tool for exact allowed packages through
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
Power transitions always require separate approval. Package changes are checked,
but a coordinate tap cannot reveal whether a button buys, publishes or walks;
never attach real accounts or money to a broadly delegated sandbox. Use separate
approval for sensitive workflows. HTTPS checks are not a firewall for native apps
or redirects already followed by the browser; isolate the device network too.

The project is provided under the [MIT License](LICENSE), including its warranty
and liability disclaimer. Operators are responsible for their deployment, access
and use. This is not a promise of security or a guarantee of legal immunity.

Based on [qalvinahmad/android-mcp](https://github.com/qalvinahmad/android-mcp),
upstream revision `04f3bf02096e4e0a9809edf3a57c213a94cb1d8b`; the original copyright
and MIT notice are retained. The original broad stdio entrypoint and direct-device
verification scripts are not shipped as public service entrypoints.
