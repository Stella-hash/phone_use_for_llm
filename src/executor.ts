import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { AdbClient } from "./adb.js";
import { UiInspector } from "./ui.js";
import { ActivityJournal, ActivitySummarizer } from "./activity.js";
import { ImageStore } from "./image-store.js";
import { KeepsakeStore, KeepsakeError } from "./keepsakes.js";
import { OwnerSecurity, PolicyError, deny, passiveTools } from "./security.js";
import { boundedValue, LIMITS } from "./limits.js";
import { readPowerStatus } from "./power.js";
import { requireAwake, requireUnlocked, preparePhoneScreen, observePhone } from "./observation.js";
import { remainingTime, withDeadline } from "./deadline.js";
import { setUnicodeText } from "./unicode.js";
import { performGesture } from "./gesture.js";
import { captureChromePage } from "./chrome.js";
import { readingCursor } from "./reading.js";
import { activityReceipt } from "./receipt.js";
import { delayObservation, type ObservationDelay } from "./observation-delay.js";
import { boundResultImages, DEFAULT_IMAGE_EDGE } from "./image-delivery.js";
import { canonicalArguments, isPowerKey, actionBinding, hostStorageTools } from "./operation.js";
import { ClipStore, ClipStoreError } from "./clip-store.js";
import { captureShortClip, ClipCaptureError } from "./clip-capture.js";
import { openClip, clipKeepSchema } from "./clip-tools.js";

const json = (value: any): CallToolResult => ({ content: [{ type: "text", text: JSON.stringify(value) }] });
const failure = (code: string): CallToolResult => ({ isError: true, content: [{ type: "text", text: code }] });
const safeError = (error: unknown) => error instanceof PolicyError ? error.code : "OPERATION_FAILED: inspect the receipt before retrying";

