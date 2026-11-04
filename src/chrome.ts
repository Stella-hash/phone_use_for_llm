import { z } from "zod";
import { AdbClient, ActionableError } from "./adb.js";
import { remainingTime, withDeadline } from "./deadline.js";
import { lockScreenStatus } from "./observation.js";
import { normalizeChromeSnapshot } from "./chrome-snapshot.js";

export const chromeReadSchema = z.object({
  expectedUrl: z.string().url().max(4096).refine(s => /^https?:\/\//.test(s), "Expected an HTTP(S) URL").optional(),
  maxChars: z.number().int().min(100).max(30000).default(12000),
  maxElements: z.number().int().min(1).max(300).default(100),
}).strict();

const identityExpression = "({visible:document.visibilityState==='visible',focused:document.hasFocus(),url:location.href})";
const maxPayload = 8 * 1024 * 1024;
const fail = (message: string): never => { throw new ActionableError(message); };

/** A short-lived connection to one device-owned page; no caller-supplied CDP commands. */
export class ChromeConnection {
  private serial = 0;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener("message", event => {
      try {
        if (typeof event.data !== "string" || event.data.length > maxPayload) throw new Error("Chrome response exceeded the read limit");
        const message = JSON.parse(event.data);
        const task = this.pending.get(message.id);
        if (task) {
          this.pending.delete(message.id);
          // Do not forward page-controlled protocol diagnostics into the journal.
          message.error ? task.reject(new Error("Chrome protocol read failed or is unsupported")) : task.resolve(message.result);
        }
      } catch { this.close(new Error("Chrome response was invalid or too large")); }
    });
    socket.addEventListener("error", () => this.close(new Error("Chrome debugging connection failed")));
    socket.addEventListener("close", () => this.rejectPending(new Error("Chrome debugging connection closed")));
  }
  static async connect(port: number, id: string) {
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) fail("Invalid Chrome page identity");
    const timeout = remainingTime(2000);
    const socket = new WebSocket(`ws://127.0.0.1:${port}/devtools/page/${id}`);
    const connection = new ChromeConnection(socket);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { reject(new Error("Chrome connection timed out")); connection.close(); }, timeout);
      socket.addEventListener("open", () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener("error", () => { clearTimeout(timer); reject(new Error("Chrome debugging socket unavailable")); }, { once: true });
      socket.addEventListener("close", () => { clearTimeout(timer); reject(new Error("Chrome debugging socket closed")); }, { once: true });
    });
    return connection;
  }
  call(method: string, params: Record<string, unknown> = {}, timeoutMs = 3000): Promise<any> {
    const timeout = remainingTime(timeoutMs);
    return new Promise((resolve, reject) => {
      const id = ++this.serial;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error("Chrome read timed out: " + method)); }, timeout);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timer); resolve(value); },
        reject: error => { clearTimeout(timer); reject(error); },
      });
      try { this.socket.send(JSON.stringify({ id, method, params })); }
      catch { this.pending.get(id)?.reject(new Error("Chrome connection is not open")); this.pending.delete(id); }
    });
  }
  private rejectPending(error: Error) { for (const task of this.pending.values()) task.reject(error); this.pending.clear(); }
  close(error = new Error("Chrome read finished")) { this.rejectPending(error); this.socket.close(); }
}

async function listTargets(port: number) {
  const response = await fetch(`http://127.0.0.1:${port}/json/list`, { signal: AbortSignal.timeout(remainingTime(2000)), redirect: "error" });
  if (!response.ok || !response.body) fail("Chrome page discovery unavailable");
  const reader = response.body!.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024 * 1024) fail("Chrome page list exceeded the read limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  const targets = JSON.parse(Buffer.concat(chunks).toString());
  if (!Array.isArray(targets)) fail("Invalid Chrome page list");
  const pages = targets.filter((t: any) => t.type === "page");
  if (pages.length > 32) fail("Too many Chrome tabs to identify the visible page within this bounded read");
  return pages;
}

export function checkChromeForeground(adb: AdbClient, device: string) {
  if (!/mWakefulness=Awake\b/.test(adb.shell(device, "dumpsys", "power")))
    fail("Chrome read requires an already-awake phone; no wake was requested");
  if (lockScreenStatus(adb, device).showing !== false) fail("Lock screen state is not clear; Chrome content was not returned");
  const app = adb.getCurrentApp(device);
  if (app.packageName !== "com.android.chrome") fail("Chrome must already be the foreground app; no app was opened");
  return app;
}

async function identity(connection: Pick<ChromeConnection, "call">) {
  const value = await connection.call("Runtime.evaluate", { expression: identityExpression, returnByValue: true, throwOnSideEffect: true, timeout: 250 }, 700);
  if (value.exceptionDetails || !value.result?.value || typeof value.result.value.url !== "string") fail("Chrome page visibility could not be verified");
  return value.result.value as { visible: boolean; focused: boolean; url: string };
}

