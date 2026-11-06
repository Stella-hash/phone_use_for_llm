import fs from "node:fs";
import path from "node:path";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import { AdbClient, getAdbPath } from "./adb.js";
import { UiInspector } from "./ui.js";
import { ClipStore, CLIP_MAX_BYTES } from "./clip-store.js";
import { remainingTime, withDeadline } from "./deadline.js";
import { requireAwake } from "./observation.js";
import { performGesture } from "./gesture.js";
import { PolicyError, type OwnerSecurity } from "./security.js";

const display = z.object({ width: z.number().int().min(1).max(32768), height: z.number().int().min(1).max(32768) }).strict();
export const clipCaptureSchema = z.object({
  expectedPackage: z.string().regex(/^[a-zA-Z0-9_]+(?:\.[a-zA-Z0-9_]+)+$/).max(200),
  expectedDisplay: display,
  durationMs: z.number().int().min(1000).max(5000).default(3000),
  tap: z.object({ x: z.number().int().min(0).max(32767), y: z.number().int().min(0).max(32767) }).strict().optional(),
}).strict().superRefine((value, ctx) => {
  if (value.tap && (value.tap.x >= value.expectedDisplay.width || value.tap.y >= value.expectedDisplay.height))
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["tap"], message: "Tap is outside expectedDisplay" });
});

const wait = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
type ProcessState = { closed: boolean; code: number | null; signal: string | null; error?: string };

/** wm size is the panel's natural size, not the current touch coordinate space. */
export function parseInputDisplay(dump: string) {
  const views = dump.split(/\r?\n/).filter(line => /\bViewport\b/.test(line) && /\bdisplayId=0(?:,|\s|$)/.test(line)
    && /\bisActive=\[?(?:1|true)\]?/.test(line)).map(line => {
    const rotation = line.match(/\borientation=([0-3])\b/), bounds = line.match(/\blogicalFrame=\[0,\s*0,\s*(\d+),\s*(\d+)\]/);
    if (!rotation || !bounds) throw new Error("CLIP_INPUT_DISPLAY_UNAVAILABLE");
    return { width: Number(bounds[1]), height: Number(bounds[2]), rotation: Number(rotation[1]) };
  });
  const unique = [...new Map(views.map(view => [JSON.stringify(view), view])).values()];
  if (unique.length !== 1 || unique[0].width < 1 || unique[0].height < 1 || Math.max(unique[0].width, unique[0].height) > 32768)
    throw new Error("CLIP_INPUT_DISPLAY_UNAVAILABLE");
  return unique[0];
}

