import { z } from "zod";
import { AdbClient, ActionableError } from "./adb.js";

export const gestureSchema = z.object({
  points: z.array(z.object({ x: z.number().int().min(0).max(32767), y: z.number().int().min(0).max(32767) }).strict()).min(2).max(64),
  durationMs: z.number().int().min(100).max(5000).default(1000),
  holdMs: z.number().int().min(0).max(2000).default(0),
  expectedPackage: z.string().regex(/^[a-zA-Z0-9_.]+$/).max(200).optional(),
}).strict();

export function performGesture(adb: AdbClient, device: string, input: unknown) {
  const payload = Buffer.from(JSON.stringify(gestureSchema.parse(input)), "utf8").toString("base64");
  const raw = adb.shell(device, "am", "instrument", "-w", "-r", "-e", "payload", payload,
    "dev.gc.agentphone.helper/.GestureInstrumentation");
  const encoded = raw.match(/phone_result_b64=([A-Za-z0-9+/=]+)/)?.[1];
  if (!encoded) throw new ActionableError("Gesture helper returned no result. Update the companion APK if missing. An attempted gesture may be uncertain; inspect before retrying.");
  const result = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  if (!result.ok || result.pointerReleased !== true) throw new ActionableError(JSON.stringify(result));
  return result;
}
