import { createHash } from "node:crypto";

export const touchTools = new Set(["android_tap", "android_tap_element", "android_double_tap", "android_long_press", "android_swipe", "android_drag", "android_gesture"]);
export const gameGrantableTools = new Set([...touchTools, "android_capture_clip"]);
// Opt in each grantable capability; unknown/legacy/future tool names are invalid.
// The public catalog and authorization checks share this exact list.
export const expertGrantableTools = new Set([...gameGrantableTools, "android_launch_app", "android_terminate_app",
  "android_type_text", "android_set_text", "android_open_url", "android_open_notifications", "android_set_orientation"]);
export const hostStorageTools = new Set(["android_screenshot_keep", "android_screenshot_keepsakes", "android_clip_open", "android_clip_keep"]);
export const passiveTools = new Set(["android_device_info", "android_power_status", "android_activity_context", "android_activity_history", "android_activity_open", "android_activity_reading", "android_screenshot_keepsakes"]);
export const readTools = new Set([...passiveTools, "android_list_apps", "android_take_screenshot", "android_list_elements", "android_wait_for_element", "android_chrome_read", "android_clip_open"]);
export const isInputOperation = (name: string, args: Record<string, unknown>) => !readTools.has(name) || (name === "android_device_info" && args.wake === true);

// Android KeyEvent names/codes share one representation at every layer.
// https://developer.android.com/reference/android/view/KeyEvent#KEYCODE_SOFT_SLEEP
const names: Record<string, number> = { HOME: 3, BACK: 4, DPAD_UP: 19, DPAD_DOWN: 20, DPAD_LEFT: 21, DPAD_RIGHT: 22,
  DPAD_CENTER: 23, VOLUME_UP: 24, VOLUME_DOWN: 25, POWER: 26, CAMERA: 27, TAB: 61, SPACE: 62, ENTER: 66,
  DEL: 67, MENU: 82, ESCAPE: 111, VOLUME_MUTE: 164, APP_SWITCH: 187, SLEEP: 223, WAKEUP: 224, SOFT_SLEEP: 276 };
const codes = new Map(Object.entries(names).map(([name, code]) => [code, "KEYCODE_" + name]));
const power = new Set(["KEYCODE_POWER", "KEYCODE_SLEEP", "KEYCODE_WAKEUP", "KEYCODE_SOFT_SLEEP"]);
export function normalizeKey(value: unknown): string {
  if (typeof value !== "string" || value.length > 128) throw new Error("INVALID_KEY");
  const input = value.trim().toUpperCase();
  if (/^\d{1,10}$/.test(input)) {
    const code = Number(input);
    if (code > 65535) throw new Error("INVALID_KEY");
    return codes.get(code) || String(code);
  }
  if (!/^(?:KEYCODE_)?[A-Z][A-Z0-9_]{0,63}$/.test(input)) throw new Error("INVALID_KEY");
  let name = input.replace(/^KEYCODE_/, "");
  if (name === "DELETE") name = "DEL";
  return "KEYCODE_" + name;
}
export const isPowerKey = (value: unknown) => power.has(normalizeKey(value));
export function canonical(value: any): string {
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  if (value && typeof value === "object") return "{" + Object.keys(value).sort().map(k => JSON.stringify(k) + ":" + canonical(value[k])).join(",") + "}";
  return JSON.stringify(value);
}
export function canonicalArguments(tool: string, args: Record<string, unknown>) {
  const { approval: ignored, ...bound } = args;
  if (tool === "android_press_key") bound.key = normalizeKey(bound.key);
  return bound;
}
export function actionBinding(tool: string, args: Record<string, unknown>) {
  const normalized = canonicalArguments(tool, args);
  // This unkeyed deterministic hash binds a request; it does not hide low-entropy
  // arguments (including text). Receipts and replay tombstones retain the digest.
  return { version: 1, tool, argsDigest: createHash("sha256").update(canonical({ tool, arguments: normalized })).digest("hex"),
    ...(tool === "android_press_key" ? { normalizedKey: normalized.key } : {}) };
}
