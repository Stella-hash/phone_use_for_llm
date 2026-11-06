import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import { assertPrivate, noLinks, privateDirectory, writePrivate } from "./private-files.js";
import { remainingTime } from "./deadline.js";
import { requirePng } from "./screenshot.js";

export const CLIP_MAX_BYTES = 64 * 1024 * 1024;
export const CLIP_MAX_FRAMES = 600;
export const DEFAULT_CLIP_CACHE_AGE_MS = 7 * 24 * 60 * 60 * 1000;
export const DEFAULT_CLIP_CACHE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CLIP_CACHE_COUNT = 32;
export const DEFAULT_CLIP_KEEPSAKE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_CLIP_KEEPSAKE_COUNT = 1000;
// Reserve enough room before starting a recorder, including its bounded metadata.
export const CLIP_ALLOCATION_BYTES = CLIP_MAX_BYTES + 1024 * 1024;
const META_BYTES = 256 * 1024;
const CLIP_ID = /^clip-([1-9]\d*)-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})$/;
const KEEP_ID = /^[a-f0-9]{64}$/;
const sha = (data: Buffer | string) => createHash("sha256").update(data).digest("hex");
const ms = (value: number) => Math.round(value * 1000) / 1000;
const stamp = (value: unknown): value is string => typeof value === "string" && value.length < 40 && Number.isFinite(Date.parse(value));

export type ClipFrame = { index: number; ptsMs: number; relativeMs: number; width: number; height: number;
  timestampKind: "pts" | "packet-pts" | "decoder-best-effort" };
export type ClipTiming = { source: "decoded-video-presentation-timestamps"; variableIntervals: boolean;
  minIntervalMs: number | null; maxIntervalMs: number | null; meanIntervalMs: number | null;
  observedFrameRate: number | null; droppedFrames: null; dimensionsChanged: boolean };
export type ClipRecord = {
  version: 1; id: string; eventId: number; allocatedAt: string; completedAt: string; expiresAt: string; status: "complete";
  storage: "owner-host"; origin: Record<string, unknown>;
  video: { filename: "source.mkv"; sha256: string; bytes: number; codec: string; width: number; height: number;
    firstPtsMs: number; lastPtsMs: number; spanMs: number; frameCount: number; containerDurationMs: number | null;
    colorSpace: string | null; colorTransfer: string | null; colorPrimaries: string | null; colorRange: string | null };
  frames: ClipFrame[]; timing: ClipTiming;
};
export type ClipFailure = { version: 1; id: string; eventId: number; allocatedAt: string; failedAt: string;
  expiresAt: string;
  status: "failed"; storage: "owner-host"; imageAvailable: false; partialMediaRetained: true;
  details: Record<string, unknown>; bytes: number | null; sha256: string | null };
type Allocation = { version: 1; kind: "phone-use-short-clip-cache"; id: string; eventId: number; allocatedAt: string };
export type ClipKeepsake = { version: 1; id: string; clipId: string; eventId: number; sourceSha256: string;
  savedAt: string; title: string; note?: string; frameIndex: number | null; ptsMs: number | null;
  expiresAt: null; copiedMedia: true;
  media: { filename: "source.mkv" | "frame.png"; mimeType: "video/x-matroska" | "image/png"; bytes: number; sha256: string } };
export type ClipCacheStatus = { storage: "owner-host"; maxAgeMs: number; maxBytes: number; maxCount: number;
  usedBytes: number; count: number; pendingEntries: number; blockedEntries: number; reservedBytes: number;
  nextExpiresAt: string | null; warning: string | null };
export type ClipKeepsakeStatus = { storage: "owner-host"; enabled: boolean; maxBytes: number; maxCount: number;
  usedBytes: number; count: number; pendingEntries: number; blockedEntries: number;
  migrationRecommended: boolean; warning: string | null };
export type ClipStoreOptions = { cacheMaxAgeMs?: number; cacheMaxBytes?: number; cacheMaxCount?: number;
  keepsakesEnabled?: boolean; keepsakeMaxBytes?: number; keepsakeMaxCount?: number };
export class ClipStoreError extends Error {
  constructor(public code: string, public storageStatus?: ClipCacheStatus | ClipKeepsakeStatus) { super(code); }
}

function regular(file: string, maximum: number) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maximum) throw new Error("CLIP_INVALID_STORAGE");
  return stat;
}
function bytes(file: string, maximum: number): Buffer {
  const before = regular(file, maximum);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const opened = fs.fstatSync(fd);
    if (opened.ino !== before.ino || opened.dev !== before.dev || opened.size !== before.size || opened.nlink !== 1)
      throw new Error("CLIP_STORAGE_CHANGED");
    const data = Buffer.alloc(opened.size + 1);
    let length = 0, read: number;
    while (length < data.length && (read = fs.readSync(fd, data, length, data.length - length, null)) > 0) length += read;
    const after = fs.fstatSync(fd), current = regular(file, maximum);
    if (length !== opened.size || after.mtimeMs !== opened.mtimeMs || after.ctimeMs !== opened.ctimeMs
      || current.ino !== opened.ino || current.dev !== opened.dev || current.mtimeMs !== opened.mtimeMs || current.ctimeMs !== opened.ctimeMs)
      throw new Error("CLIP_STORAGE_CHANGED");
    return data.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function json(file: string, maximum = META_BYTES): any { return JSON.parse(bytes(file, maximum).toString("utf8")); }
function boundedDetails(value: Record<string, unknown>) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("CLIP_INVALID_PROVENANCE");
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded) > 16 * 1024) throw new Error("CLIP_PROVENANCE_LIMIT");
  return JSON.parse(encoded) as Record<string, unknown>;
}
function publish(file: string, value: unknown) {
  noLinks(file);
  if (fs.existsSync(file)) throw new Error("CLIP_RECORD_ALREADY_PUBLISHED");
  if (fs.readdirSync(path.dirname(file)).filter(name => /^\.metadata-[a-f0-9-]{36}\.tmp$/.test(name)).length >= 2)
    throw new ClipStoreError("CLIP_METADATA_RECOVERY_REQUIRED");
  const temporary = path.join(path.dirname(file), ".metadata-" + randomUUID() + ".tmp");
  writePrivate(temporary, JSON.stringify(value));
  const fd = fs.openSync(temporary, "r+");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // A failed publication retains its temporary metadata as diagnostic evidence.
  fs.renameSync(temporary, file);
}
function dimensions(width: unknown, height: unknown) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || Number(width) < 1 || Number(height) < 1
    || Math.max(Number(width), Number(height)) > 1920 || Number(width) * Number(height) > 4_000_000)
    throw new Error("CLIP_DIMENSION_LIMIT");
  return { width: Number(width), height: Number(height) };
}

