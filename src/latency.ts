import { createHash } from "node:crypto";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { LIMITS } from "./limits.js";

type Store = { meta(key: string): any; setMeta(key: string, value: any): void; open(id: number): any };
type Sample = { eventId: number; at: string; app: string; tool: string; backend: string;
  wake: boolean | null; failed: boolean; metrics: Record<string, number> };
const number = (n: unknown): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0;
function distribution(values: number[]) {
  const sorted = values.slice(-32).sort((a, b) => a - b), n = sorted.length;
  if (!n) return { n: 0 };
  return { n, medianMs: Math.round((sorted[Math.floor((n - 1) / 2)] + sorted[Math.floor(n / 2)]) / 2),
    minMs: Math.round(sorted[0]), maxMs: Math.round(sorted[n - 1]) };
}
export const latencySchema = z.object({ app: z.string().regex(/^[\w]+(?:\.[\w]+)+$/).max(180).optional(),
  detail: z.boolean().default(false) }).strict();
export const latencyTool: Tool = { name: "android_latency_profile", title: "Read Phone Latency Profile",
  description: "Read passively accumulated host timings for this device and an app (default: most recently sampled app). No phone read, wake, model call or timing adjustment. Default is compact; detail=true includes per-tool/backend/wake distributions and source event IDs. Host times are not device input acceptance or input-to-visible-change latency.",
  inputSchema: { type: "object", properties: { app: { type: "string", maxLength: 180 }, detail: { type: "boolean", default: false } }, additionalProperties: false },
  annotations: { readOnlyHint: true } };

