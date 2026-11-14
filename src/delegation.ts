import { createHash } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ActivityJournal } from "./activity.js";
import { OwnerSecurity, PolicyError, deny } from "./security.js";
import { readPrivate } from "./private-files.js";
import { actionBinding } from "./operation.js";
import { activityReceipt } from "./receipt.js";
import { withoutDeadline } from "./deadline.js";
import { LIMITS } from "./limits.js";
import { delegateSchemas } from "./delegation-tools.js";
import { decisionSchema, reportActions, requestDecision, type ModelRequest, type ModelResult } from "./delegation-model.js";
import { availableEvent, textSource, bindFinding } from "./delegation-evidence.js";
import { navigation } from "./delegation-navigation.js";

const json = (value: any): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const objects = (r: CallToolResult): any[] => r.content.flatMap(c => {
  if (c.type !== "text") return []; try { return [JSON.parse(c.text)]; } catch { return []; }
});
const runIdFor = (id: string) => "delegate-" + createHash("sha256").update(id).digest("hex").slice(0, 24);
const code = (error: unknown) => error instanceof PolicyError ? error.code : "DELEGATION_FAILED: no automatic retry";
type Budget = { modelCalls: number; seconds: number; totalTokens: number };
type Scope = { app: string; url?: string; origin?: string; goal: string; doneWhen: string };
type Job = { runId: string; version: number; createdAt: number; status: string; budget: Budget;
  attempts: number; tokens: number; usageUnknown: boolean; activeMs: number; modelWaitMs: number; serial: number;
  inputSettled: boolean; pending?: { requestId: string; tool: string; argsDigest: string };
  lastFrame?: { eventId: number; at: string; intentVersion: number }; obstacle?: string;
  scope?: Scope; result?: any; running?: Promise<void>; controller?: AbortController; clockStart?: number;
};
export type DelegationPorts = {
  // This is an in-process capability, never a model-selected endpoint or token.
  call(name: string, args: Record<string, any>, current: () => boolean): Promise<CallToolResult>;
  idle(): boolean; imageAvailable(event: any): boolean; latency(app: string): any;
};

