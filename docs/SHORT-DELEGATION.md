# Optional short delegation

Let the main operator ask a small question, receive a finding, revise it, or take
over. A second model can handle a few local observations and navigation steps;
the operator keeps choosing what is interesting and deciding what the evidence
means. This is an optional convenience, not a requirement for browsing or play.

The core tools, reading cursors and [latency profiles](LATENCY-PROFILES.md) need
no additional API key. Delegation is **off by default**. A summary credential or
`allowModelSummary` does not enable it. No private deployment, experiment folder,
Python worker, extra MCP endpoint or device action-card service is needed.

## Owner setup

Keep the ordinary owner authentication, app/domain restrictions and input grants.
Add this fragment to the owner's private `security.json`, choosing a model that
supports Responses function calling (and image input if enabled):

```json
{
  "retainObservationText": true,
  "delegation": {
    "enabled": true,
    "acceptsModelEgress": true,
    "allowImages": false,
    "keyFile": "/private/owner/delegation.key",
    "model": "YOUR_RESPONSES_MODEL"
  }
}
```

Use an absolute owner-only key-file path; on Windows use a private ACL and a
path such as `C:/private/owner/delegation.key`. Store only the credential in that
file, outside the source tree. The service never falls back to summary or policy
environment keys. The owner may deliberately select the same credential, but
must still configure delegation and egress separately. Missing/invalid optional
credentials block delegation without preventing direct phone use.