/** A derived, bounded cache. Original measurements remain in the activity journal. */
export class LatencyProfiles {
  private key: string;
  private deviceKey: string;
  constructor(private store: Store, device: string) {
    this.deviceKey = createHash("sha256").update(device).digest("hex").slice(0, 16);
    this.key = "latency-v1";
  }
  private data(): { revision: number; samples: Sample[]; deliveries: Record<string, any> } {
    const saved = this.store.meta(this.key);
    const data = saved?.deviceKey === this.deviceKey ? saved : { revision: 0, samples: [], deliveries: {} };
    data.samples = data.samples.filter((s: Sample) => Date.parse(s.at) > Date.now() - LIMITS.retentionMs
      && this.store.open(s.eventId)?.callerClaim?.private !== true && !!this.store.open(s.eventId));
    data.deliveries = Object.fromEntries(Object.entries(data.deliveries).filter(([, v]: any) => v.at > Date.now() - LIMITS.retentionMs));
    return data;
  }
  private save(data: any) {
    data.deviceKey = this.deviceKey;
    data.samples = data.samples.slice(-48);
    while (Buffer.byteLength(JSON.stringify(data)) > 15000 && data.samples.length) data.samples.shift();
    this.store.setMeta(this.key, data);
  }
  prune() { this.save(this.data()); }
  record(input: { eventId: number; at: string; tool: string; observation: any; queueMs: number; workMs: number; failed: boolean; private?: boolean }) {
    const o = input.observation, app = o?.foregroundApp?.packageName;
    if (input.private || typeof app !== "string" || app.length > 200 || !o?.timing || o.timing.clock !== "host_monotonic_ms") return;
    const metrics: Record<string, number> = {};
    for (const [name, value] of Object.entries(o.timing)) {
      if (!name.endsWith("Ms") || !number(value)) continue;
      if (name === "uiMs" && o.timing.uiSource !== "fresh") continue;
      metrics[name === "totalMs" ? "observationMs" : name] = value;
    }
    if (number(input.queueMs)) metrics.queueMs = input.queueMs;
    if (number(input.workMs)) metrics.serverWorkMs = input.workMs;
    const data = this.data();
    if (data.samples.some(s => s.eventId === input.eventId)) return;
    data.samples.push({ eventId: input.eventId, at: input.at, app, tool: input.tool,
      backend: o.uiCapture?.backend ?? "unreported", wake: o.preparation?.wakeRequested ?? null,
      failed: input.failed || !!o.errors?.length, metrics });
    data.revision++;
    this.save(data);
  }
  read(app?: string, detail = false): any {
    const data = this.data(), selectedApp = app ?? data.samples.at(-1)?.app ?? null;
    const samples = data.samples.filter(s => s.app === selectedApp), latest = samples.at(-1);
    const conditionSample = samples.filter(s => !s.failed && number(s.metrics.uiMs)).at(-1) ?? latest;
    const backend = conditionSample?.backend ?? null, wake = conditionSample?.wake ?? null;
    const comparable = samples.filter(s => !s.failed && s.backend === backend && s.wake === wake);
    const phase = (name: string) => distribution(comparable.flatMap(s => number(s.metrics[name]) ? [s.metrics[name]] : []));
    const result: any = { deviceKey: this.deviceKey, app: selectedApp, revision: data.revision,
      throughEventId: latest?.eventId ?? null, throughAt: latest?.at ?? null,
      sampledCalls: samples.length, failedCalls: samples.filter(s => s.failed).length,
      conditions: { backend, wakeRequested: wake, orientation: "not recorded", basedOnEventId: conditionSample?.eventId ?? null },
      uiRead: phase("uiMs"), imageCapture: phase("screenshotCaptureAndVerifyMs"),
      scope: "Host measurements; matching app/backend/wake. Last 32 samples per metric within at most 48 retained calls and 15 KB. Source expiry removes derived samples. Nested phases are not additive.",
      advisoryOnly: true,
      unmeasured: ["client/network latency", "device input acceptance", "input-to-visible-change time", "actual gesture duration error"] };
    if (detail) {
      const groups = new Map<string, Sample[]>();
      for (const s of samples) {
        const key = `${s.tool}/${s.backend}/wake=${s.wake}`;
        groups.set(key, [...(groups.get(key) ?? []), s]);
      }
      result.groups = [...groups].map(([group, rows]) => {
        const good = rows.filter(s => !s.failed), names = new Set(good.flatMap(s => Object.keys(s.metrics)));
        return { group, sampledCalls: rows.length, failedCalls: rows.length - good.length,
          metrics: Object.fromEntries([...names].map(n => [n, distribution(good.flatMap(s => number(s.metrics[n]) ? [s.metrics[n]] : []))])),
          sourceEventIds: rows.slice(-32).map(s => s.eventId) };
      });
    }
    return result;
  }
  /** Delivery cursors suppress repetitive hints; they carry no caller authority. */
  notice(app: string | undefined, caller: { actor?: string; session?: string }): any | undefined {
    const profile = this.read(app), n = profile.uiRead.n;
    if (!profile.app || n < 5) return;
    const key = createHash("sha256").update(JSON.stringify([caller.actor ?? "", caller.session ?? "", profile.app])).digest("hex");
    const data = this.data(), prior = data.deliveries[key];
    const conditions = { backend: profile.conditions.backend, wakeRequested: profile.conditions.wakeRequested };
    const changed = prior && profile.revision >= prior.revision + 5 &&
      (JSON.stringify(prior.conditions) !== JSON.stringify(conditions) ||
        (Math.abs(profile.uiRead.medianMs - prior.uiMs) >= 250 &&
         Math.max(profile.uiRead.medianMs, prior.uiMs) >= Math.max(1, Math.min(profile.uiRead.medianMs, prior.uiMs)) * 1.75));
    if (prior && !changed) return;
    data.deliveries[key] = { revision: profile.revision, uiMs: profile.uiRead.medianMs, conditions, at: Date.now() };
    const entries = Object.entries(data.deliveries).sort((a, b) => a[1].at - b[1].at).slice(-8);
    data.deliveries = Object.fromEntries(entries); this.save(data);
    return { reason: prior ? "material_change" : "initial_sample_ready", app: profile.app, throughEventId: profile.throughEventId,
      uiRead: profile.uiRead, imageCapture: profile.imageCapture, conditions: profile.conditions,
      note: "Observed host work only. No extra wait or compensation was applied. Read android_latency_profile for details." };
  }
}