function decodeFrame(file: string, index: number) {
  return requirePng(execFileSync(process.env.PHONE_FFMPEG || "ffmpeg", ["-v", "error", "-nostdin", "-protocol_whitelist", "file,pipe", "-f", "matroska", "-i", file,
    "-map", "0:v:0", "-an", "-sn", "-dn", "-vf", `select=eq(n\\,${index})`, "-vsync", "0", "-frames:v", "1", "-c:v", "png", "-f", "image2pipe", "pipe:1"],
    { timeout: remainingTime(6000), maxBuffer: 16 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] }));
}

/** Preserve observed timestamps. No assumed FPS, duplicated frame, or inferred drop count. */
export function parseClipProbe(probe: any) {
  if (!Array.isArray(probe?.streams) || probe.streams.length !== 1 || probe.streams[0]?.codec_type !== "video"
    || !Array.isArray(probe.frames) || probe.frames.length < 1 || probe.frames.length > CLIP_MAX_FRAMES)
    throw new Error("CLIP_INVALID_VIDEO");
  const stream = probe.streams[0], size = dimensions(stream.width, stream.height);
  if (typeof stream.codec_name !== "string" || !/^[a-z0-9_]{1,32}$/.test(stream.codec_name)) throw new Error("CLIP_INVALID_CODEC");
  const frames: ClipFrame[] = probe.frames.map((frame: any, index: number) => {
    const timestamp = frame.pts_time ?? frame.pkt_pts_time ?? frame.best_effort_timestamp_time;
    if (typeof timestamp !== "string" || !/^-?\d+(?:\.\d+)?$/.test(timestamp)) throw new Error("CLIP_FRAME_TIMESTAMP_UNAVAILABLE");
    const ptsMs = ms(Number(timestamp) * 1000);
    if (!Number.isFinite(ptsMs) || Math.abs(ptsMs) > 1e12) throw new Error("CLIP_FRAME_TIMESTAMP_UNAVAILABLE");
    return { index, ptsMs, relativeMs: 0, ...dimensions(frame.width, frame.height),
      timestampKind: frame.pts_time !== undefined ? "pts" : frame.pkt_pts_time !== undefined ? "packet-pts" : "decoder-best-effort" };
  });
  const firstPtsMs = frames[0].ptsMs, lastPtsMs = frames.at(-1)!.ptsMs;
  const intervals: number[] = [];
  for (const frame of frames) {
    frame.relativeMs = ms(frame.ptsMs - firstPtsMs);
    if (frame.index) {
      const interval = ms(frame.ptsMs - frames[frame.index - 1].ptsMs);
      if (interval < 0) throw new Error("CLIP_NONMONOTONIC_TIMESTAMPS");
      intervals.push(interval);
    }
  }
  const spanMs = ms(lastPtsMs - firstPtsMs);
  if (spanMs > 10000) throw new Error("CLIP_DURATION_LIMIT");
  const minIntervalMs = intervals.length ? Math.min(...intervals) : null;
  const maxIntervalMs = intervals.length ? Math.max(...intervals) : null;
  const rawDuration = probe.format?.duration;
  const containerDurationMs = typeof rawDuration === "string" && /^\d+(?:\.\d+)?$/.test(rawDuration)
    ? ms(Number(rawDuration) * 1000) : null;
  if (containerDurationMs !== null && (!Number.isFinite(containerDurationMs) || containerDurationMs > 15000)) throw new Error("CLIP_DURATION_LIMIT");
  const timing: ClipTiming = { source: "decoded-video-presentation-timestamps", variableIntervals: minIntervalMs !== maxIntervalMs,
    minIntervalMs, maxIntervalMs, meanIntervalMs: intervals.length ? ms(spanMs / intervals.length) : null,
    observedFrameRate: spanMs > 0 ? Math.round((frames.length - 1) * 1_000_000 / spanMs) / 1000 : null,
    droppedFrames: null, dimensionsChanged: frames.some(frame => frame.width !== size.width || frame.height !== size.height) };
  const color = (value: unknown): string | null => typeof value === "string" && /^[a-zA-Z0-9_-]{1,32}$/.test(value) ? value : null;
  return { frames, timing, video: { codec: stream.codec_name as string, ...size, firstPtsMs, lastPtsMs, spanMs,
    colorSpace: color(stream.color_space), colorTransfer: color(stream.color_transfer), colorPrimaries: color(stream.color_primaries), colorRange: color(stream.color_range),
    frameCount: frames.length, containerDurationMs } };
}

type CacheEntry = { id: string; directory: string; allocation: Allocation; files: string[];
  identities: string[]; bytes: number; status: "complete" | "failed" | "pending" };
