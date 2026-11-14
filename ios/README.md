# iPhone USB source preview

This macOS integration controls a dedicated iPhone through USB. Its native MCP
entry exposes seven tools, with `act` as the sole input tool. Touch, keyboard,
Home, clipboard and native accessibility use the configured physical USB device.
The desktop preview is observation only. This is a source preview; it is not
Apple's iPhone Mirroring or an Android-to-iPhone adapter.

The iOS host trusts the local Mac and MCP client. Android's owner tokens,
app/domain restrictions and signed input approvals do not apply to this host.
Read [the iOS security boundary](SECURITY.md) before connecting a client. Use a
spare phone and accounts whose data and setup you can reset.

## Set up

Requirements: macOS 14+, Node 24+, Git, Swift 6, `uv`, and a USB-connected iPhone
that trusts the Mac. The helpers use Python 3.12 and pinned
`pymobiledevice3==11.50.0`. Camera access is needed for screen capture. The source
recipe has been exercised on one iPhone 15 running iOS 26.5; other hardware and
OS versions require acceptance testing.

```sh
node ios/phone.mjs setup-usb
node ios/phone.mjs build
node ios/phone.mjs discover
```

`setup-usb` creates a private Python environment under `.runtime/iphone-use/`.
`build` fetches [the pinned MIT native source](https://github.com/YueChen-C/iPhone-use/tree/577d5f2d0ec5831ed6e3e5d9c3ae482ee1dc4f5c),
applies the ordered patches and builds an ad-hoc-signed app locally. Stop an
existing managed host before rebuilding; unexpected dependency edits are
preserved rather than reset.

Use discovery to obtain the capture device ID and physical USB UDID. They are
different identifiers. Connect only the intended phone during initial setup;
review the discovery outcome before copying identifiers. Discovery never writes
configuration or selects a phone for you. If a sole, pinned USB phone has no
capture device, it may temporarily activate the existing USB media configuration
and then settle its restoration ledger. This can briefly reconnect USB; it does
not start input, pairing, Bluetooth or a capture session. `cleanup:settled` means
the ledger reached a terminal outcome (restored, detached or superseded), not a
guarantee that the earlier USB configuration was restored. Capture IDs are
sampled before cleanup; normal startup checks capture identity again. Detachment,
identity change, cancellation or unresolved cleanup prevents a candidate. A
pending cleanup remains explicit for recovery; do not retry blindly. Keep
identifiers and output local.

Copy [config.example.json](config.example.json) to `.local/iphone-use.json` and
replace both placeholders. The launcher always enables USB touch and keyboard.
Existing `directTouch:true` and `directKeyboard:true` are accepted; no transport
switch is needed. False flags, Bluetooth selection and held-drag profiles fail
before startup. The listener is fixed to `127.0.0.1:7390`.

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

## Observe and act

Read `session_context` on resume, then inspect a fresh `screenshot`.

| Tool | Purpose |
| --- | --- |
| `session_context` | Historical receipts, checkpoint and loaded native identity |
| `list_devices` | Capture inventory; input stays bound to the configured phone |
| `screenshot` | Current pixels and one-use touch frame |
| `screenshot_burst` | Two to six animation samples; no input |
| `accessibility_tree` | Bounded native text and control evidence |
| `ocr_screen` | OCR text; recognition may be wrong |
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

The frame binds capture identity and dimensions for one attempt. It has no age
expiry, orientation epoch or UI lock; other clients, animations and human input
can change the target. Take a fresh observation after a pause. Native AX IDs and
coordinates are reading evidence, not touch references or proof of hittability.

Ordinary `type` uses the phone's USB clipboard and Cmd+V; `home` uses USB Cmd+H.
Paste permissions and editor state can prevent insertion. `use_clipboard:false`
selects bounded USB HID typing, not another transport. The Mac clipboard is not
the normal text route. Inspect the field before submitting or clearing it.
Modifier/paste behavior has shown state-dependent failures after connection
changes; do not infer application success from a send receipt.

`structuredContent.input_receipt` separates not-sent, locally-sent and uncertain
input from the following observation. A fresh or changed image does not prove
application completion. A later batch failure preserves the executed prefix;
observe before deciding how to proceed and never replay an uncertain batch.

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
with the configured Python interpreter; append `--node-id <source ID>` for full
native fields/subtree or `--offset <next_offset>` for continuation. This local
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
python3 -B -m unittest discover -s ios/accessibility -p 'test_*.py'
python3 -B -m unittest discover -s ios/coredevice -p 'test_*.py'
```

Use Python 3.12. After `build`, on macOS:

```sh
node ios/check-native-input.mjs
cd .runtime/iphone-use/source
IPHONE_USE_TEST_CONFIG=release python3 -B -m unittest discover -s Tests/PythonTests -p 'test_*.py'
python3 -B scripts/check-mcp.py -- build/iPhoneUse.app/Contents/MacOS/iphone-use mcp
```

The isolated Swift Testing check is useful on CLT installations without XCTest;
it does not replace full `swift test`. The [iOS workflow](../.github/workflows/ios.yml)
runs source, build and protocol checks. Device acceptance remains separate from
synthetic tests and hosted CI. See [preview validation](../docs/IOS-SOURCE-PREVIEW.md)
for the exact scope and current limits.

## Source and licenses

This is a source/patch/test distribution, with no native binary, Python environment
or combined runtime bundle. Keep the [third-party notices](THIRD_PARTY_NOTICES.md),
[native MIT notice](UPSTREAM-LICENSE) and [AX codec MIT notice](accessibility/LICENSE.ipb).
The separately installed USB dependency is GPL-3.0-or-later; the installed
combination is not an MIT-only bundle. No private device evidence or history is
part of this source export.