export class Executor {
  private queue: Promise<unknown> = Promise.resolve();
  private queued = 0;
  private adb = new AdbClient();
  private ui = new UiInspector(this.adb, 1);
  readonly journal: ActivityJournal;
  private images: ImageStore;
  private keepsakes?: KeepsakeStore;
  private clips?: ClipStore;
  private captureClip = captureShortClip;
  private summarizer: ActivitySummarizer;
  private validators;
  private maintenance: ReturnType<typeof setInterval>;
  constructor(private security: OwnerSecurity, private device: string, private client: Client, catalog: Tool[]) {
    this.journal = new ActivityJournal(security.directory);
    this.images = new ImageStore(security.directory);
    if (security.config.screenshotKeepsakes.enabled) this.keepsakes = new KeepsakeStore(security.directory, security.config.screenshotKeepsakes);
    const clips = security.config.shortClips;
    if (clips.enabled) this.clips = new ClipStore(security.directory, {
      cacheMaxAgeMs: clips.cache.maxAgeMs, cacheMaxBytes: clips.cache.maxBytes, cacheMaxCount: clips.cache.maxCount,
      keepsakesEnabled: clips.keepsakes.enabled, keepsakeMaxBytes: clips.keepsakes.maxBytes, keepsakeMaxCount: clips.keepsakes.maxCount,
    });
    this.summarizer = new ActivitySummarizer(this.journal, security.config.allowModelSummary);
    const provider = new AjvJsonSchemaValidator();
    this.validators = new Map(catalog.map(tool => [tool.name, provider.getValidator(tool.inputSchema)]));
    this.maintenance = setInterval(() => { try { this.journal.maintain(); this.images.prune(); this.clips?.prune(); } catch { /* next admission fails closed */ } }, 60000);
    this.maintenance.unref();
  }
  call(name: string, all: Record<string, any>): Promise<CallToolResult> {
    try {
      boundedValue(all);
      if (!this.validators.get(name)?.(all).valid) return Promise.resolve(failure("INVALID_ARGUMENTS"));
      all = { ...canonicalArguments(name, all), ...(all.approval ? { approval: all.approval } : {}) };
      if (this.queued >= LIMITS.queue) return Promise.resolve(failure("QUEUE_FULL: no input attempted"));
    } catch (error) { return Promise.resolve(failure(safeError(error))); }
    const receivedAt = Date.now();
    this.queued++;
    const run = () => withDeadline(Math.max(0, 25000 - (Date.now() - receivedAt)), () => this.execute(name, all));
    const result = this.queue.then(run, run).catch(error => failure(safeError(error)));
    this.queue = result.finally(() => { this.queued--; });
    return result;
  }
  private guard(expectedPackage?: string) {
    requireAwake(this.adb, this.device);
    const pkg = this.adb.getFocusedPackage(this.device);
    this.security.package(pkg);
    if (expectedPackage && expectedPackage !== pkg) deny("FOREGROUND_CHANGED");
    return pkg;
  }
  private async browserGuard(pkg: string, expectedUrl: unknown) {
    if (pkg !== this.security.config.browserPackage) return;
    this.security.url(expectedUrl);
    await captureChromePage(this.adb, this.device, { expectedUrl }, undefined, { url: value => this.security.url(value), verifyOnly: true });
  }
  private async execute(name: string, all: Record<string, any>): Promise<CallToolResult> {
    remainingTime();
    const history = name.startsWith("android_activity_");
    const archive = hostStorageTools.has(name);
    const clipTool = name === "android_capture_clip" || name === "android_clip_open" || name === "android_clip_keep";
    const status = name === "android_device_info" || name === "android_power_status";
    const input = this.security.isInput(name, all);
    const textInput = name === "android_set_text" || name === "android_type_text";
    const powerKey = name === "android_press_key" && isPowerKey(all.key);
    const { context = {}, requestId, approval, expectedPackage, expectedUrl, wake, observeAfterMs, imageMaxEdge, imageMode, ...args } = all;
    if (input && requestId) {
      const prior = this.journal.findRequest(requestId);
      if (prior) return { isError: true, content: [{ type: "text", text: prior.requestBinding?.argsDigest === actionBinding(name, all).argsDigest ? "REQUEST_ALREADY_RECORDED: no new input attempted; do not bypass recovery with a new ID" : "REQUEST_BINDING_MISMATCH_OR_UNKNOWN: no new input attempted; inspect original request" },
        { type: "text", text: JSON.stringify({ phoneReceipt: this.receipt(prior) }) }] };
    }
    try { this.security.authorize(name, all); }
    catch (error) {
      if (clipTool) return { isError: true, ...json({ error: safeError(error), status: this.clipStatus() }) };
      if (archive && !this.security.config.screenshotKeepsakes.enabled) return { isError: true, ...json({ error: safeError(error),
        status: { enabled: false, maxBytes: this.security.config.screenshotKeepsakes.maxBytes, maxCount: this.security.config.screenshotKeepsakes.maxCount, usedBytes: null, count: null } }) };
      return failure(safeError(error));
    }
    let eventId: number;
    try { eventId = this.journal.begin(name, all, context, archive ? "host-storage" : history ? "history" : status && !wake ? "status" : "phone", input ? requestId : undefined); }
    catch {
      // Storage pressure must not prevent recovery of an already executed action.
      if (history || (archive && !input)) eventId = 0;
      else return failure("JOURNAL_UNAVAILABLE: no input attempted");
    }
    let result: CallToolResult = failure("OPERATION_FAILED"), observation: any = null, preparation: any = null;
    let hostStorage: any;
    let imageEventId = eventId;
    let policyDrift = false;
    let delay: ObservationDelay | undefined = observeAfterMs === undefined ? undefined : { requestedMs: observeAfterMs, elapsedMs: 0, status: "action_failed" };
    try {
      if (archive && clipTool) {
        const clips = this.clips;
        if (!clips) throw new PolicyError("CLIPS_DISABLED");
        if (name === "android_clip_keep") {
          const query = clipKeepSchema.parse(args);
          this.journal.recordExecution(eventId, "unconfirmed");
          const saved = clips.keep(query.id, query.title, query.note, query.frameIndex);
          hostStorage = { mutation: "keep-existing-clip-media", phoneContacted: false, keepsakeId: saved.record.id, created: saved.created };
          this.journal.recordExecution(eventId, "acknowledged");
          result = json({ ...saved, hostStorage });
        } else result = openClip(clips, args, imageMaxEdge);
      } else if (archive) {
        const keepsakes = this.keepsakes;
        if (!keepsakes) throw new PolicyError("KEEPSAKES_DISABLED");
        if (name === "android_screenshot_keep") {
          const source = this.journal.open(args.eventId);
          if (!source) deny("RECORD_NOT_FOUND");
          if (source.callerClaim?.private) deny("PRIVATE_EVENT_CANNOT_SAVE_KEEPSAKE");
          let png: Buffer;
          try { png = this.images.open(source.observation?.screenshot); } catch { return this.finishArchiveFailure(eventId, "SOURCE_IMAGE_UNAVAILABLE", this.keepsakeStatus()); }
          this.journal.recordExecution(eventId, "unconfirmed");
          const capturedAt = source.observation?.screenshot?.captureFinishedAt || source.observation?.at || source.startedAt;
          const saved = keepsakes.save({ eventId: source.id, tool: source.tool, capturedAt,
            capturedAtSource: source.observation?.screenshot?.captureFinishedAt ? "capture-finished" : source.observation?.at ? "observation" : "event-start" }, png, { title: args.title, note: args.note });
          hostStorage = { mutation: "keep-existing-screenshot", phoneContacted: false, keepsakeId: saved.record.id, created: saved.created };
          this.journal.recordExecution(eventId, "acknowledged");
          result = json({ ...saved, hostStorage });
        } else {
          if (args.id !== undefined && (args.before !== undefined || args.limit !== undefined)) deny("PROVIDE_ID_OR_LIST_OPTIONS");
          if (args.id === undefined && args.includeScreenshot) deny("SCREENSHOT_REQUIRES_KEEPSAKE_ID");
          if (args.id !== undefined) {
            const opened = keepsakes.open(args.id); imageEventId = opened.record.origin.eventId;
            result = json({ record: opened.record, status: opened.status, historicalImage: true, phoneContacted: false });
            if (args.includeScreenshot) result.content.push({ type: "image", mimeType: "image/png", data: opened.png.toString("base64") });
          } else result = json({ ...keepsakes.list({ limit: args.limit, before: args.before }), phoneContacted: false });
        }
      } else if (history) {
        if (name === "android_activity_context") result = json(this.journal.context(8, true));
        if (name === "android_activity_history") {
          const entries = this.journal.history(args.limit || 10, args.before);
          result = json({ entries, nextBefore: entries.at(-1)?.id || null });
        }
        if (name === "android_activity_open") {
          if ((args.eventId !== undefined) === (requestId !== undefined)) deny("PROVIDE_ONE_RECORD_ID");
          const entry = requestId ? this.journal.findRequest(requestId) : this.journal.open(args.eventId);
          if (!entry) deny("RECORD_NOT_FOUND: execution is unknown; do not replay automatically");
          if ((args.expectedTool !== undefined || args.expectedArgsDigest !== undefined)
            && (entry.requestBinding?.tool !== args.expectedTool || entry.requestBinding?.argsDigest !== args.expectedArgsDigest)) deny("REQUEST_BINDING_MISMATCH_OR_UNKNOWN");
          imageEventId = entry.id;
          result = json(args.receiptOnly ? { phoneReceipt: this.receipt(entry) } : { ...entry, phoneReceipt: this.receipt(entry) });
          if (args.includeScreenshot) this.savedImage(entry, result);
        }
        if (name === "android_activity_reading") {
          const entry = this.journal.open(args.eventId);
          const previous = args.previousEventId ? this.journal.open(args.previousEventId) : undefined;
          if (!entry || (args.previousEventId && !previous)) deny("RECORD_NOT_FOUND");
          const reading = readingCursor(entry, previous); result = json(reading); imageEventId = entry.id;
          if (reading.needs_review && reading.evidence_available) this.savedImage(entry, result);
        }
      } else if (name === "android_capture_clip") {
        const clips = this.clips;
        if (!clips) throw new PolicyError("CLIPS_DISABLED");
        const record = await this.captureClip(this.adb, this.ui, this.device, clips, eventId,
          { ...args, expectedPackage }, state => this.journal.recordExecution(eventId, state), this.security);
        observation = { at: new Date().toISOString(), uiOmitted: "short clip supplied observation; no extra screenshot",
          clip: { id: record.id, status: "complete", expiresAt: record.expiresAt, frameCount: record.frames.length,
            tapRequested: args.tap !== undefined, tapState: args.tap ? "acknowledged" : "not_requested" } };
        result = json({ phoneClip: record, status: this.clipStatus(), nativeTapCoordinates: false });
      } else {
        if (this.adb.adb(this.device, "get-state").toString().trim() !== "device") deny("PHONE_UNAVAILABLE");
        if (status) {
          // These reads never obtain foreground/UI text, including while locked.
          if (wake) { requireUnlocked(this.adb, this.device); this.journal.recordExecution(eventId, "unconfirmed"); preparation = preparePhoneScreen(this.adb, this.device, true); }
          const details = name === "android_device_info" ? { model: this.adb.getProp(this.device, "ro.product.model").slice(0, 256) || null,
            androidVersion: this.adb.getProp(this.device, "ro.build.version.release").slice(0, 64) || null } : {};
          result = json({ ...details, ...readPowerStatus(this.adb, this.device), wakeRequested: preparation?.wakeRequested || false });
          observation = { at: new Date().toISOString(), uiOmitted: "status query" };
        } else if (powerKey) {
          requireUnlocked(this.adb, this.device);
          this.journal.recordExecution(eventId, "unconfirmed");
          result = await this.client.callTool({ name, arguments: { ...args, device: this.device } }) as CallToolResult;
          observation = { at: new Date().toISOString(), uiOmitted: "power key" };
        } else {
          const launching = name === "android_launch_app" || name === "android_open_url";
          requireAwake(this.adb, this.device);
          if (launching || name === "android_terminate_app") {
            const target = name === "android_open_url" ? this.security.config.browserPackage : args.packageName;
            this.security.package(target);
            if (target !== expectedPackage) deny("TARGET_PACKAGE_MISMATCH");
            if (name === "android_launch_app" && target === this.security.config.browserPackage) deny("CHROME_REQUIRES_OPEN_URL");
            if (name === "android_open_url") this.security.url(args.url);
          }
          let pkg = launching ? expectedPackage : this.guard(expectedPackage);
          if (name === "android_chrome_read" && pkg !== this.security.config.browserPackage) deny("CHROME_NOT_FOCUSED");
          if (!launching) await this.browserGuard(pkg, expectedUrl);
          if (textInput && this.ui.getElements(this.device).some(e => e.password)) deny("PASSWORD_INPUT_BLOCKED");
          this.journal.recordExecution(eventId, "unconfirmed");
          if (name === "android_chrome_read") result = json(await captureChromePage(this.adb, this.device, { ...args, expectedUrl }, undefined, { url: value => this.security.url(value) }));
          else if (name === "android_gesture") result = json(performGesture(this.adb, this.device, { ...args, expectedPackage }));
          else if (name === "android_set_text") result = json(setUnicodeText(this.adb, this.device, { ...args, text: args.text, expectedPackage }));
          else if (name === "android_open_url") {
            this.adb.shell(this.device, "am", "start", "-a", "android.intent.action.VIEW", "-d", this.adb.escapeShellText(args.url), "-p", this.security.config.browserPackage);
            result = json({ acknowledged: true });
          } else if (name === "android_take_screenshot") result = json({ observationRequested: true });
          else result = await this.client.callTool({ name, arguments: { ...args, device: this.device } }, undefined, { timeout: remainingTime() }) as CallToolResult;
          // Record input acknowledgement before any later wait, guard or image failure.
          if (!result.isError) this.journal.recordExecution(eventId, "acknowledged");
          if (observeAfterMs !== undefined && !result.isError) delay = await delayObservation(observeAfterMs);
          if (input && !result.isError) result = json({ acknowledged: true, ...(name === "android_gesture" ? { pointerReleased: true } : {}),
            ...(textInput ? { inputCharacters: String(args.text).length } : {}) });
          // Never copy an input field or its screenshot into the action response/log.
          {
            try {
              pkg = this.guard(expectedPackage);
              await this.browserGuard(pkg, launching && name === "android_open_url" ? args.url : expectedUrl);
              if (textInput) observation = { at: new Date().toISOString(), metadataVerified: true, uiOmitted: "text input; use a separate authorized observation" };
              else if (name === "android_chrome_read" && !result.isError) {
                const snapshot = JSON.parse((result.content[0] as { text: string }).text);
                observation = { at: snapshot.captureFinishedAt, foregroundApp: snapshot.foregroundApp, uiOmitted: "Chrome supplied observation",
                  elements: this.security.config.retainObservationText && !context.private ? [{ type: "ChromePageText", text: snapshot.text }] : "[observation text retention disabled]" };
              } else {
                let elements: any[] | null | undefined;
                if (name === "android_list_elements" && !result.isError) elements = JSON.parse((result.content[0] as { text: string }).text).elements;
                if (result.isError) elements = null;
                observation = observePhone(this.adb, this.ui, this.device, eventId, input || name === "android_take_screenshot", !!context.private, elements,
                  png => result.content.push({ type: "image", mimeType: "image/png", data: png.toString("base64") }), this.images,
                  () => { this.guard(expectedPackage); }, this.security.config.retainObservationText);
              }
              await this.browserGuard(this.guard(expectedPackage), launching && name === "android_open_url" ? args.url : expectedUrl);
              if (observation?.uiOmitted === "UI policy or lock state changed") deny("OBSERVATION_DISCARDED");
              if (name === "android_list_apps" && !result.isError) {
                const listed = JSON.parse((result.content[0] as { text: string }).text);
                result = json({ apps: (listed.apps || []).filter((p: string) => this.security.config.allowedApps.includes(p)).slice(0, 64) });
              }
            } catch {
              observation = { at: new Date().toISOString(), uiOmitted: "UI policy or foreground changed", screenshotOmitted: "UI policy or foreground changed" };
              policyDrift = true;
              result = failure("POSTCONDITION_FAILED: UI policy, focus, lock or URL changed or could not be verified; inspect execution receipt before retrying");
            }
          }
        }
        if (!result.isError) this.journal.recordExecution(eventId, "acknowledged");
        else if (!policyDrift) result = failure("OPERATION_FAILED: inspect the receipt before retrying");
      }
    } catch (error) {
      if (error instanceof ClipCaptureError) {
        observation = { at: new Date().toISOString(), uiOmitted: "capture stopped; no fallback UI read", clip: { ...error.capture, status: error.capture.mediaStatus } };
        result = { isError: true, ...json({ error: error.code, phoneClipCapture: error.capture, status: this.clipStatus() }) };
      } else result = error instanceof ClipStoreError ? { isError: true, ...json({ error: error.code, status: error.storageStatus || this.clipStatus() }) }
        : error instanceof KeepsakeError ? { isError: true, ...json({ error: error.code, status: error.storageStatus || this.keepsakeStatus() }) } : failure(safeError(error));
    }
    // No failure path performs a fallback UI read or repeats an input.
    if (!history && !archive && !observation) observation = { at: new Date().toISOString(), uiOmitted: "operation stopped; no fallback UI read" };
    if (observation && delay) observation.delay = delay;
    const inline = clipTool ? false : boundResultImages(result, imageEventId, imageMaxEdge || DEFAULT_IMAGE_EDGE, imageMode === "deferred");
    if (observation?.screenshot) observation.screenshot.returnedInline = inline;
    if (!history && !archive) result.content.push({ type: "text", text: JSON.stringify({ phoneObservation: {
      at: observation.at, preparation, errors: observation.errors, uiOmitted: observation.uiOmitted,
      screenshot: observation.screenshot, screenshotOmitted: observation.screenshotOmitted, delay: observation.delay, metadataVerified: observation.metadataVerified,
    } }) });
    try {
      if (eventId) this.journal.finish(eventId, policyDrift ? "policy_drift" : result.isError ? "error" : "completed", { result: { isError: !!result.isError, ...(history ? { historyRead: true } : {}) }, preparation, observation, ...(hostStorage ? { hostStorage } : {}) });
      if (!history && !archive && !status && !clipTool) this.summarizer.schedule();
      result.content.push({ type: "text", text: JSON.stringify({ phoneActivity: { eventId: eventId || null, ...(!eventId ? archive ? { storageReadNotRecorded: true } : { historyReadNotRecorded: true } : {}), ...(name === "android_activity_open" && args.receiptOnly ? {} : this.journal.context()) },
        ...(history || !eventId ? {} : { phoneReceipt: this.receipt(this.journal.open(eventId)) }) }) });
    } catch { result.content.push({ type: "text", text: "RECORD_FINALIZATION_FAILED: action may have run; do not replay" }); }
    return result;
  }
  private savedImage(entry: any, result: CallToolResult) {
    try {
      if (entry.callerClaim?.private) throw new Error();
      result.content.push({ type: "image", mimeType: "image/png", data: this.images.open(entry.observation?.screenshot).toString("base64") });
    } catch { result.content.push({ type: "text", text: JSON.stringify({ phoneImage: { status: "unavailable", sourceEventId: entry.id, error: "Saved image unavailable; receipt retained" } }) }); }
  }
  private receipt(entry: any) {
    return { ...activityReceipt(entry), ...(hostStorageTools.has(entry.tool) ? { effectScope: "owner-host-storage", phoneContacted: false, hostStorage: entry.hostStorage || null } : {}),
      ...(entry.tool === "android_capture_clip" ? { effectScope: "host-video-and-optional-phone-tap", clip: entry.observation?.clip ?? null } : {}),
      screenshotAvailable: !entry.callerClaim?.private && this.images.available(entry.observation?.screenshot) };
  }
  private finishArchiveFailure(eventId: number, code: string, status: any) {
    this.journal.finish(eventId, "error", { result: { isError: true }, hostStorage: { phoneContacted: false, error: code } });
    return { isError: true, ...json({ error: code, status, phoneReceipt: this.receipt(this.journal.open(eventId)) }) };
  }
  private keepsakeStatus() {
    try { return this.keepsakes?.status(); }
    catch { return { storage: "owner-host", status: "unavailable", usedBytes: null, count: null,
      maxBytes: this.security.config.screenshotKeepsakes.maxBytes, maxCount: this.security.config.screenshotKeepsakes.maxCount }; }
  }
  private clipStatus() {
    const config = this.security.config.shortClips;
    try { if (this.clips) return this.clips.status(); } catch { /* Return configured bounds, never invented usage. */ }
    return { enabled: config.enabled, storage: "owner-host", status: config.enabled ? "unavailable" : "disabled",
      cache: { ...config.cache, usedBytes: null, count: null }, keepsakes: { ...config.keepsakes, usedBytes: null, count: null } };
  }
  async close() { clearInterval(this.maintenance); await this.queue; this.summarizer.stop(); this.journal.close(); }
}