const identity = (stat: fs.Stats) => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(":");
const metadataName = /^\.metadata-[a-f0-9-]{36}\.tmp$/;
const pendingName = /^\.pending-[a-f0-9-]{36}$/;
const validClipId = (id: string) => CLIP_ID.test(id) && Number.isSafeInteger(Number(CLIP_ID.exec(id)![1]));
function cacheLock<T>(directory: string, run: () => T): T {
  const file = path.join(directory, ".write.lock");
  try { writePrivate(file, String(process.pid)); } catch { throw new ClipStoreError("CLIP_CACHE_STORAGE_BUSY"); }
  const original = identity(regular(file, 256)); let primary: unknown;
  try { return run(); } catch (error) { primary = error; throw error; }
  finally {
    try {
      if (identity(regular(file, 256)) !== original) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
      fs.unlinkSync(file);
    } catch (error) { if (!primary) throw error; }
  }
}
function page<T extends { id: string }>(records: T[], options: { limit?: number; before?: string }, pattern: RegExp) {
  const limit = options.limit ?? 10;
  if (!Number.isInteger(limit) || limit < 1 || limit > 30 || (options.before !== undefined && !pattern.test(options.before)))
    throw new ClipStoreError("CLIP_INVALID_CURSOR");
  const start = options.before === undefined ? 0 : records.findIndex(record => record.id === options.before) + 1;
  if (options.before !== undefined && start === 0) throw new ClipStoreError("CLIP_INVALID_CURSOR");
  const selected = records.slice(start, start + limit);
  return { records: selected, nextBefore: start + selected.length < records.length ? selected.at(-1)!.id : null };
}
function validateRecord(value: any, id: string, allocation?: Allocation): ClipRecord {
  if (value?.version !== 1 || value.id !== id || !validClipId(id) || value.eventId !== Number(CLIP_ID.exec(id)![1])
    || !stamp(value.allocatedAt) || !stamp(value.completedAt) || !stamp(value.expiresAt)
    || (allocation && (value.eventId !== allocation.eventId || value.allocatedAt !== allocation.allocatedAt))
    || value.status !== "complete" || value.storage !== "owner-host"
    || value.video?.filename !== "source.mkv" || !KEEP_ID.test(value.video?.sha256 || "")
    || !Number.isSafeInteger(value.video?.bytes) || value.video.bytes < 4 || value.video.bytes > CLIP_MAX_BYTES
    || !Array.isArray(value.frames) || value.frames.length < 1 || value.frames.length > CLIP_MAX_FRAMES
    || value.video.frameCount !== value.frames.length) throw new ClipStoreError("CLIP_INVALID_RECORD");
  boundedDetails(value.origin);
  dimensions(value.video.width, value.video.height);
  for (const [index, frame] of value.frames.entries()) {
    if (frame.index !== index || !Number.isFinite(frame.ptsMs) || !Number.isFinite(frame.relativeMs)
      || frame.relativeMs !== ms(frame.ptsMs - value.frames[0].ptsMs) || frame.relativeMs < 0 || frame.relativeMs > 10000
      || (index > 0 && frame.ptsMs < value.frames[index - 1].ptsMs)
      || !["pts", "packet-pts", "decoder-best-effort"].includes(frame.timestampKind)) throw new ClipStoreError("CLIP_INVALID_FRAME_RECORD");
    dimensions(frame.width, frame.height);
  }
  return value;
}