/** A single finite worker; only the normal Executor can touch the device. */
export class DelegationHost {
  private jobs: Job[] = [];
  private closed = false;
  private persistenceAvailable = true;
  private static metadataName = "delegation-v1";
  constructor(private security: OwnerSecurity, private journal: ActivityJournal, private ports: DelegationPorts,
    private model = (request: ModelRequest, key: string, signal: AbortSignal): Promise<ModelResult> =>
      requestDecision({ ...security.config.delegation, model: security.config.delegation.model! }, request, key, signal)) {
    let saved;
    try { saved = journal.meta(DelegationHost.metadataName); }
    catch { this.persistenceAvailable = false; return; }
    this.jobs = Array.isArray(saved) ? saved.slice(-8) : [];
    for (const j of this.jobs) {
      // A restart is never an instruction to resume. Recover only a bound input
      // receipt; a missing or mismatched receipt remains explicitly uncertain.
      if (j.pending) j.inputSettled = this.settled(this.journal.findRequest(j.pending.requestId), j.pending, true);
      if (["running", "stop_requested"].includes(j.status) || !j.inputSettled) j.status = j.inputSettled ? "interrupted" : "input_unresolved";
    }
    try { this.prune(); } catch { this.persistenceAvailable = false; }
  }
  busy() { return this.jobs.some(j => !!j.running || !j.inputSettled); }
  private current(j: Job, version: number) { return !this.closed && j.version === version && j.status === "running"; }
  private elapsed(j: Job) { return j.activeMs + (j.clockStart === undefined ? 0 : performance.now() - j.clockStart); }
  private save() {
    // No goals, input text, URLs, API keys, model prompts/responses or copied
    // evidence live in this restart marker. The normal journal owns evidence.
    this.journal.setMeta(DelegationHost.metadataName, this.jobs.map(j => ({ runId: j.runId, version: j.version, createdAt: j.createdAt,
      status: j.status, budget: j.budget, attempts: j.attempts, tokens: j.tokens, usageUnknown: j.usageUnknown,
      activeMs: this.elapsed(j), modelWaitMs: j.modelWaitMs, serial: j.serial, inputSettled: j.inputSettled,
      pending: j.pending, lastFrame: j.lastFrame, obstacle: j.obstacle })));
  }
  prune() {
    this.jobs = this.jobs.filter(j => j.running || !j.inputSettled || j.createdAt > Date.now() - LIMITS.retentionMs);
    this.save();
  }
  private accessKey() {
    if (!this.persistenceAvailable) deny("DELEGATION_STORAGE_UNAVAILABLE");
    const cfg = this.security.config.delegation;
    if (!cfg.enabled || !cfg.acceptsModelEgress || !this.security.config.retainObservationText) deny("DELEGATION_DISABLED_OR_CONSENT_MISSING");
    if (!cfg.model || !cfg.keyFile) deny("DELEGATION_MODEL_NOT_CONFIGURED");
    try {
      const key = readPrivate(cfg.keyFile!, 4096).trim();
      if (!/^[\x21-\x7e]{16,2048}$/.test(key)) throw new Error();
      return key;
    } catch { return deny("DELEGATION_KEY_UNAVAILABLE"); }
  }
  private snapshot(j: Job) {
    const evidenceIds = [...(j.result?.evidence ?? []).map((s: any) => s.readEventId), ...(j.result?.visualEvidence ?? []).map((s: any) => s.eventId)];
    const evidenceAvailable = evidenceIds.every(id => availableEvent(this.journal.open(id)))
      && (j.result?.visualEvidence ?? []).every((v: any) => this.ports.imageAvailable(this.journal.open(v.eventId)));
    const last = j.lastFrame && this.journal.open(j.lastFrame.eventId);
    return { runId: j.runId, intentVersion: j.version, status: j.status, handoffReady: !j.running && j.inputSettled,
      inputSettled: j.inputSettled, pending: j.pending ?? null, budget: j.budget,
      usage: { modelCalls: j.attempts, totalTokens: j.usageUnknown ? null : j.tokens, knownTokens: j.tokens,
        activeMs: Math.round(this.elapsed(j)), modelWaitMs: Math.round(j.modelWaitMs), scope: "host elapsed active work, includes model waits; not physical input latency" },
      finding: evidenceAvailable ? j.result ?? null : null,
      findingStatus: !evidenceAvailable ? "evidence_expired_or_removed" : j.result ? "pending_operator_review" : !j.scope ? "not_retained_across_restart" : "not_available",
      obstacle: j.obstacle ?? null, lastFrame: j.lastFrame ? { ...j.lastFrame, historical: true,
        evidenceAvailable: availableEvent(last), screenshotAvailable: this.ports.imageAvailable(last) } : null };
  }
  async call(name: string, raw: any): Promise<CallToolResult> {
    try {
      const a: any = delegateSchemas[name as keyof typeof delegateSchemas].parse(raw);
      if (name === "android_delegate_status") {
        if (!!a.runId === !!a.startRequestId) deny("PROVIDE_ONE_DELEGATION_ID");
        const j = this.jobs.find(j => j.runId === (a.runId ?? runIdFor(a.startRequestId))) ?? deny("DELEGATION_NOT_FOUND_OR_EXPIRED");
        if (a.waitMs && j.running) await Promise.race([j.running, new Promise<void>(resolve => { const t = setTimeout(resolve, a.waitMs); t.unref(); })]);
        return json({ phoneDelegation: this.snapshot(j) });
      }
      const prior = this.journal.findRequest(a.requestId);
      if (prior) return { isError: true, ...json({ error: prior.requestBinding?.argsDigest === actionBinding(name, raw).argsDigest
        ? "REQUEST_ALREADY_RECORDED: no mutation repeated" : "REQUEST_BINDING_MISMATCH_OR_UNKNOWN", phoneReceipt: activityReceipt(prior) }) };
      this.security.authorize(name, raw);
      let j: Job, key: string | undefined;
      if (name === "android_delegate_start") {
        if (!!a.app === !!a.url) deny("PROVIDE_ONE_DELEGATION_APP_OR_URL");
        if (this.closed || this.busy() || !this.ports.idle()) deny("DELEGATION_PHONE_BUSY");
        const app = a.url ? this.security.config.browserPackage : a.app;
        this.security.package(app);
        if (!a.url && app === this.security.config.browserPackage) deny("DELEGATION_CHROME_REQUIRES_URL");
        const url = a.url ? this.security.url(a.url) : undefined;
        key = this.accessKey(); this.prune();
        j = { runId: runIdFor(a.requestId), version: 1, createdAt: Date.now(), status: "running", budget: a.budget,
          attempts: 0, tokens: 0, usageUnknown: false, activeMs: 0, modelWaitMs: 0, serial: 0, inputSettled: true,
          scope: { app, url, origin: url ? new URL(url).origin : undefined, goal: a.goal, doneWhen: a.doneWhen } };
      } else {
        j = this.jobs.find(j => j.runId === a.runId) ?? deny("DELEGATION_NOT_FOUND_OR_EXPIRED");
        if (j.version !== a.expectedVersion) deny("DELEGATION_VERSION_CONFLICT");
        if (name === "android_delegate_update") {
          if (!j.scope) deny("DELEGATION_INTERRUPTED_START_NEW_JOB");
          if (!j.inputSettled && !j.running) deny("DELEGATION_INPUT_UNRESOLVED");
          if (j.usageUnknown) deny("DELEGATION_USAGE_UNKNOWN");
          if (this.closed || (!j.running && (this.busy() || !this.ports.idle()))) deny("DELEGATION_PHONE_BUSY");
          key = this.accessKey();
        }
      }
      const eventId = this.journal.begin(name, raw, a.context, "host-delegation", a.requestId);
      try {
        this.journal.recordExecution(eventId, "unconfirmed");
        if (name === "android_delegate_start") { this.jobs = this.jobs.slice(-7); this.jobs.push(j); }
        else {
          j.version++; j.result = undefined; j.obstacle = undefined;
          if (name === "android_delegate_stop") {
            j.status = j.running ? "stop_requested" : j.inputSettled ? "stopped" : "input_unresolved";
            j.controller?.abort();
          } else {
            Object.assign(j.scope!, { goal: a.goal, doneWhen: a.doneWhen });
            if (a.budget) j.budget = a.budget;
            j.status = "running";
          }
        }
        this.save(); this.journal.recordExecution(eventId, "acknowledged");
        this.journal.finish(eventId, "completed", { hostDelegation: { runId: j.runId, intentVersion: j.version }, result: { isError: false } });
        if (key && !j.running) this.launch(j, key);
        return json({ phoneDelegation: this.snapshot(j), phoneReceipt: { ...activityReceipt(this.journal.open(eventId)), effectScope: "host-delegation" } });
      } catch {
        j.status = "failed"; j.controller?.abort();
        return { isError: true, ...json({ error: "DELEGATION_STATE_WRITE_FAILED: inspect receipt; no automatic restart" }) };
      }
    } catch (error) { return { isError: true, ...json({ error: error instanceof PolicyError ? error.code : "DELEGATION_INVALID_OR_UNAVAILABLE" }) }; }
  }
  private launch(j: Job, key: string) {
    // Set ownership synchronously before any external call can enter the queue.
    j.running = withoutDeadline(() => Promise.resolve().then(() => this.run(j, key)).finally(() => { j.running = undefined; }));
  }
  private settled(receipt: any, pending: NonNullable<Job["pending"]>, stored = false) {
    const r = stored && receipt ? activityReceipt(receipt) : receipt;
    return r?.requestId === pending.requestId && r?.requestBinding?.tool === pending.tool && r?.requestBinding?.argsDigest === pending.argsDigest
      && ["completed", "error", "policy_drift"].includes(r.callOutcome) && ["acknowledged", "not_started"].includes(r.execution);
  }
  private async tool(j: Job, version: number, name: string, args: any = {}) {
    if (!this.current(j, version)) deny("DELEGATION_SUPERSEDED");
    const input = this.security.isInput(name, args);
    const all = { ...args, expectedPackage: j.scope!.app, ...(j.scope!.url ? { expectedUrl: j.scope!.url } : {}),
      ...(input ? { requestId: j.runId + "-" + (++j.serial), imageMode: "deferred" } : {}) };
    // Preflight uses the same public authority. No signer or implicit grant exists.
    this.security.authorize(name, all);
    if (input) { j.pending = { requestId: all.requestId, ...actionBinding(name, all) }; j.inputSettled = false; this.save(); }
    let r: CallToolResult;
    try { r = await this.ports.call(name, all, () => this.current(j, version)); }
    catch { r = { isError: true, content: [] }; }
    const list = objects(r), receipt = list.find(o => o.phoneReceipt)?.phoneReceipt;
    const refusedBeforeInput = list.some(o => o.phoneAdmission?.inputAttempted === false);
    if (input) {
      j.inputSettled = refusedBeforeInput || this.settled(receipt, j.pending!);
      if (!j.inputSettled) j.inputSettled = this.settled(this.journal.findRequest(j.pending!.requestId), j.pending!, true);
      if (j.inputSettled) j.pending = undefined;
      this.save();
      if (!j.inputSettled) deny("DELEGATION_INPUT_UNRESOLVED");
    }
    if (!this.current(j, version) && (!input || refusedBeforeInput)) deny("DELEGATION_SUPERSEDED");
    if (r.isError) deny("DELEGATION_TOOL_REFUSED_OR_FAILED: inspect the bound receipt; no retry");
    if (receipt?.tool !== name || !Number.isInteger(receipt?.eventId)) deny("DELEGATION_RECEIPT_UNBOUND");
    return { r, list, receipt, entry: this.journal.open(receipt.eventId) };
  }
  private async run(j: Job, key: string) {
    const sources = new Map<number, any>(), images = new Set<number>();
    j.clockStart = performance.now();
    let version = 0, intentStart = j.attempts, frame: any, image: string | undefined, feedback: string | null = null, notes = "";
    const capture = async () => {
      const shot = await this.tool(j, version, "android_take_screenshot");
      if (!availableEvent(shot.entry) || shot.entry.observation.foregroundApp?.packageName !== j.scope!.app) deny("DELEGATION_EVIDENCE_UNAVAILABLE");
      frame = { eventId: shot.entry.id, at: shot.entry.observation.at, elements: shot.entry.observation.elements,
        foregroundApp: shot.entry.observation.foregroundApp };
      image = undefined;
      const picture = shot.r.content.find(c => c.type === "image");
      const metadata = shot.list.find(o => o.phoneImage)?.phoneImage;
      if (this.security.config.delegation.allowImages && picture?.type === "image" && metadata?.sourceEventId === frame.eventId
        && this.ports.imageAvailable(shot.entry)) image = picture.data;
      j.lastFrame = { eventId: frame.eventId, at: frame.at, intentVersion: version };
      sources.set(frame.eventId, textSource(shot.entry));
      if (j.scope!.url) {
        const web = await this.tool(j, version, "android_chrome_read", { maxChars: 12000, maxElements: 100 });
        const body = web.list.find(o => o.source === "Chrome DOMSnapshot + Accessibility");
        if (body?.url !== j.scope!.url) deny("DELEGATION_DOCUMENT_CHANGED");
        sources.set(web.entry.id, textSource(web.entry, body));
      }
      while (sources.size > 6) sources.delete(sources.keys().next().value!);
      while (images.size > 6) images.delete(images.keys().next().value!);
      this.save();
    };
    try {
      for (;;) {
        try {
        if (j.status !== "running" || this.closed) break;
        if (j.attempts >= j.budget.modelCalls || j.tokens >= j.budget.totalTokens || this.elapsed(j) >= j.budget.seconds * 1000) { j.status = "budget_exhausted"; break; }
        if (version !== j.version || !frame) {
          version = j.version; intentStart = j.attempts; feedback = null; notes = ""; j.result = undefined;
          await capture();
        }
        if (!this.current(j, version)) { frame = undefined; continue; }
        const remaining = Math.min(4 - (j.attempts - intentStart), j.budget.modelCalls - j.attempts);
        if (remaining <= 0) { j.status = "budget_exhausted"; break; }
        const reportRequired = remaining === 1;
        for (const id of sources.keys()) if (!availableEvent(this.journal.open(id))) sources.delete(id);
        if (!availableEvent(this.journal.open(frame.eventId))) deny("DELEGATION_CURRENT_EVIDENCE_EXPIRED");
        let timingContext; try { timingContext = this.ports.latency(j.scope!.app); } catch { /* optional */ }
        const request: ModelRequest = { input: { goal: j.scope!.goal, doneWhen: j.scope!.doneWhen,
          scope: { app: j.scope!.app, url: j.scope!.url, origin: j.scope!.origin }, intentVersion: version, frame,
          sources: [...sources.values()], imageEventId: image ? frame.eventId : null, timingContext, localNotes: notes, feedback, reportRequired,
          remaining: { intentModelCalls: remaining, modelCalls: j.budget.modelCalls - j.attempts, seconds: Math.max(0, j.budget.seconds - this.elapsed(j) / 1000) } },
          image, maxOutputTokens: Math.min(8192, Math.max(16, j.budget.totalTokens - j.tokens)) };
        if (image) images.add(frame.eventId);
        j.attempts++; this.save(); j.controller = new AbortController(); const modelStart = performance.now();
        let response: ModelResult;
        try { response = await this.model(request, key, AbortSignal.any([j.controller.signal,
          AbortSignal.timeout(Math.max(1, Math.floor(Math.min(60000, j.budget.seconds * 1000 - this.elapsed(j)))))])); }
        catch (error) { j.usageUnknown = true; throw error; }
        finally { j.modelWaitMs += performance.now() - modelStart; j.controller = undefined; }
        j.tokens += response.totalTokens; this.save();
        if (!this.current(j, version)) { frame = undefined; continue; }
        if (this.elapsed(j) >= j.budget.seconds * 1000 || j.tokens > j.budget.totalTokens) { j.status = "budget_exhausted"; break; }
        let d;
        try {
          d = decisionSchema.parse(response.answer);
          if (d.intentVersion !== version || d.eventId !== frame.eventId || (reportRequired && !reportActions.includes(d.action as any))) deny("DELEGATION_DECISION_STALE_OR_REPORT_REQUIRED");
          notes = d.localNotes;
          if (reportActions.includes(d.action as any)) {
            j.result = bindFinding(d, sources, images, id => this.ports.imageAvailable(this.journal.open(id)) || !d!.finding!.visualEventIds.includes(id)
              ? this.journal.open(id) : null);
            j.status = d.action === "blocked" ? "blocked" : d.action === "yield" ? "yielded" : "completed_pending_review"; break;
          }
          if (d.finding !== null) deny("DELEGATION_NAVIGATION_CANNOT_REPORT");
        } catch (error) {
          feedback = error instanceof PolicyError ? error.code : "DELEGATION_DECISION_SCHEMA_REJECTED";
          if (reportRequired) { j.status = "blocked"; j.obstacle = "DELEGATION_FINAL_REPORT_REJECTED: " + feedback; break; }
          continue; // Invalid proposal only: no input was sent.
        }
        if (d.action === "observe") { await capture(); continue; }
        if (d.action === "open_url") {
          const url = this.security.url(d.value);
          if (!j.scope!.origin || new URL(url).origin !== j.scope!.origin) deny("DELEGATION_URL_OUTSIDE_SCOPE");
          await this.tool(j, version, "android_open_url", { url }); j.scope!.url = url;
        } else if (d.action === "back") await this.tool(j, version, "android_press_key", { key: "BACK" });
        else {
          const fresh = await this.tool(j, version, "android_list_elements");
          const elements = fresh.list.find(o => Array.isArray(o.elements))?.elements;
          if (!elements) deny("DELEGATION_FRESH_UI_UNAVAILABLE");
          const op = navigation(d, frame, elements, !!j.scope!.url);
          await this.tool(j, version, op.name, op.args);
        }
        if (!this.current(j, version)) { frame = undefined; continue; }
        await capture();
        } catch (error) {
          if (error instanceof PolicyError && error.code === "DELEGATION_SUPERSEDED" && j.status === "running" && version !== j.version) { frame = undefined; continue; }
          throw error;
        }
      }
    } catch (error) {
      if (j.status !== "stop_requested") { j.status = j.inputSettled ? "blocked" : "input_unresolved"; j.obstacle = code(error); }
    } finally {
      j.activeMs = this.elapsed(j); j.clockStart = undefined;
      if (j.status === "stop_requested" || this.closed) j.status = j.inputSettled ? "stopped" : "input_unresolved";
      try { this.save(); } catch { j.obstacle = "DELEGATION_STATE_WRITE_FAILED"; }
    }
  }
  async close() {
    this.closed = true;
    for (const j of this.jobs) { if (j.running) j.status = "stop_requested"; j.controller?.abort(); }
    await Promise.all(this.jobs.map(j => j.running));
  }
}