/** Owns exactly one recorder process. No killall, input replay, or caller shell text. */
export async function recordWindow(command: string, args: string[], file: string, durationMs: number,
  input: (assertRecording: () => Promise<void>) => Promise<unknown> | unknown, spawnRecorder = () => spawn("python3", [fileURLToPath(new URL("../scripts/clip-recorder.py", import.meta.url)), command, ...args], {
    windowsHide: true, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ADB: getAdbPath() },
  })) {
  const started = performance.now(), startedAt = new Date().toISOString();
  const child = spawnRecorder() as ChildProcessWithoutNullStreams;
  child.stdin.end();
  const state: ProcessState = { closed: false, code: null, signal: null };
  let logs = "", readyAt: string | null = null, inputResult: unknown;
  const receive = (chunk: Buffer) => {
    logs = (logs + chunk.toString()).slice(-8192);
    if (!readyAt && /Recording started to matroska file:/.test(logs)) readyAt = new Date().toISOString();
  };
  child.stdout.on("data", receive); child.stderr.on("data", receive);
  child.on("error", error => { state.error = error.message; });
  child.on("close", (code, signal) => { state.closed = true; state.code = code; state.signal = signal; });
  const closed = async (milliseconds: number) => {
    const until = performance.now() + milliseconds;
    while (!state.closed && performance.now() < until) await wait(25);
    return state.closed;
  };
  let stopRequested = false;
  try {
    while (!readyAt) {
      if (state.closed || state.error) throw new Error("CLIP_RECORDER_FAILED_BEFORE_INPUT");
      if (performance.now() - started > 5000 || remainingTime() < durationMs + 7000) throw new Error("CLIP_RECORDER_START_TIMEOUT");
      await wait(30);
    }
    // This is an explicit best-effort pre-roll, not a claim of first-frame delivery.
    await wait(600);
    if (state.closed || state.error) throw new Error("CLIP_RECORDER_STOPPED_BEFORE_INPUT");
    if (remainingTime() < durationMs + 11000) throw new Error("CLIP_INSUFFICIENT_ACTION_BUDGET");
    const inputPhaseStartedAt = new Date().toISOString(), inputPhaseHostOffsetMs = Math.round(performance.now() - started);
    const assertRecording = async () => {
      // Allow child exit/error events to arrive after synchronous Android guards.
      await wait(0);
      if (state.closed || state.error) throw new Error("CLIP_RECORDER_STOPPED_BEFORE_INPUT");
      remainingTime();
    };
    inputResult = await withDeadline(3000, () => input(assertRecording));
    if (state.closed || state.error) throw new Error("CLIP_RECORDER_STOPPED_DURING_INPUT");
    const observeUntil = performance.now() + durationMs;
    while (performance.now() < observeUntil) {
      if (state.closed || state.error) throw new Error("CLIP_RECORDER_STOPPED_EARLY");
      if (fs.statSync(file).size > CLIP_MAX_BYTES) throw new Error("CLIP_BYTE_LIMIT");
      remainingTime(1000);
      await wait(Math.min(50, Math.max(1, observeUntil - performance.now())));
    }
    stopRequested = true; child.kill("SIGINT");
    if (!await closed(2500)) { child.kill("SIGKILL"); await closed(1000); throw new Error("CLIP_RECORDER_STOP_TIMEOUT"); }
    if (state.error || state.code !== 0 || !/Recording complete to matroska file:/.test(logs))
      throw new Error(`CLIP_RECORDER_NOT_FINALIZED (exit=${state.code}, signal=${state.signal}, completionLog=${/Recording complete to matroska file:/.test(logs)})`);
    return { requestedAt: startedAt, recorderReadyAt: readyAt, inputPhaseStartedAt, inputPhaseHostOffsetMs,
      finishedAt: new Date().toISOString(), requestedObservationMs: durationMs, preRollMs: 600,
      inputResult, firstFrameBeforeInputVerified: false, actionVideoPtsMs: null,
      timingNote: "Video PTS are relative to the first encoded frame; host input time is a separate clock. Recorder-open plus pre-roll does not prove first-frame delivery before input." };
  } finally {
    if (!state.closed) {
      if (!stopRequested) child.kill("SIGINT");
      if (!await closed(2500)) { child.kill("SIGKILL"); await closed(500); }
    }
  }
}

export class ClipCaptureError extends PolicyError {
  constructor(code: string, public capture: { clipId: string; tapState: string; mediaStatus: "complete" | "failed" | "unknown"; failureReceiptSaved: boolean; automaticRetry: false }) { super(code); }
}

