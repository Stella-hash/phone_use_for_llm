# iOS host trust boundary

The iOS preview is for a dedicated USB-connected phone controlled from a trusted
Mac and trusted local MCP client. It is a separate implementation from the
Android service. Android bearer tokens, app/domain scopes, owner signing keys
and per-input approvals are not implemented by the native iOS host.

The managed launcher binds input to explicit capture and physical USB identifiers,
enables both USB input routes, and disables Bluetooth lifecycle. It exposes seven
MCP tools; removed legacy input names are rejected before device access in all
native modes. It does
not pair a new device, choose another phone on failure, silently fall back to
another input transport, or replay uncertain input.

The native HTTP listener is an internal loopback service on 127.0.0.1:7390 for
MCP and the local read-only viewer. HTTP request admission checks loopback Host,
browser origin/fetch metadata and input content type before device wake or
routing. Those checks restrict web-origin requests; they are not authentication
against another process or user on the Mac. Do not proxy, tunnel or expose the
listener to other machines. A process with access to the local host/client can
exercise the configured phone authority.

One-use screenshot references bind a coordinate input attempt to capture identity
and dimensions. They do not lock UI content, certify hittability or survive a
capture restart. Application completion and phone-side delivery remain separate
from host send receipts. There is no app allowlist, task ownership lease or
background multi-client handoff; keep one operator in control and observe after
any uncertain input.

Raw AX snapshots can include hidden UI text. The private host archive retains up
to 256 captures and 64 MiB; the journal retains bounded receipts and an explicit
checkpoint. Keep `.runtime/` and `.local/` private. Do not publish raw captures,
phone identifiers, configuration, logs, clipboard content or credentials in issues.
The MCP client receives returned text/images and may send them to its model
provider. No extra model API is invoked by these core tools.

Only source, patches and synthetic fixtures are distributed here. Building and
running requires trusting the pinned native dependency and separately installed
Python dependencies; see [the license boundary](THIRD_PARTY_NOTICES.md).

Use the repository's [private security reporting route](../SECURITY.md). Include
the exact commit and a minimal synthetic reproduction, without real device data.
