import { type CallToolResult, type Tool } from "@modelcontextprotocol/sdk/types.js";
import { type Client } from "@modelcontextprotocol/sdk/client/index.js";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv-provider.js";
import { AdbClient } from "./adb.js";
import { UiInspector } from "./ui.js";
import { ActivityJournal, ActivitySummarizer } from "./activity.js";
import { ImageStore } from "./image-store.js";
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
import { canonicalArguments, isPowerKey, actionBinding } from "./operation.js";

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
  private summarizer: ActivitySummarizer;
  private validators;
  private maintenance: ReturnType<typeof setInterval>;
  constructor(private security: OwnerSecurity, private device: string, private client: Client, catalog: Tool[]) {
    this.journal = new ActivityJournal(security.directory);
    this.images = new ImageStore(security.directory);
    this.summarizer = new ActivitySummarizer(this.journal, security.config.allowModelSummary);
    const provider = new AjvJsonSchemaValidator();
    this.validators = new Map(catalog.map(tool => [tool.name, provider.getValidator(tool.inputSchema)]));
    this.maintenance = setInterval(() => { try { this.journal.maintain(); this.images.prune(); } catch { /* next admission fails closed */ } }, 60000);
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
    catch (error) { return failure(safeError(error)); }
    let eventId: number;
    try { eventId = this.journal.begin(name, all, context, history ? "history" : status && !wake ? "status" : "phone", input ? requestId : undefined); }
    catch {
      // Storage pressure must not prevent recovery of an already executed action.
      if (history) eventId = 0;
      else return failure("JOURNAL_UNAVAILABLE: no input attempted");
    }
    let result: CallToolResult = failure("OPERATION_FAILED"), observation: any = null, preparation: any = null;
    let imageEventId = eventId;
    let policyDrift = false;
    let delay: ObservationDelay | undefined = observeAfterMs === undefined ? undefined : { requestedMs: observeAfterMs, elapsedMs: 0, status: "action_failed" };
    try {
      if (history) {
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
    } catch (error) { result = failure(safeError(error)); }
    // No failure path performs a fallback UI read or repeats an input.
    if (!history && !observation) observation = { at: new Date().toISOString(), uiOmitted: "operation stopped; no fallback UI read" };
    if (observation && delay) observation.delay = delay;
    const inline = boundResultImages(result, imageEventId, imageMaxEdge || DEFAULT_IMAGE_EDGE, imageMode === "deferred");
    if (observation?.screenshot) observation.screenshot.returnedInline = inline;
    if (!history) result.content.push({ type: "text", text: JSON.stringify({ phoneObservation: {
      at: observation.at, preparation, errors: observation.errors, uiOmitted: observation.uiOmitted,
      screenshot: observation.screenshot, screenshotOmitted: observation.screenshotOmitted, delay: observation.delay, metadataVerified: observation.metadataVerified,
    } }) });
    try {
      if (eventId) this.journal.finish(eventId, policyDrift ? "policy_drift" : result.isError ? "error" : "completed", { result: { isError: !!result.isError, ...(history ? { historyRead: true } : {}) }, preparation, observation });
      if (!history && !status) this.summarizer.schedule();
      result.content.push({ type: "text", text: JSON.stringify({ phoneActivity: { eventId: eventId || null, ...(!eventId ? { historyReadNotRecorded: true } : {}), ...(name === "android_activity_open" && args.receiptOnly ? {} : this.journal.context()) },
        ...(history ? {} : { phoneReceipt: this.receipt(this.journal.open(eventId)) }) }) });
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
    return { ...activityReceipt(entry), screenshotAvailable: !entry.callerClaim?.private && this.images.available(entry.observation?.screenshot) };
  }
  async close() { clearInterval(this.maintenance); await this.queue; this.summarizer.stop(); this.journal.close(); }
}
