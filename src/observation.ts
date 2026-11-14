import { AdbClient } from "./adb.js";
import { UiInspector } from "./ui.js";
import { withDeadline } from "./deadline.js";
import { requirePng } from "./screenshot.js";
import { ImageStore } from "./image-store.js";
import { deny } from "./security.js";

export function lockScreenStatus(adb: AdbClient, device: string) {
  const dump = adb.shell(device, "dumpsys", "window", "policy");
  const showing = dump.match(/^\s*showing=(true|false)/m)?.[1];
  const secure = dump.match(/^\s*secure=(true|false)/m)?.[1];
  return { showing: showing === undefined ? null : showing === "true", secure: secure === undefined ? null : secure === "true" };
}

export function requireUnlocked(adb: AdbClient, device: string) {
  const lock = lockScreenStatus(adb, device);
  if (lock.showing !== false) deny("LOCKED_OR_UNKNOWN");
  return lock;
}

export function preparePhoneScreen(adb: AdbClient, device: string, explicitWake = false) {
  const lockScreen = requireUnlocked(adb, device);
  const awake = /mWakefulness=Awake\b/.test(adb.shell(device, "dumpsys", "power"));
  if (explicitWake && !awake) adb.shell(device, "input", "keyevent", "KEYCODE_WAKEUP");
  return { autoWake: false, wakeRequested: explicitWake && !awake, awake, lockScreen };
}

export function requireAwake(adb: AdbClient, device: string) {
  requireUnlocked(adb, device);
  if (!/mWakefulness=Awake\b/.test(adb.shell(device, "dumpsys", "power"))) deny("SCREEN_ASLEEP");
}

export function observePhone(adb: AdbClient, ui: UiInspector, device: string, eventId: number,
  screenshot: boolean, privateText: boolean, suppliedElements?: any[] | null, onScreenshot?: (png: Buffer) => void,
  store?: ImageStore, guard: () => void = () => requireAwake(adb, device), retainText = false): any {
  return withDeadline(10000, () => {
    const start = performance.now();
    const timing: any = { clock: "host_monotonic_ms", uiSource: suppliedElements === null ? "unavailable" : suppliedElements ? "supplied" : "fresh" };
    const timed = <T>(name: string, operation: () => T): T => {
      const before = performance.now();
      try { return operation(); } finally { timing[name] = performance.now() - before; }
    };
    const observation: any = { at: new Date().toISOString(), errors: [], timing, uiCapture: { backend: "uiautomator" } };
    try { guard(); } catch {
      return { ...observation, uiOmitted: "UI policy or lock state changed", screenshotOmitted: "UI policy or lock state changed" };
    }
    let elements: any[] | undefined;
    try {
      observation.foregroundApp = timed("foregroundMs", () => adb.getCurrentApp(device));
      if (suppliedElements === null) throw new Error();
      elements = timed("uiMs", () => suppliedElements || ui.getElements(device));
      observation.uiCapture = suppliedElements ? { backend: "supplied", source: "same-call upstream UI" }
        : ui.getLastCaptureInfo?.() ?? { backend: "unreported" };
      guard();
      observation.passwordInputVisible = elements.some(e => e.password);
      observation.elements = !privateText && retainText ? elements.filter(e => !e.editable)
        : "[observation text retention disabled]";
    } catch { elements = undefined; observation.uiCapture = { backend: "unreported" }; observation.errors.push("UI text unavailable; no image permitted"); }
    if (screenshot && !privateText && elements && !observation.passwordInputVisible) {
      try {
        guard();
        const captureStartedAt = new Date().toISOString();
        const png = timed("screenshotCaptureAndVerifyMs", () => requirePng(adb.adb(device, "exec-out", "screencap", "-p")));
        const captureFinishedAt = new Date().toISOString();
        guard();
        if (!store) throw new Error();
        timed("screenshotArchiveAndAttachMs", () => {
          observation.screenshot = { ...store.save(eventId, png), captureStartedAt, captureFinishedAt, returnedInline: !!onScreenshot };
          onScreenshot?.(png);
        });
      } catch {
        observation.errors.push("Post-action screenshot could not be saved or verified; action receipt retained");
        observation.screenshotOmitted = "capture or storage unavailable";
      }
    } else if (screenshot) {
      observation.screenshotOmitted = privateText ? "private call" : observation.passwordInputVisible ? "password input visible" : "UI privacy state unavailable";
    }
    timing.totalMs = performance.now() - start;
    return observation;
  });
}
