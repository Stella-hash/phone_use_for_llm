# Optional short clips and frame inspection

Short clips help inspect a brief animation without many separate screenshots.
They do not select game actions, decide puzzle solutions, pause a game, or run a
decision model. Capture is disabled by default. The three tools remain listed so
their disabled status can be inspected without a phone action.

## Owner setup

Capture runs on Linux only. Install Python 3 with its standard `pty` module,
FFmpeg/ffprobe, and scrcpy from the
[official Linux instructions](https://github.com/Genymobile/scrcpy/blob/master/doc/linux.md).
Use a verified official release or your own build; no recorder binary is bundled
or downloaded by this service. The installed recorder must support the flags in
`src/clip-capture.ts`, including `--no-power-on`, `--no-control`, `--no-audio`,
`--no-playback`, `--no-window`, `--time-limit`, and Matroska recording.
See the official [recording](https://github.com/Genymobile/scrcpy/blob/master/doc/recording.md)
and [video options](https://github.com/Genymobile/scrcpy/blob/master/doc/video.md).
The absolute recorder path comes only from the owner's local configuration.
FFmpeg and ffprobe use PATH, or local `PHONE_FFMPEG` / `PHONE_FFPROBE` overrides.

Add a suitable disposable non-browser app to the existing `allowedApps`, then
configure this optional section in `security.json` and restart the service:

```json
{
  "shortClips": {
    "enabled": true,
    "allowedApps": ["org.example.game"],
    "acceptsTransientScreenContent": true,
    "recorderPath": "/absolute/path/to/scrcpy",
    "cache": { "maxAgeMs": 604800000, "maxBytes": 268435456, "maxCount": 32 },
    "keepsakes": { "enabled": false, "maxBytes": 268435456, "maxCount": 1000 }
  }
}
```

`acceptsTransientScreenContent` acknowledges a concrete limitation: the service
checks awake/unlocked state, focused package, display geometry and password UI
before recording, immediately before the optional tap, and after recording. It
does **not** inspect every intermediate frame. Notifications, system overlays,
password UI appearing later, or an app temporarily leaving the foreground can
be present in the video. An allowed package is not an assurance that every frame
belongs to that package. Use a phone/app whose full screen is appropriate to
record. The configured browser package is rejected, even with owner approval,
because exact allowed URL checks cannot cover the video interval.

The default generated configuration leaves both capture and keepsakes disabled,
with empty clip apps and no transient-content acceptance. `context.private=true`
rejects capture and keep; it never promises privacy while saving video anyway.
Disabling the feature prevents new tool access but does not delete its files.

## Capture and inspect

Use the current native display dimensions and package from a recent observation.
Do not use preview-image dimensions for `expectedDisplay` or `tap` coordinates.
Capture checks Android's current input viewport, including rotation; it does not
substitute the panel's unrotated `wm size`.
The guard rechecks focus and geometry after the blocking UI dump. Checks are
sampled, not atomic with Android's DOWN event: a subsequent rotation can still
race a tap, so keep orientation stable while triggering an animation.

```json
{
  "name": "android_capture_clip",
  "arguments": {
    "requestId": "clip-example-001",
    "expectedPackage": "org.example.game",
    "expectedDisplay": { "width": 1080, "height": 2400 },
    "durationMs": 3000
  }
}
```

An optional `tap: {"x": 500, "y": 800}` attempts one tap after the recorder-open
signal and a 600 ms pre-roll. It requires exact signed approval or a per-app
grant for **android_capture_clip** in `gameGrants` / `expertSandbox.grants`.
Granting `android_tap` does not authorize this combined operation. Without a tap,
explicit clip configuration authorizes recording; `requestId` is still required
because recording creates host media. No auto-wake or replay occurs. The
optional tap uses the separately installed Android gesture helper.

The requested 1–5 seconds are an observation window after the optional tap,
not the total container duration. Startup/pre-roll and recorder teardown can
add frames. The 30 fps setting is a ceiling: static screens may yield fewer
frames, and intervals can vary. The response includes actual decoded frame
indices, timestamps, dimensions and source checksum. Video timestamps and host
tap timestamps are separate clocks. Recorder-open does not prove a first video
frame arrived before input. At least one frame must decode successfully before
the capture is published as complete.

`android_clip_open({"id":"<clip ID>"})` returns up to six frames spread over
time. This overview may miss a brief event. Supply `frameIndices:[4,5,6]` to
inspect exact zero-based decoded frames. Returned images are historical video
pixels and have no native tap-coordinate mapping; obtain a fresh phone image
before acting. Frames decode on demand without an expanded PNG cache.

On a lost response, query `android_activity_open` with the original `requestId`
and verify its request binding. A recorded ID cannot execute again, even when
capture failed or its media expired. Acknowledged tap execution can coexist with
a failed recording; the receipt reports these separately. No error triggers a
fallback screenshot, a second tap, or a restart of the app.

## Retention and keepsakes

The `dataDirectory/clips` cache defaults to 7 days, 256 MiB and 32 entries. A
single clip is capped at 64 MiB. Admission reserves 65 MiB including metadata;
older verified feature-owned cache entries may be removed to make room. Expiry
is an upper bound, not a promise of availability until that time. Cleanup runs
at capture admission, clip listing and periodic maintenance. It never accesses
phone-gallery storage, deletes arbitrary directories or follows storage links.
Unknown/malformed entries are preserved and reported for owner inspection.
Failed/pending capture entries and available partial media consume cache budget
and expire under the same policy; action replay tombstones remain in the journal.

To keep a moment, enable `shortClips.keepsakes.enabled` locally. Then call
`android_clip_keep` with `id`, `title`, a unique `requestId`, optional `note`, and
optional `frameIndex`. Whole clips copy their video and provenance; a selected
frame copies its PNG and provenance. Repeated saves keep the first title/note.
No new phone observation occurs. The independent `dataDirectory/clip-keepsakes`
copies survive cache expiry. List them with
`android_clip_open({"collection":"keepsakes"})`, then use `keepsakeId` to open
the kept copy, including after the original `id` no longer exists.

Keepsakes default to 256 MiB and 1000 entries, with configurable finite limits.
At 80% of either limit the response recommends migration. A full budget rejects
new saves without deleting existing ones. Incomplete writes remain inspectable
and can require owner intervention; an error never erases the action receipt.

For migration, stop the service and run the owner-only export utility into a new
private directory. This command exports clip/frame keepsakes; the separate
`export-keepsakes.mjs` command exports screenshots only.

```sh
node --env-file=.env scripts/export-clip-keepsakes.mjs /absolute/new-private-directory
```

Export works with capture/keeping disabled. It copies media, allocation markers,
`record.json` and `source.json`, verifies every file, and writes `manifest.json`
only after success. Empty, incomplete or unrecognized source entries cannot
produce a successful export manifest. A failed export preserves its partial
destination and source for inspection. After verifying the successful export,
move the whole original collection outside the active data directory using the
owner's filesystem tools. A restarted service creates a fresh active
collection; archived collections remain the owner's responsibility. Preserve
the journal and replay ledger. No model tool accepts an export path, moves a
collection, or deletes keepsakes. This policy controls host files only; MCP
client/cloud copies follow their own retention settings.
