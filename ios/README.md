# iPhone USB source preview

This macOS integration controls a dedicated iPhone through USB. Its native MCP
entry exposes seven tools, with `act` as the sole input tool. Touch, keyboard,
Home, clipboard, screenshots and native accessibility use the configured physical
USB device. The desktop preview is observation only. This is a source preview; it is not
Apple's iPhone Mirroring or an Android-to-iPhone adapter.

The iOS host trusts the local Mac and MCP client. Android's owner tokens,
app/domain restrictions and signed input approvals do not apply to this host.
Read [the iOS security boundary](SECURITY.md) before connecting a client. Use a
spare phone and accounts whose data and setup you can reset.

## Set up

Requirements: macOS 14+, Node 24+, Git, Swift 6, `uv`, and a USB-connected iPhone
that trusts the Mac. The helpers use Python 3.12 and pinned
`pymobiledevice3==11.50.0`. Screenshots use the configured physical USB UDID;
camera permission is not required. The source recipe has been exercised on one
iPhone 15 running iOS 26.5; other hardware and OS versions require acceptance testing.

```sh
node ios/phone.mjs setup-usb
node ios/phone.mjs build
node ios/phone.mjs discover
```

`setup-usb` creates an ignored CPython 3.12 environment under `.runtime/iphone-use/`
and synchronizes the matching macOS 14+ arm64 or x86_64 [dependency lock](USB-DEPENDENCIES.md).
All transitive versions and artifact hashes are pinned; source builds are refused.
The interpreter architecture selects the profile. Stop the host before updating
this environment. Setup sends no phone input.
`build` fetches [the pinned MIT native source](https://github.com/YueChen-C/iPhone-use/tree/577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c),
applies the ordered patches and builds an ad-hoc-signed app locally. Stop an
existing managed host before rebuilding; unexpected dependency edits are
preserved rather than reset.

Connect only the intended phone, unlock it and establish USB trust manually.
`discover` needs a current build but no local config, and refuses a running host.
It enumerates physical USB UDIDs and prints a `config_candidate` only for a sole
phone with a matching, rechecked IOKit pin. It never writes configuration or
chooses among multiple phones. A candidate establishes current USB inventory,
not trust, screenshot readiness or input effects. Keep identifiers and output
local.

Discovery does not use AV capture IDs, CoreMediaIO exposure or new USB
configuration activation. It starts no input, pairing, Bluetooth, HTTP host or
capture session. If an earlier version left a pending USB restoration record,
the existing native owner still attempts bounded recovery; that can change the
old USB configuration. `cleanup:settled` means the ledger reached a terminal
outcome (restored, detached or superseded), not that the old configuration was
necessarily restored. Physical IDs and the IOKit pin are rechecked after cleanup.
Missing, multiple, unavailable or changing devices, cancellation and unresolved
cleanup prevent a candidate. Launcher termination forwards cancellation and keeps
a bounded cleanup window; do not treat a timeout as successful setup or retry an
unresolved restoration blindly.

Copy [config.example.json](config.example.json) to `.local/iphone-use.json` and
replace its single `usbDeviceId` placeholder. Screenshots, AX and input share that
physical UDID. A legacy `captureId` is accepted only when exactly equal to
`usbDeviceId`, then ignored. A different AV capture ID is rejected: verify the
physical ID with `discover` and remove the old field before startup.
The launcher always enables USB touch and keyboard. Existing `directTouch:true`
and `directKeyboard:true` are accepted; omit them in new configurations. False
flags, Bluetooth selection and held-drag profiles fail before startup. The
listener is fixed to `127.0.0.1:7390`; an omitted `port` defaults to 7390.
Inherited Python and transport/helper overrides cannot select another device or
reactivate Bluetooth.

```sh
node ios/phone.mjs start
node ios/phone.mjs status
node ios/phone.mjs stop
```

`start` starts or reuses the matching owned host; it does not replace an unrelated
process. `status` is passive. `stop` checks the process identity before signaling
it. Missing phones do not trigger automatic host restarts. Runtime files, state,
AX archives and logs stay under the ignored `.runtime/iphone-use/` directory.

Configure your MCP client with an absolute Node executable, the absolute path to
`ios/phone.mjs`, and the argument `mcp`. Start the host first. For example:

```sh
codex mcp add iphone -- /absolute/path/to/node /absolute/path/to/phone_use_for_llm/ios/phone.mjs mcp
```

MCP startup validates the build, host, device configuration and USB-only mode.
It does not install, build or start a host. Reconnect MCP clients after updating
the native executable; an already running client keeps its loaded code. Do not
register the dependency checkout's raw binary or upstream installer as another
entry point. The assembled skill and recovery script use the managed launcher.

The catalog is also the callable MCP allowlist in every native mode. The old
`tap`, `long_press`, `swipe`, `touch_sequence`, `type_text`, `press_key`, `home`,
`keyboard_sequence` and `tap_text` tools and their compatibility executor have
been removed. Use the corresponding `act.steps` types; legacy names fail before
device access. Existing journal entries remain readable.

## Observe and act

Read `session_context` on resume, then inspect a fresh `screenshot`.

| Tool | Purpose |
| --- | --- |
| `session_context` | Historical receipts, checkpoint and loaded native identity |
| `list_devices` | USB inventory; screenshots and input stay bound to the configured phone |
| `screenshot` | Current pixels and one-use touch frame |
| `screenshot_burst` | Two to six animation samples; no input |
| `accessibility_tree` | Bounded native text and control evidence |
| `ocr_screen` | OCR from an image captured in the same call; recognition may be wrong |
| `act` | Ordered USB input and bounded waits |

A screenshot's `frame.id` and its pixel coordinates belong together. After
observing an editable target, a batch can tap it and type:

```json
{"steps":[
  {"type":"tap","frame_id":"<observed frame.id>","x":210,"y":280},
  {"type":"type","text":"Example text"}
]}
```

Each batch permits at most one `tap`, `swipe` or multitouch `touch`, as its first
step. Further known `type`, `key`, `home`, `delay` or `wait_text` steps may follow.
The whole batch is validated before input. Long press uses `tap.hold`; touch
supports up to five contacts, 256 samples and six seconds. No coordinate action
silently substitutes a new screenshot, falls back to Bluetooth, or replays input.

The frame binds the exact physical USB attachment and screenshot dimensions for
one attempt, including a rejected attempt. The host rechecks attachment and
dimensions before input. An `act` result does not issue a new touch token; request
and inspect an ordinary `screenshot` before another coordinate decision. Frames
have no age expiry, orientation epoch or UI lock; other clients, animations and
human input can change the target. Take a fresh observation after a pause. Native
AX IDs and coordinates are reading evidence, not touch references or proof of hittability.

Ordinary `type` uses the phone's USB clipboard and Cmd+V; `home` sends the native USB Home button.
Paste permissions and editor state can prevent insertion. `use_clipboard:false`
selects bounded USB HID typing, not another transport. The Mac clipboard is not
the normal text route. Inspect the field before submitting or clearing it.
Modifier/paste behavior has shown state-dependent failures after connection
changes; do not infer application success from a send receipt.

`structuredContent.input_receipt` separates not-sent, locally-sent and uncertain
input from the following observation. A fresh or changed image does not prove
application completion. A later batch failure preserves the executed prefix;
observe before deciding how to proceed and never replay an uncertain batch.

The optional pre-input baseline has a separate two-second capture budget; a
missing baseline does not block input. Post-input observation defaults to three
seconds and can end when the image changes and stabilizes. `observe:"ocr_diff"`
compares OCR from this call's baseline with its returned observation, not earlier
client history; missing baseline or current OCR is explicit. These observations
do not establish semantic task completion or justify replaying input.

The `home` step sends the native USB Home button through the same physical target
and host commit guard. The earlier Command-H shortcut failed in a measured
Settings search field and has been replaced; Home was observed to work there
with the native button. System edge gestures are not used as an automatic
fallback. Phone paste permission prompts remain visible: an acknowledged
clipboard write does not mean the field accepted the paste.

## Read native accessibility

`accessibility_tree` defaults to an app-root read; `scope:"point"` selects the
process subtree at `x`/`y` in 0–1000 coordinates. Native coverage is incomplete
and non-atomic; custom drawing, unmaterialized controls and other processes may
be absent. Failures remain explicit and never substitute OCR.

The canonical `ios-ax-reading-v1` JSON is in `content[0].text`. Node rows retain
`[source_id,parent_id,native_fields]`; `parents` retains every ancestry edge.
`defaults` applies only to nodes. Repeated sparse ancestor dictionaries may be
referenced by integer indices into `parent_fields`. Absent, null, hidden and
unknown remain distinct. Counts disclose omitted keyboard nodes and truncation.

`structuredContent` contains status, source identity, archive reference and
session activity, plus `payload_content_index:0`; it does not repeat node text.
Text-only clients receive the reading view. Programmatic clients can parse that
text or read the exact locally archived source; there is no implicit recapture.

The returned `reader.script` and `reader.args` read the same snapshot. Run them
with the configured Python interpreter in isolated mode (`-I -B`); append
`--node-id <source ID>` for full native fields/subtree or `--offset <next_offset>`
for continuation. This local
reader returns the detailed `ios-ax-compact-v2` view without phone input or a new
capture. Invalid or expired archives fail explicitly. Raw archives are private
host files, bounded to 256 captures and 64 MiB; they may contain hidden UI text.

The seven core tools invoke no model API of their own. Text and screenshots
returned through MCP reach your connected client and may reach its model
provider. This preview does not include an assistant provider, background
worker, flight runner or app-specific reading interpretation.

## Verify

```sh
node --test ios/phone.test.mjs
.runtime/iphone-use/usb-venv/bin/python -I -B -m unittest discover -s ios/accessibility -p 'test_*.py'
.runtime/iphone-use/usb-venv/bin/python -I -B -m unittest discover -s ios/coredevice -p 'test_*.py'
```

Use Python 3.12. After `build`, on macOS:

```sh
node ios/check-native-input.mjs
cd .runtime/iphone-use/source
IPHONE_USE_TEST_CONFIG=release python3 -B -m unittest discover -s Tests/PythonTests -p 'test_*.py'
python3 -B scripts/check-mcp.py -- build/iPhoneUse.app/Contents/MacOS/iphone-use mcp
```

The isolated Swift Testing check **replaces the native test directory** with
selected suites; a pass does not establish that the full XCTest suite compiles
or passes. Do not restore retired runtime interfaces to satisfy historical test
assertions. Migrate each assertion to the current contract, retaining meaningful
validation and failure coverage. Run both this check and full `swift test`.
The [iOS workflow](../.github/workflows/ios.yml)
runs these source checks, full `swift test`, every acceptance overlay through
`check-native-input.mjs`, and release protocol checks. The overlay runner resolves
its Swift Testing plugin from the selected toolchain, for both CLT and Xcode.
Workflows run on relevant pull requests and `main` pushes, with obsolete runs
cancelled per workflow/ref. CodeQL covers JavaScript/TypeScript and Python only,
not Swift. Device acceptance remains separate from synthetic tests and hosted CI.
See [preview validation](../docs/IOS-SOURCE-PREVIEW.md)
for the exact scope and current limits.

## Source and licenses

This is a source/patch/test distribution, with no native binary, Python environment
or combined runtime bundle. Keep the [third-party notices](THIRD_PARTY_NOTICES.md),
[native MIT notice](UPSTREAM-LICENSE) and [AX codec MIT notice](accessibility/LICENSE.ipb).
The separately installed USB dependency is GPL-3.0-or-later; the installed
combination is not an MIT-only bundle. No private device evidence or history is
part of this source export.
