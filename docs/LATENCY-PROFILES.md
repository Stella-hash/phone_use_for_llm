# Passive latency profiles

`android_latency_profile` reads host timings already collected during ordinary
phone observations. It never contacts or wakes the phone, calls a model, sends a
calibration input, or changes action timing. No model configuration is needed.

Pass `app` to select a package, or omit it for the most recently sampled app.
The default response is compact; `detail: true` includes distributions grouped
by tool, UI backend and wake condition, plus source event IDs. After five usable
samples an ordinary observation can include one compact hint; another appears
only after a material change. Caller labels only suppress repeated hints.

The monotonic host clock measures UI collection, screenshot capture and archive
work, queue delay, and server work. Nested measurements are not additive.
Supplied UI elements do not count as a new UI collection sample. Failed samples
remain distinguishable and do not contribute to successful timing distributions.
Orientation is not measured. These numbers do **not** measure device acceptance,
input-to-visible-change time, actual gesture duration, or client/network delay.

Original phase measurements belong to their activity events. The derived cache
holds at most 48 calls / 15 KB, with at most 32 comparable samples per metric.
Expired or removed source events are excluded, and maintenance prunes the cache.
Private calls contribute no samples. A cache failure cannot turn a successful
phone action into a failure or invalidate its receipt.
