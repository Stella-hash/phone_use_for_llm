---
name: game-action-observe
description: "Use phone-use to return a later game frame after a chosen touch action, reducing separate follow-up captures during walking, mechanisms, and transitions. Uses a bounded observeAfterMs delay on existing touch tools. Does not solve puzzles, choose destinations, or infer completion from elapsed time."
---

# Game Action Observe

Keep the operator's chosen move and return a useful later observation in the
same call. Use this when earlier action images repeatedly caught a short walk,
mechanism or transition partway through. Ordinary immediate actions can retain
the default delay of zero.

## One action, one later frame

Use the phone's activity context when starting a task and inspect the current
screen before choosing coordinates. When the existing touch tool advertises
`observeAfterMs`, include it with the normal arguments. For example, after
choosing the destination from the current screen:

```json
{"x": 720, "y": 1800, "observeAfterMs": 2000, "expectedPackage": "org.example.game", "requestId": "example-move-0001"}
```

The coordinates above are illustrative Android screen pixels, not a target to
tap. Start with a 2-second delay for a known short movement and adjust to the
actual observed action. Accepted values are integer milliseconds from 0 to 5000.
Supported tools: `android_tap`, `android_tap_element`, `android_double_tap`,
`android_long_press`, `android_swipe`, `android_drag`, and `android_gesture`.
Public service 0.9 requires an awake, known-unlocked phone, an allowed focused
app, and an independent owner approval or an explicit configured game grant.
The example above is incomplete unless such authorization already exists.
Never create your own owner approval or change the policy to make a call pass.
The private-call behavior and action journal apply. No extra prompt, API key, goal classifier, or image upload is needed.

The service performs the input once, waits, then captures the ordinary final
UI/image observation. It does not take an intermediate screenshot. The shared
phone queue remains held through the wait and capture so another tool's input
cannot slip between them. The owner still controls the physical screen.

## Read the observation

Use the returned frame to decide what actually happened. `phoneObservation.delay`
contains `requestedMs`, measured `elapsedMs`, and one of these statuses:

- `elapsed`: the requested wait was allowed; this is a timing result.
- `budget_limited`: the shared 25-second deadline shortened or skipped the wait
  to reserve time for the final observation. Use the returned frame as it is.
- `action_failed`: input returned an error, so the extra wait was skipped.
  Inspect its event before any retry; the attempted action may be uncertain.

A later frame may still show an unfinished move. Only report arrival, dialogue
or a scene change when the frame supports it. If another observation is useful,
take one explicitly; never repeat the touch merely because the image is unclear.
Moving sea, birds or background lights do not need to become still.

When comparing this path with the ordinary workflow, count extra outer captures,
total service/connector time separately, and any unfinished returned frame.
More waiting is not automatically faster.

On service 0.9.0+, choose a fresh opaque `requestId` before each action. If the
response disconnects, query `android_activity_open` with that requestId and
`receiptOnly=true`. Do not repeat the input to obtain a receipt. `acknowledged`
means execution was acknowledged, not that the game goal was achieved.
`imageMode=deferred` keeps the action response textual; the saved image can be
read separately with `includeScreenshot=true`. Returned images are bounded
previews: use `phoneImage.coordinateScale` to map preview pixels to Android
coordinates. An unavailable image does not erase the execution receipt.

If the client's tool schema does not expose `observeAfterMs`, use the existing
action and an explicit later observation. Do not silently treat that fallback as
an executed delayed-observation call, and do not probe availability by replaying
a game action. This skill's runtime starts at phone-use service 0.7.0.