// Exported for a synthetic protocol oracle; production always supplies the real transport.
export async function captureChromePage(adb: AdbClient, device: string, input: unknown,
  transport = { list: listTargets, connect: ChromeConnection.connect },
  policy?: { url: (value: unknown) => unknown; verifyOnly?: boolean }) {
  const query = chromeReadSchema.parse(input);
  if (policy) policy.url(query.expectedUrl);
  const budget = remainingTime(12000);
  if (budget < 2000) fail("Insufficient time for a Chrome read and connection cleanup");
  let port: number | undefined, result: any, error: unknown;
  const connections: Array<Pick<ChromeConnection, "call" | "close">> = [];
  try {
    result = await withDeadline(budget - 1000, async () => {
      const captureStartedAt = new Date().toISOString();
      checkChromeForeground(adb, device);
      port = Number(adb.adb(device, "forward", "tcp:0", "localabstract:chrome_devtools_remote").toString().trim());
      if (!Number.isInteger(port) || port < 1 || port > 65535) { port = undefined; fail("Chrome debugging forward was not allocated"); }
      const candidates: Array<{ id: string; connection: Pick<ChromeConnection, "call" | "close">; identity: Awaited<ReturnType<typeof identity>> }> = [];
      const pages = await transport.list(port!);
      const targets = query.expectedUrl ? pages.filter((t: any) => t.url === query.expectedUrl) : pages;
      let unavailableTargets = 0;
      for (const target of targets) if (!/^[A-Za-z0-9_-]{1,128}$/.test(target.id)) fail("Invalid Chrome page identity");
      // Suspended background renderers may not answer Runtime. They must not block
      // the responding foreground page, and must never be resumed to perform a read.
      for (let offset = 0; offset < targets.length; offset += 4) await Promise.all(targets.slice(offset, offset + 4).map(async (target: any) => {
        let connection: Pick<ChromeConnection, "call" | "close"> | undefined;
        try {
          connection = await transport.connect(port!, target.id);
          connections.push(connection);
          const state = await identity(connection);
          if (state.visible && state.focused) candidates.push({ id: target.id, connection, identity: state });
          else connection.close();
        } catch { unavailableTargets++; connection?.close(); }
      }));
      if (candidates.length !== 1) fail(`Could not identify one responding focused visible Chrome page (${unavailableTargets} unavailable); no page content returned`);
      const selected = candidates[0];
      const url = selected.identity.url;
      if (!/^https?:\/\//.test(url)) fail("This Chrome reader supports HTTP(S) pages only");
      if (query.expectedUrl && query.expectedUrl !== url) fail("Visible Chrome page did not match expectedUrl; no page content read");
      policy?.url(url);
      if (policy?.verifyOnly) { checkChromeForeground(adb, device); return { url }; }
      const rpc = selected.connection;
      const before = (await rpc.call("Page.getFrameTree")).frameTree?.frame;
      if (!before?.id || !before.loaderId || before.url !== url) fail("Chrome document identity is unavailable or changing");
      const snapshot = await rpc.call("DOMSnapshot.captureSnapshot", { computedStyles: ["visibility", "opacity", "-webkit-text-security"] });
      const ax = await rpc.call("Accessibility.getFullAXTree", { frameId: before.id });
      const metrics = await rpc.call("Page.getLayoutMetrics");
      const after = (await rpc.call("Page.getFrameTree")).frameTree?.frame;
      const finalState = await identity(rpc);
      const foregroundApp = checkChromeForeground(adb, device);
      policy?.url(finalState.url);
      if (!finalState.visible || !finalState.focused || finalState.url !== url || after?.id !== before.id
        || after?.loaderId !== before.loaderId || after?.url !== url) fail("Chrome page changed during capture; snapshot discarded");
      return { source: "Chrome DOMSnapshot + Accessibility", targetId: selected.id, frameId: before.id,
        targetDiscovery: { probed: targets.length, unavailable: unavailableTargets, exactUrlFilter: !!query.expectedUrl },
        documentId: before.loaderId, url, wakeRequested: false, captureStartedAt, captureFinishedAt: new Date().toISOString(), foregroundApp,
        ...normalizeChromeSnapshot(snapshot, ax, metrics, before.id, url, query),
        scope: "Rendered main-document layout overlapping the visual viewport; occlusion is not tested. Frame contents are omitted; canvas pixels need an image.",
        consistency: "Document identity and foreground checked before/after; DOM and AX are sequential observations, not an atomic page state.",
      };
    });
  } catch (caught) { error = caught; }
  finally {
    for (const connection of connections) connection.close();
    if (port !== undefined) {
      try { adb.adb(device, "forward", "--remove", `tcp:${port}`); }
      catch { error = new Error(`${error instanceof Error ? error.message + "; " : ""}Temporary Chrome forward cleanup failed`); }
    }
  }
  if (error) throw error;
  return result;
}
