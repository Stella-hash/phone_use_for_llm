import { AdbClient, ActionableError } from "./adb.js";

export interface UnicodeInput {
  text: string;
  mode?: "replace" | "append";
  expectedPackage?: string;
  resourceId?: string;
  submit?: boolean;
}

export function setUnicodeText(adb: AdbClient, device: string, input: UnicodeInput) {
  const payload = Buffer.from(JSON.stringify(input), "utf8").toString("base64");
  const raw = adb.shell(device, "am", "instrument", "-w", "-r", "-e", "payload", payload,
    "dev.gc.agentphone.helper/.UnicodeInstrumentation");
  const encoded = raw.match(/phone_result_b64=([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw new ActionableError("Unicode helper did not return a result. Verify that the companion APK is installed; re-inspect before retrying.");
  const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!result.ok) throw new ActionableError(JSON.stringify(result));
  if (input.submit) {
    adb.shell(device, "input", "keyevent", "KEYCODE_ENTER");
    result.submitted = true;
  }
  return result;
}