export async function captureShortClip(adb: AdbClient, ui: UiInspector, device: string, store: ClipStore,
  eventId: number, input: unknown, execution: (state: "unconfirmed" | "acknowledged") => void, security: OwnerSecurity) {
  const args = clipCaptureSchema.parse(input);
  const config = security.config.shortClips, command = config.recorderPath;
  if (!config.enabled || !config.acceptsTransientScreenContent || !command || !config.allowedApps.includes(args.expectedPackage)
    || args.expectedPackage === security.config.browserPackage) throw new PolicyError("CLIP_CAPTURE_NOT_CONFIGURED_FOR_APP");
  if (process.platform !== "linux") throw new PolicyError("CLIP_CAPTURE_REQUIRES_LINUX_HOST");
  if (!path.isAbsolute(command) || !fs.existsSync(command) || !fs.statSync(command).isFile()) throw new PolicyError("CLIP_RECORDER_UNAVAILABLE");
  if (remainingTime() < args.durationMs + 15000) throw new PolicyError("CLIP_INSUFFICIENT_BUDGET");
  let initialRotation: number | undefined;
  const guard = (inspectUi: boolean) => withDeadline(5000, () => {
    requireAwake(adb, device);
    const checkForeground = () => {
      const foreground = adb.getFocusedPackage(device);
      security.package(foreground);
      if (foreground !== args.expectedPackage) throw new PolicyError("CLIP_FOREGROUND_CHANGED");
      return foreground;
    };
    checkForeground();
    if (inspectUi && ui.getElements(device).some(element => element.password)) throw new Error("CLIP_PASSWORD_INPUT_VISIBLE");
    // The UI dump can block while the same app rotates or loses focus. Read
    // geometry after it, immediately before the recorder/tap boundary.
    requireAwake(adb, device);
    const foreground = checkForeground();
    const size = parseInputDisplay(adb.shell(device, "dumpsys", "input"));
    if (size.width !== args.expectedDisplay.width || size.height !== args.expectedDisplay.height) throw new Error("CLIP_DISPLAY_CHANGED");
    if (initialRotation !== undefined && size.rotation !== initialRotation) throw new Error("CLIP_ROTATION_CHANGED");
    return { foregroundPackage: foreground, display: size };
  });
  const initial = guard(true);
  initialRotation = initial.display.rotation;
  const allocation = store.allocate(eventId);
  let inputState = args.tap ? "not_started" : "not_requested";
  try {
    // Recording is a durable side effect even when no tap was requested.
    execution("unconfirmed");
    const recorded = await recordWindow(command, ["--serial=" + device, "--no-audio", "--no-control", "--no-playback", "--no-window", "--no-power-on",
      "--max-size=1280", "--max-fps=30", "--video-bit-rate=4M",
      "--video-codec=h264", "--video-codec-options=color-standard=1,color-transfer=3,color-range=2",
      "--time-limit=" + (Math.ceil(args.durationMs / 1000) + 5),
      "--record-format=mkv", "--record=" + allocation.videoPath], allocation.videoPath, args.durationMs, async assertRecording => {
      guard(true);
      await assertRecording();
      if (!args.tap) { inputState = "not_requested"; return { state: inputState }; }
      inputState = "unconfirmed";
      const tapAttemptedAt = new Date().toISOString();
      const result = performGesture(adb, device, { points: [args.tap, args.tap], durationMs: 100, expectedPackage: args.expectedPackage });
      execution("acknowledged"); inputState = "acknowledged";
      return { state: inputState, tapAttemptedAt, tapAcknowledgedAt: new Date().toISOString(), pointerReleased: result.pointerReleased };
    });
    const final = guard(true);
    const record = store.finalize(allocation.id, { ...recorded, initial, final, inputState,
      expectedPackage: args.expectedPackage, expectedDisplay: args.expectedDisplay, tap: args.tap ?? null,
      scopeCheck: "before-capture-before-input-and-after-capture; sampled guards are not atomic with DOWN; intermediate frames are not individually privacy-inspected", audio: false,
      requestedMaxFps: 30, requestedMaxEdge: 1280,
      requestedEncoderColor: { standard: "BT709", transfer: "SDR-video", range: "limited", mediaFormatValues: [1, 3, 2] } });
    if (!args.tap) execution("acknowledged");
    return record;
  } catch (error) {
    // Do not surface recorder paths, subprocess output or private UI text.
    const message = error instanceof PolicyError ? error.code : error instanceof Error && /^CLIP_[A-Z_]+(?:\s|$)/.test(error.message)
      ? error.message.split(/\s/)[0] : "CLIP_CAPTURE_FAILED";
    let failureReceiptSaved = false, mediaStatus: "complete" | "failed" | "unknown" = "unknown";
    try {
      // Finalization may already have succeeded before a journal acknowledgement
      // failed. A complete clip must not be relabelled as a failed recording.
      const retained = store.fail(allocation.id, { error: message, inputState, automaticRetry: false, expectedPackage: args.expectedPackage });
      mediaStatus = retained.status; failureReceiptSaved = retained.status === "failed";
    }
    catch { /* Keep the allocation and available media; the action receipt still exists. */ }
    throw new ClipCaptureError(message, { clipId: allocation.id, tapState: inputState, mediaStatus, failureReceiptSaved, automaticRetry: false });
  }
}