`reasoningEffort` is optional: omit it unless the chosen model supports that
parameter and value. No model or effort is silently substituted. This version
uses the fixed OpenAI Responses endpoint and a forced `next_step` function,
`store: false`, no redirects and no automatic retries. Incomplete responses,
refusals, malformed decisions and unavailable models become obstacles. See the
[Responses reference](https://developers.openai.com/api/reference/resources/responses/methods/create)
and [structured-output handling](https://developers.openai.com/api/docs/guides/structured-outputs).
`store: false` is not a claim about every provider-side log or retention policy.

Enabling egress sends the current goal, relevant observed text, bounded recent
source spans, unfinished notes and timing context to that model. `allowImages:
true` additionally permits a bounded current PNG preview. Screenshots may still
be captured and archived locally in text-only model mode. Ordinary MCP responses
also have their own client/provider path, described in [SAFETY.md](../SAFETY.md).
Do not put secrets into goals. `context.private: true` cannot start or update a
delegation because the worker requires inspectable retained evidence.

## One small segment

First open an allowed app or exact allowed HTTPS page and leave it awake and
unlocked. Start with a short question and a useful stopping point:

```json
{
  "name": "android_delegate_start",
  "arguments": {
    "requestId": "reading-segment-001",
    "url": "https://example.com/",
    "goal": "What does this page tell us about the topic we are looking at?",
    "doneWhen": "Return one source-backed finding or a concrete obstacle.",
    "budget": { "modelCalls": 8, "seconds": 120, "totalTokens": 16000 }
  }
}
```

The example requires the owner to allow `com.android.chrome` and `example.com`;
it does not add them. For a native page, supply `app` instead of `url`. Chrome
always requires a URL. The worker does not launch an app or wake the phone.

Use the returned `runId` with `android_delegate_status`. If the start response
was lost, query status by `startRequestId`; do not invent another start ID. Status
is a host read, has no mutation `requestId`, and accepts `waitMs: 0..10000`.

Use `android_delegate_update` with `runId`, a new opaque `requestId`, the observed
`expectedVersion`, `goal`, optional `doneWhen`, and a cumulative `budget`. It
invalidates old decisions and captures new evidence. It cannot change the
application/origin scope. Use `android_delegate_stop` with `runId`, `requestId`
and `expectedVersion` to request takeover. Wait for `handoffReady: true` before
direct UI access. Status, stop and receipt recovery remain available during work.
Stop cancels the local model wait; it cannot undo an already admitted input or
prove that a remote provider stopped billing the request.
Control RPCs bypass the action queue, but bounded synchronous ADB work can
delay their handling; takeover is cooperative, not an immediate device interrupt.

Each intent permits at most four model attempts, with its final remaining call
reserved for reporting. The cumulative defaults are 12 calls, 180 seconds of
active work and 24,000 reported tokens; ceilings are 30 calls, 600 seconds and
200,000 reported tokens. Model waits count toward time. Updates do not reset
usage; omitting an update budget preserves its existing ceilings. Token usage
is checked after each response and bounds further calls;
it is **not** an exact billing cap for the current request. Unknown usage stops
the job, and interrupted jobs never resume automatically after restart.

## What authorizes navigation

Start/update are authenticated host lifecycle mutations. They do not sign or
preapprove phone inputs. The worker uses the existing public Executor for every
observation and action, including its current lock/focus identity and Chrome URL
checks, exact request binding, queue and journal admission, and normal owner
approval rules. There is no alternate worker HTTP listener, bearer or signer.

A matching existing game/expert grant can allow the selected tap or swipe. A
missing grant becomes `OWNER_APPROVAL_REQUIRED`; the worker does not manufacture
an approval or fall back to another input. BACK and all other key inputs remain
individually approved and cannot be pregranted. Stop, then let the main operator
request an exact approval when that is the appropriate next step.

The finite navigation vocabulary is observe, bound-selector tap, scroll,
native focused-search text, same-origin HTTPS open, and BACK (subject to the
rule above). It has no raw coordinate proposal, shell, credential reader, game
key adapter, live-touch loop, automatic relaunch or continuous background mode.
Chrome navigation still requires exact URLs: a tap that changes the document
can stop at the existing post-check. The worker does not guess a new URL to
bypass that check. Label-based refusal of sensitive controls is additional
guidance, not a semantic firewall; the disposable-device rules still apply.

Tap and targeted scroll require matching old/new element features, geometry and
WebView group. In Chrome both targets must be inside the same observed WebView
group; untargeted browser scrolling and native toolbar targets are refused.
The group is a per-dump consistency marker, not a persistent document identity;
the existing exact-URL checks remain necessary. Native search requires a unique
focused search field with a nonempty resource ID. That ID travels to the Unicode
helper, which checks it again before setting text. Missing IDs or a different
focused field are refused, with no fallback to unbound text input.

The worker owns this service's UI/input lane while running. It does not exclude
human touches, Android itself or another ADB client. Version checks discard late
model answers; queued actions check again at admission. An already admitted input
must settle through a matching tool/argument/request receipt. Missing or foreign
receipts mean `input_unresolved`, no automatic retry, and no claimed readiness.
After a restart, inspect such a receipt and the device independently; there is
no agent-accessible force-unlock or resume switch.

## Evidence and storage

Findings are pending the main operator's review. Text references contain up to
six source events and twelve span IDs per event. Code copies those exact spans;
the model supplies interpretation separately. `visualEvidence` means a model's
interpretation of an image it was supplied, not text proof. `lastFrame` names a
historical frame; open it with `android_activity_open` only when useful. UI, image
and Chrome captures are sequential, not an atomic view.

Sources must remain available, non-private and within the normal seven-day
retention. A pruned source/image makes the finding unavailable rather than
inventing proof. Source images use the existing 64 MiB / 200-image cache; the
worker stores no extra image copies. It holds at most six text sources, six
image references and a 24 KB finding in memory. At most eight job records are
retained within seven days. Unsettled input markers remain compact until resolved.

Only bounded lifecycle/counter/receipt/frame metadata is saved for restart
recovery (at most 16 KB in the existing private database). Goals, API keys,
prompts, raw model responses, copied findings and extra screenshots are not
written to a worker directory. Findings are intentionally unavailable after
restart. The ordinary replay ledger still keeps request digests, including
digests of goals and search text: an unkeyed digest is not confidentiality.

## Dynamic native pages

The ordinary UI backend remains `uiautomator`. For an explicitly selected allowed
app that does not become idle, an owner may configure `uiSnapshotApps` in
`security.json` and build/install this public companion's
`UiSnapshotInstrumentation` using [the helper instructions](HELPER-BUILD.md).
Only listed allowed apps use this one-shot active-root traversal. It does not
wait for an idle page, inject input, or run a daemon. Package/window checks,
node/field/size/depth/time limits and normal service focus/lock checks still apply.
Missing helper, drift or incomplete traversal returns unavailable with no hidden
fallback. Public helper versions are independent of private development builds.

All deployment and protocol tests here use synthetic devices, evidence and
model transport. They do not establish current model quality, endpoint access,
OEM compatibility, real SDK installation or physical-phone acceptance.