/** Disposable, bounded clip cache; keepsakes contain independent immutable copies. */
export class ClipStore {
  readonly directory: string;
  readonly keepsakesDirectory: string;
  readonly options: Required<ClipStoreOptions>;
  private active = new Set<string>();
  constructor(dataDirectory: string, options: ClipStoreOptions = {}) {
    this.options = { cacheMaxAgeMs: DEFAULT_CLIP_CACHE_AGE_MS, cacheMaxBytes: DEFAULT_CLIP_CACHE_BYTES,
      cacheMaxCount: DEFAULT_CLIP_CACHE_COUNT, keepsakesEnabled: false,
      keepsakeMaxBytes: DEFAULT_CLIP_KEEPSAKE_BYTES, keepsakeMaxCount: DEFAULT_CLIP_KEEPSAKE_COUNT, ...options };
    for (const [key, maximum] of [["cacheMaxAgeMs", 30 * 86400000], ["cacheMaxBytes", 4 * 1024 ** 3],
      ["cacheMaxCount", 1024], ["keepsakeMaxBytes", 64 * 1024 ** 3], ["keepsakeMaxCount", 100000]] as const) {
      if (!Number.isSafeInteger(this.options[key]) || this.options[key] < 1 || this.options[key] > maximum)
        throw new ClipStoreError("CLIP_INVALID_LIMIT");
    }
    if (typeof this.options.keepsakesEnabled !== "boolean") throw new ClipStoreError("CLIP_INVALID_LIMIT");
    this.directory = privateDirectory(path.join(dataDirectory, "clips"));
    this.keepsakesDirectory = privateDirectory(path.join(dataDirectory, "clip-keepsakes"));
  }
  private location(id: string) {
    if (!validClipId(id)) throw new ClipStoreError("CLIP_INVALID_ID");
    const directory = path.join(this.directory, id); noLinks(directory);
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) throw new ClipStoreError("CLIP_NOT_FOUND");
    return directory;
  }
  private allocation(id: string): Allocation {
    const value = json(path.join(this.location(id), "allocation.json"), 4096);
    if (value?.version !== 1 || value.kind !== "phone-use-short-clip-cache" || value.id !== id
      || value.eventId !== Number(CLIP_ID.exec(id)![1]) || !stamp(value.allocatedAt)) throw new ClipStoreError("CLIP_INVALID_ALLOCATION");
    return value;
  }
  private expires(allocation: Allocation) { return new Date(Date.parse(allocation.allocatedAt) + this.options.cacheMaxAgeMs).toISOString(); }
  private entry(id: string): CacheEntry {
    const directory = this.location(id), allocation = this.allocation(id), files = fs.readdirSync(directory).sort();
    if (files.length > 8 || files.some(file => !["allocation.json", "source.mkv", "record.json", "failure.json"].includes(file) && !metadataName.test(file)))
      throw new ClipStoreError("CLIP_INVALID_STORAGE");
    if (files.includes("record.json") && files.includes("failure.json")) throw new ClipStoreError("CLIP_INVALID_STORAGE");
    const stats = files.map(file => regular(path.join(directory, file), file === "source.mkv" ? CLIP_MAX_BYTES : META_BYTES));
    const status = files.includes("record.json") ? "complete" : files.includes("failure.json") ? "failed" : "pending";
    if (status === "complete") {
      const record = this.record(id);
      if (!files.includes("source.mkv") || stats[files.indexOf("source.mkv")].size !== record.video.bytes)
        throw new ClipStoreError("CLIP_INVALID_STORAGE");
    } else if (status === "failed") this.failure(id);
    return { id, directory, allocation, files, identities: stats.map(identity), bytes: stats.reduce((sum, stat) => sum + stat.size, 0), status };
  }
  private scan() {
    noLinks(this.directory);
    const entries: CacheEntry[] = []; let blockedEntries = 0;
    for (const id of fs.readdirSync(this.directory)) {
      remainingTime();
      try {
        if (id === ".write.lock") { regular(path.join(this.directory, id), 256); continue; }
        if (!validClipId(id)) throw new Error("foreign entry"); entries.push(this.entry(id));
      }
      catch { blockedEntries++; }
    }
    entries.sort((a, b) => a.allocation.allocatedAt.localeCompare(b.allocation.allocatedAt) || a.id.localeCompare(b.id));
    return { entries, blockedEntries };
  }
  private cacheStatus(scan = this.scan()): ClipCacheStatus {
    return { storage: "owner-host", maxAgeMs: this.options.cacheMaxAgeMs, maxBytes: this.options.cacheMaxBytes,
      maxCount: this.options.cacheMaxCount, usedBytes: scan.entries.reduce((sum, entry) => sum + entry.bytes, 0),
      count: scan.entries.length, pendingEntries: scan.entries.filter(entry => entry.status === "pending").length,
      blockedEntries: scan.blockedEntries,
      reservedBytes: scan.entries.filter(entry => this.protected(entry, Date.now())).reduce((sum, entry) => sum + Math.max(0, CLIP_ALLOCATION_BYTES - entry.bytes), 0),
      nextExpiresAt: scan.entries.length ? this.expires(scan.entries[0].allocation) : null,
      warning: scan.blockedEntries ? "Unrecognized or unsafe cache entries were preserved. New captures require owner inspection; their bytes are not included in usedBytes." : null };
  }
  private protected(entry: CacheEntry, now: number) {
    // A restarted/second process must also respect a recorder that has not yet
    // published its receipt. Capture operations have a much shorter deadline.
    return this.active.has(entry.id) || (entry.status === "pending" && now - Date.parse(entry.allocation.allocatedAt) < 120000);
  }
  private remove(entry: CacheEntry) {
    // Revalidate the entire directory before unlinking exact known files. Never recurse.
    const current = this.entry(entry.id);
    if (current.files.join("\0") !== entry.files.join("\0") || current.identities.join("\0") !== entry.identities.join("\0"))
      throw new ClipStoreError("CLIP_STORAGE_CHANGED");
    for (const [index, name] of entry.files.entries()) {
      const file = path.join(entry.directory, name);
      if (identity(regular(file, name === "source.mkv" ? CLIP_MAX_BYTES : META_BYTES)) !== entry.identities[index])
        throw new ClipStoreError("CLIP_STORAGE_CHANGED");
      fs.unlinkSync(file);
    }
    fs.rmdirSync(entry.directory);
  }
  private maintain(now: number, reserveBytes = 0, reserveCount = 0) {
    if (!Number.isFinite(now)) throw new ClipStoreError("CLIP_INVALID_TIME");
    let scan = this.scan();
    for (const entry of scan.entries) {
      remainingTime();
      if (!this.protected(entry, now) && Date.parse(this.expires(entry.allocation)) <= now) this.remove(entry);
    }
    scan = this.scan();
    for (const entry of scan.entries) {
      remainingTime();
      const status = this.cacheStatus(scan);
      if (status.usedBytes + status.reservedBytes + reserveBytes <= status.maxBytes && status.count + reserveCount <= status.maxCount) break;
      if (this.protected(entry, now)) continue;
      this.remove(entry); scan = { ...scan, entries: scan.entries.filter(item => item.id !== entry.id) };
    }
    return this.cacheStatus();
  }
  prune(now = Date.now()) { return cacheLock(this.directory, () => this.maintain(now)); }
  status() { return { cache: this.cacheStatus(), keepsakes: this.keepsakeStatus() }; }
  allocate(eventId: number) {
    if (!Number.isSafeInteger(eventId) || eventId < 1) throw new ClipStoreError("CLIP_INVALID_EVENT");
    return cacheLock(this.directory, () => {
      const status = this.maintain(Date.now(), CLIP_ALLOCATION_BYTES, 1);
      if (status.blockedEntries) throw new ClipStoreError("CLIP_CACHE_REQUIRES_OWNER_INSPECTION", status);
      if (status.usedBytes + status.reservedBytes + CLIP_ALLOCATION_BYTES > status.maxBytes || status.count + 1 > status.maxCount)
        throw new ClipStoreError("CLIP_CACHE_CAPACITY_REACHED", status);
      const id = `clip-${eventId}-${randomUUID()}`, directory = privateDirectory(path.join(this.directory, id));
      const allocation: Allocation = { version: 1, kind: "phone-use-short-clip-cache", id, eventId, allocatedAt: new Date().toISOString() };
      // The allocation is the durable recovery anchor even if creating media fails.
      const allocationFile = path.join(directory, "allocation.json");
      writePrivate(allocationFile, JSON.stringify(allocation));
      const allocationFd = fs.openSync(allocationFile, "r+"); try { fs.fsyncSync(allocationFd); } finally { fs.closeSync(allocationFd); }
      const videoPath = path.join(directory, "source.mkv"); writePrivate(videoPath, Buffer.alloc(0));
      this.active.add(id);
      return { id, directory, videoPath };
    });
  }
  finalize(id: string, originMetadata: Record<string, unknown>): ClipRecord {
    try {
      const directory = this.location(id), allocation = this.allocation(id), recordFile = path.join(directory, "record.json");
      if (fs.existsSync(recordFile)) return this.open(id);
      if (fs.existsSync(path.join(directory, "failure.json"))) throw new ClipStoreError("CLIP_CAPTURE_ALREADY_FAILED");
      const origin = boundedDetails(originMetadata), file = path.join(directory, "source.mkv"); assertPrivate(file);
      const input = bytes(file, CLIP_MAX_BYTES);
      if (input.length < 4 || input.readUInt32BE(0) !== 0x1a45dfa3) throw new ClipStoreError("CLIP_INVALID_MATROSKA");
      const checksum = sha(input);
      const output = execFileSync(process.env.PHONE_FFPROBE || "ffprobe", ["-v", "error", "-protocol_whitelist", "file,pipe", "-f", "matroska",
        "-select_streams", "v:0", "-show_entries", "stream=codec_type,codec_name,width,height,color_space,color_transfer,color_primaries,color_range:frame=pts_time,pkt_pts_time,best_effort_timestamp_time,width,height:format=duration",
        "-show_frames", "-show_streams", "-of", "json", file], { timeout: remainingTime(6000), maxBuffer: 2 * 1024 * 1024, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      const parsed = parseClipProbe(JSON.parse(output.toString("utf8")));
      // A probed container is insufficient: verify the host can actually review RGB.
      const preview = decodeFrame(file, 0);
      if (preview.readUInt32BE(16) !== parsed.frames[0].width || preview.readUInt32BE(20) !== parsed.frames[0].height)
        throw new ClipStoreError("CLIP_FRAME_DIMENSIONS_CHANGED");
      if (sha(bytes(file, CLIP_MAX_BYTES)) !== checksum) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
      const record: ClipRecord = { ...allocation, status: "complete", completedAt: new Date().toISOString(), expiresAt: this.expires(allocation), storage: "owner-host", origin,
        video: { filename: "source.mkv", bytes: input.length, sha256: checksum, ...parsed.video }, frames: parsed.frames, timing: parsed.timing };
      if (Buffer.byteLength(JSON.stringify(record)) > META_BYTES) throw new ClipStoreError("CLIP_METADATA_LIMIT");
      publish(recordFile, record); return record;
    } finally { this.active.delete(id); }
  }
  fail(id: string, details: Record<string, unknown>): ClipFailure | ClipRecord {
    try {
      const directory = this.location(id), allocation = this.allocation(id), target = path.join(directory, "failure.json");
      if (fs.existsSync(path.join(directory, "record.json"))) return this.open(id);
      if (fs.existsSync(target)) return this.failure(id);
      let length: number | null = null, checksum: string | null = null;
      try { const input = bytes(path.join(directory, "source.mkv"), CLIP_MAX_BYTES); length = input.length; checksum = sha(input); }
      catch { /* Unsafe or changing partial media remains untouched. */ }
      const failure: ClipFailure = { ...allocation, status: "failed", failedAt: new Date().toISOString(), expiresAt: this.expires(allocation), storage: "owner-host",
        imageAvailable: false, partialMediaRetained: true, details: boundedDetails(details), bytes: length, sha256: checksum };
      publish(target, failure); return failure;
    } finally { this.active.delete(id); }
  }
  private failure(id: string): ClipFailure {
    const value = json(path.join(this.location(id), "failure.json")), allocation = this.allocation(id);
    if (value?.version !== 1 || value.id !== id || value.status !== "failed" || value.imageAvailable !== false
      || value.eventId !== allocation.eventId || value.allocatedAt !== allocation.allocatedAt || !stamp(value.failedAt)
      || value.partialMediaRetained !== true || value.storage !== "owner-host") throw new ClipStoreError("CLIP_INVALID_FAILURE_RECORD");
    boundedDetails(value.details);
    return { ...value, expiresAt: this.expires(allocation) };
  }
  private record(id: string): ClipRecord {
    const file = path.join(this.location(id), "record.json");
    if (!fs.existsSync(file)) throw new ClipStoreError("CLIP_NOT_COMPLETE");
    const allocation = this.allocation(id);
    return { ...validateRecord(json(file), id, allocation), expiresAt: this.expires(allocation) };
  }
  open(id: string): ClipRecord {
    const record = this.record(id);
    if (Date.parse(record.expiresAt) <= Date.now()) throw new ClipStoreError("CLIP_EXPIRED");
    const input = bytes(path.join(this.location(id), "source.mkv"), CLIP_MAX_BYTES);
    if (input.length !== record.video.bytes || sha(input) !== record.video.sha256) throw new ClipStoreError("CLIP_CHECKSUM_MISMATCH");
    return record;
  }
  frame(id: string, index: number) {
    const record = this.open(id);
    return this.extract(record, path.join(this.location(id), "source.mkv"), index);
  }
  private extract(record: ClipRecord, file: string, index: number) {
    if (!Number.isInteger(index) || index < 0 || index >= record.frames.length) throw new ClipStoreError("CLIP_FRAME_OUT_OF_RANGE");
    const frame = record.frames[index], png = decodeFrame(file, index);
    if (png.readUInt32BE(16) !== frame.width || png.readUInt32BE(20) !== frame.height) throw new ClipStoreError("CLIP_FRAME_DIMENSIONS_CHANGED");
    if (sha(bytes(file, CLIP_MAX_BYTES)) !== record.video.sha256) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
    return { record, ...frame, png };
  }
  list(options: { limit?: number; before?: string } = {}) {
    const status = this.prune();
    const records = this.scan().entries.map(entry => {
      if (entry.status === "complete") { const { frames, ...summary } = this.record(entry.id); return summary; }
      if (entry.status === "failed") return this.failure(entry.id);
      return { ...entry.allocation, expiresAt: this.expires(entry.allocation), status: "pending" as const, storage: "owner-host" as const, imageAvailable: false };
    }).sort((a, b) => b.allocatedAt.localeCompare(a.allocatedAt) || b.id.localeCompare(a.id));
    return { ...page(records, options, CLIP_ID), status };
  }
  private keepLocation(id: string) {
    if (!KEEP_ID.test(id)) throw new ClipStoreError("CLIP_INVALID_KEEPSAKE_ID");
    const directory = path.join(this.keepsakesDirectory, id); noLinks(directory);
    if (!fs.existsSync(directory) || !fs.lstatSync(directory).isDirectory()) throw new ClipStoreError("CLIP_KEEPSAKE_NOT_FOUND");
    return directory;
  }
  private keepsake(id: string): { record: ClipKeepsake; clip: ClipRecord } {
    const directory = this.keepLocation(id), value = json(path.join(directory, "record.json"), 24 * 1024);
    if (value?.version !== 1 || value.id !== id || !validClipId(value.clipId || "") || !KEEP_ID.test(value.sourceSha256 || "")
      || typeof value.title !== "string" || !value.title.trim() || value.title.length > 160
      || (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 4096)) || !stamp(value.savedAt)
      || value.expiresAt !== null || value.copiedMedia !== true
      || (value.frameIndex !== null && (!Number.isInteger(value.frameIndex) || value.frameIndex < 0 || value.frameIndex >= CLIP_MAX_FRAMES))
      || id !== sha(JSON.stringify([value.clipId, value.frameIndex])) || !KEEP_ID.test(value.media?.sha256 || "")
      || !Number.isSafeInteger(value.media?.bytes) || value.media.bytes < 1 || value.media.bytes > CLIP_MAX_BYTES
      || value.media.filename !== (value.frameIndex === null ? "source.mkv" : "frame.png")
      || value.media.mimeType !== (value.frameIndex === null ? "video/x-matroska" : "image/png")) throw new ClipStoreError("CLIP_INVALID_KEEPSAKE");
    const expected = ["allocation.json", "record.json", "source.json", value.media.filename].sort().join(",");
    if (fs.readdirSync(directory).sort().join(",") !== expected) throw new ClipStoreError("CLIP_INVALID_KEEPSAKE");
    const allocation = json(path.join(directory, "allocation.json"), 4096);
    if (allocation?.kind !== "phone-use-short-clip-keepsake" || allocation.id !== id || allocation.clipId !== value.clipId
      || allocation.mediaFilename !== value.media.filename) throw new ClipStoreError("CLIP_INVALID_KEEPSAKE");
    const clip = validateRecord(json(path.join(directory, "source.json")), value.clipId);
    if (clip.video.sha256 !== value.sourceSha256 || clip.eventId !== value.eventId
      || (value.frameIndex === null && (value.media.sha256 !== clip.video.sha256 || value.media.bytes !== clip.video.bytes || value.ptsMs !== null))
      || (value.frameIndex !== null && (!clip.frames[value.frameIndex] || value.ptsMs !== clip.frames[value.frameIndex].ptsMs))
      || regular(path.join(directory, value.media.filename), CLIP_MAX_BYTES).size !== value.media.bytes) throw new ClipStoreError("CLIP_INVALID_KEEPSAKE");
    return { record: value, clip };
  }
  private keepsakeStatus(): ClipKeepsakeStatus {
    noLinks(this.keepsakesDirectory);
    let usedBytes = 0, count = 0, pendingEntries = 0, blockedEntries = 0;
    for (const name of fs.readdirSync(this.keepsakesDirectory)) {
      remainingTime();
      try {
        const directory = path.join(this.keepsakesDirectory, name); noLinks(directory);
        if (name === ".write.lock") { regular(directory, 256); continue; }
        if (!KEEP_ID.test(name) && !pendingName.test(name)) throw new Error("foreign entry");
        if (!fs.lstatSync(directory).isDirectory()) throw new Error("not a directory");
        if (KEEP_ID.test(name)) this.keepsake(name);
        else {
          const allocation = json(path.join(directory, "allocation.json"), 4096);
          if (allocation?.kind !== "phone-use-short-clip-keepsake" || !KEEP_ID.test(allocation.id || "")
            || !validClipId(allocation.clipId || "") || !["source.mkv", "frame.png"].includes(allocation.mediaFilename)) throw new Error("invalid pending entry");
        }
        let entryBytes = 0;
        for (const file of fs.readdirSync(directory)) {
          if (!["allocation.json", "source.mkv", "frame.png", "source.json", "record.json"].includes(file)) throw new Error("foreign file");
          entryBytes += regular(path.join(directory, file), ["source.mkv", "frame.png"].includes(file) ? CLIP_MAX_BYTES : META_BYTES).size;
        }
        usedBytes += entryBytes; if (KEEP_ID.test(name)) count++; else pendingEntries++;
      } catch { blockedEntries++; }
    }
    const migrationRecommended = usedBytes >= this.options.keepsakeMaxBytes * 0.8 || count + pendingEntries >= this.options.keepsakeMaxCount * 0.8;
    return { storage: "owner-host", enabled: this.options.keepsakesEnabled, maxBytes: this.options.keepsakeMaxBytes,
      maxCount: this.options.keepsakeMaxCount, usedBytes, count, pendingEntries, blockedEntries, migrationRecommended,
      warning: blockedEntries ? "Unrecognized or unsafe keepsake entries were preserved; owner inspection is required. Their bytes are not included in usedBytes."
        : pendingEntries ? "An incomplete keepsake remains in owner storage. Inspect or export it before resuming; nothing was automatically deleted."
        : migrationRecommended ? "Clip keepsakes are at least 80% full. Ask the owner to export and verify a migration; keepsakes are never automatically deleted." : null };
  }
  keep(id: string, title: string, note?: string, frameIndex?: number) {
    if (!this.options.keepsakesEnabled) throw new ClipStoreError("CLIP_KEEPSAKES_DISABLED", this.keepsakeStatus());
    if (!validClipId(id)) throw new ClipStoreError("CLIP_INVALID_ID");
    if (typeof title !== "string" || !title.trim() || title.length > 160 || (note !== undefined && (typeof note !== "string" || note.length > 4096)))
      throw new ClipStoreError("CLIP_INVALID_KEEPSAKE_LABEL");
    if (frameIndex !== undefined && (!Number.isInteger(frameIndex) || frameIndex < 0 || frameIndex >= CLIP_MAX_FRAMES)) throw new ClipStoreError("CLIP_FRAME_OUT_OF_RANGE");
    const keepId = sha(JSON.stringify([id, frameIndex ?? null])), destination = path.join(this.keepsakesDirectory, keepId);
    noLinks(destination);
    const lock = path.join(this.keepsakesDirectory, ".write.lock");
    try { writePrivate(lock, String(process.pid)); } catch { throw new ClipStoreError("CLIP_KEEPSAKE_STORAGE_BUSY"); }
    const lockIdentity = identity(regular(lock, 256)); let primary: unknown;
    try {
      if (fs.existsSync(destination)) return { record: this.openKeepsake(keepId).record, created: false, status: this.keepsakeStatus() };
      const status = this.keepsakeStatus();
      if (status.blockedEntries || status.pendingEntries) throw new ClipStoreError("CLIP_KEEPSAKE_REQUIRES_OWNER_INSPECTION", status);
      const clip = this.open(id);
      if (frameIndex !== undefined && frameIndex >= clip.frames.length) throw new ClipStoreError("CLIP_FRAME_OUT_OF_RANGE");
      const media = frameIndex === undefined ? bytes(path.join(this.location(id), "source.mkv"), CLIP_MAX_BYTES) : this.frame(id, frameIndex).png;
      if (media.length > CLIP_MAX_BYTES) throw new ClipStoreError("CLIP_KEEPSAKE_MEDIA_LIMIT");
      const record: ClipKeepsake = { version: 1, id: keepId, clipId: id, eventId: clip.eventId, sourceSha256: clip.video.sha256,
        savedAt: new Date().toISOString(), title, ...(note === undefined ? {} : { note }), frameIndex: frameIndex ?? null,
        ptsMs: frameIndex === undefined ? null : clip.frames[frameIndex].ptsMs, expiresAt: null, copiedMedia: true,
        media: { filename: frameIndex === undefined ? "source.mkv" : "frame.png", mimeType: frameIndex === undefined ? "video/x-matroska" : "image/png", bytes: media.length, sha256: sha(media) } };
      if (frameIndex === undefined && record.media.sha256 !== clip.video.sha256) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
      const allocation = { version: 1, kind: "phone-use-short-clip-keepsake", id: keepId, clipId: id, savedAt: record.savedAt, mediaFilename: record.media.filename };
      const encoded = JSON.stringify(record), source = JSON.stringify(clip), allocated = JSON.stringify(allocation);
      if (Buffer.byteLength(encoded) > 24 * 1024 || Buffer.byteLength(source) > META_BYTES) throw new ClipStoreError("CLIP_METADATA_LIMIT");
      const required = media.length + Buffer.byteLength(encoded) + Buffer.byteLength(source) + Buffer.byteLength(allocated);
      if (status.usedBytes + required > status.maxBytes || status.count + status.pendingEntries + 1 > status.maxCount)
        throw new ClipStoreError("CLIP_KEEPSAKE_CAPACITY_REACHED", status);
      const pending = privateDirectory(path.join(this.keepsakesDirectory, ".pending-" + randomUUID()));
      writePrivate(path.join(pending, "allocation.json"), allocated);
      writePrivate(path.join(pending, record.media.filename), media);
      writePrivate(path.join(pending, "source.json"), source);
      writePrivate(path.join(pending, "record.json"), encoded);
      for (const name of ["allocation.json", record.media.filename, "source.json", "record.json"]) {
        const fd = fs.openSync(path.join(pending, name), "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      }
      fs.renameSync(pending, destination);
      return { record, created: true, status: this.keepsakeStatus() };
    } catch (error) { primary = error; throw error; }
    finally {
      // On failure keep this call's allocation/media for owner recovery. Release only our lock.
      try {
        if (identity(regular(lock, 256)) !== lockIdentity) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
        fs.unlinkSync(lock);
      } catch (error) { if (!primary) throw error; }
    }
  }
  openKeepsake(id: string): { record: ClipKeepsake; clip: ClipRecord; png?: Buffer } {
    const result = this.keepsake(id), file = path.join(this.keepLocation(id), result.record.media.filename);
    const media = bytes(file, CLIP_MAX_BYTES);
    if (sha(media) !== result.record.media.sha256) throw new ClipStoreError("CLIP_CHECKSUM_MISMATCH");
    if (result.record.frameIndex === null) return result;
    const png = requirePng(media), frame = result.clip.frames[result.record.frameIndex];
    if (png.readUInt32BE(16) !== frame.width || png.readUInt32BE(20) !== frame.height) throw new ClipStoreError("CLIP_FRAME_DIMENSIONS_CHANGED");
    return { ...result, png };
  }
  keptFrame(id: string, index?: number) {
    const kept = this.openKeepsake(id);
    if (kept.record.frameIndex !== null) {
      if (index !== undefined && index !== kept.record.frameIndex) throw new ClipStoreError("CLIP_FRAME_NOT_KEPT");
      return { record: kept.clip, ...kept.clip.frames[kept.record.frameIndex], png: kept.png!, keepsake: kept.record };
    }
    return { ...this.extract(kept.clip, path.join(this.keepLocation(id), "source.mkv"), index ?? 0), keepsake: kept.record };
  }
  keepsakes(options: { limit?: number; before?: string } = {}) {
    const status = this.keepsakeStatus();
    const records: ClipKeepsake[] = [];
    for (const id of fs.readdirSync(this.keepsakesDirectory).filter(id => KEEP_ID.test(id))) {
      remainingTime();
      try { records.push(this.keepsake(id).record); } catch { /* Status reports preserved invalid entries. */ }
    }
    records.sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
    return { ...page(records, options, KEEP_ID), status };
  }
  /** Owner CLI only: copy and verify a collection, retaining every source file. */
  exportTo(target: string) {
    const destination = path.resolve(target); noLinks(destination);
    for (const source of [this.directory, this.keepsakesDirectory]) {
      const relative = path.relative(source, destination);
      if (relative === "" || (relative !== ".." && !relative.startsWith(".." + path.sep) && !path.isAbsolute(relative)))
        throw new ClipStoreError("CLIP_KEEPSAKE_EXPORT_INSIDE_SOURCE");
    }
    if (fs.existsSync(destination)) throw new ClipStoreError("CLIP_KEEPSAKE_EXPORT_DESTINATION_EXISTS");
    const lock = path.join(this.keepsakesDirectory, ".write.lock");
    try { writePrivate(lock, String(process.pid)); } catch { throw new ClipStoreError("CLIP_KEEPSAKE_STORAGE_BUSY"); }
    const lockIdentity = identity(regular(lock, 256)); let primary: unknown;
    try {
      const status = this.keepsakeStatus();
      if (status.blockedEntries || status.pendingEntries) throw new ClipStoreError("CLIP_KEEPSAKE_REQUIRES_OWNER_INSPECTION", status);
      if (!status.count) throw new ClipStoreError("CLIP_KEEPSAKE_EXPORT_EMPTY", status);
      fs.mkdirSync(destination, { mode: 0o700 }); privateDirectory(destination);
      const records: ClipKeepsake[] = [];
      for (const id of fs.readdirSync(this.keepsakesDirectory).filter(id => KEEP_ID.test(id)).sort()) {
        remainingTime();
        const { record, clip } = this.openKeepsake(id), source = this.keepLocation(id);
        const directory = privateDirectory(path.join(destination, id));
        for (const name of ["allocation.json", "record.json", "source.json", record.media.filename]) {
          const maximum = name === record.media.filename ? CLIP_MAX_BYTES : META_BYTES;
          const input = bytes(path.join(source, name), maximum), file = path.join(directory, name);
          if (name === record.media.filename && (input.length !== record.media.bytes || sha(input) !== record.media.sha256))
            throw new ClipStoreError("CLIP_STORAGE_CHANGED");
          if ((name === "record.json" && JSON.stringify(JSON.parse(input.toString("utf8"))) !== JSON.stringify(record))
            || (name === "source.json" && JSON.stringify(JSON.parse(input.toString("utf8"))) !== JSON.stringify(clip)))
            throw new ClipStoreError("CLIP_STORAGE_CHANGED");
          writePrivate(file, input);
          const output = bytes(file, maximum);
          if (output.length !== input.length || sha(output) !== sha(input)) throw new ClipStoreError("CLIP_KEEPSAKE_EXPORT_VERIFY_FAILED");
        }
        records.push(record);
      }
      // The manifest is the completion marker. Partial exports deliberately have none.
      const manifest = { version: 1, exportedAt: new Date().toISOString(), storage: "owner-host", sourceRetained: true,
        checksum: "sha256", records, sourceStatus: status };
      publish(path.join(destination, "manifest.json"), manifest);
      return { destination, count: records.length, verified: true, sourceRetained: true, pendingEntriesNotExported: 0 };
    } catch (error) { primary = error; throw error; }
    finally {
      try {
        if (identity(regular(lock, 256)) !== lockIdentity) throw new ClipStoreError("CLIP_STORAGE_CHANGED");
        fs.unlinkSync(lock);
      } catch (error) { if (!primary) throw error; }
    }
  }
}
