import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { privateDirectory, noLinks, writePrivate } from "./private-files.js";
import { requirePng } from "./screenshot.js";

const ID = /^[a-f0-9]{64}$/;
const IMAGE_BYTES = 16 * 1024 * 1024;
const METADATA_BYTES = 24 * 1024;
export const DEFAULT_KEEPSAKE_BYTES = 256 * 1024 * 1024;
export const DEFAULT_KEEPSAKE_COUNT = 1000;
export type KeepsakeOrigin = { eventId: number; tool: string; capturedAt: string; capturedAtSource?: "capture-finished" | "observation" | "event-start" };
export type KeepsakeRecord = {
  version: 1; id: string; title: string; note?: string; savedAt: string;
  origin: KeepsakeOrigin; sha256: string; imageBytes: number;
};
export type KeepsakeStatus = {
  storage: "owner-host"; maxBytes: number | null; maxCount: number | null;
  usedBytes: number; count: number; pendingEntries: number;
  migrationRecommended: boolean; warning: string | null;
};
export class KeepsakeError extends Error {
  constructor(public code: string, public storageStatus?: KeepsakeStatus) { super(code); }
}
const fail = (code: string): never => { throw new KeepsakeError(code); };
const sha = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const date = (value: unknown) => typeof value === "string" && value.length <= 32 && Number.isFinite(Date.parse(value));
function originValid(origin: any): origin is KeepsakeOrigin {
  return origin && ["capturedAt,eventId,tool", "capturedAt,capturedAtSource,eventId,tool"].includes(Object.keys(origin).sort().join(","))
    && Number.isSafeInteger(origin.eventId) && origin.eventId > 0
    && typeof origin.tool === "string" && /^android_[a-z_]{1,72}$/.test(origin.tool) && date(origin.capturedAt)
    && (origin.capturedAtSource === undefined || ["capture-finished", "observation", "event-start"].includes(origin.capturedAtSource));
}
function labelsValid(value: any) {
  return value && typeof value.title === "string" && value.title.trim().length > 0 && value.title.length <= 160
    && (value.note === undefined || (typeof value.note === "string" && value.note.length <= 4096));
}
const sourceId = (origin: KeepsakeOrigin, digest: string) => sha(JSON.stringify([origin.eventId, origin.tool, origin.capturedAt, digest]));
function regular(file: string, maxBytes: number) {
  noLinks(file);
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > maxBytes) fail("KEEPSAKE_INVALID_STORAGE");
  return stat;
}
function readBinary(file: string, maxBytes: number) {
  const before = regular(file, maxBytes);
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size !== before.size || stat.ino !== before.ino || stat.dev !== before.dev) fail("KEEPSAKE_INVALID_STORAGE");
    const data = Buffer.alloc(stat.size + 1);
    let length = 0, bytes: number;
    while (length < data.length && (bytes = fs.readSync(fd, data, length, data.length - length, null)) > 0) length += bytes;
    const after = fs.fstatSync(fd), current = regular(file, maxBytes);
    if (length !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs
      || current.ino !== stat.ino || current.dev !== stat.dev || current.mtimeMs !== stat.mtimeMs || current.ctimeMs !== stat.ctimeMs) fail("KEEPSAKE_STORAGE_CHANGED");
    return data.subarray(0, length);
  } finally { fs.closeSync(fd); }
}
function syncFile(file: string) {
  const fd = fs.openSync(file, "r+"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Immutable owner-host keepsakes. null limits mean unlimited; nothing expires or is evicted. */
export class KeepsakeStore {
  readonly directory: string;
  readonly maxBytes: number | null;
  readonly maxCount: number | null;
  constructor(ownerDirectory: string, options: { maxBytes: number | null; maxCount: number | null }) {
    for (const value of [options.maxBytes, options.maxCount]) if (value !== null && (!Number.isSafeInteger(value) || value < 1)) fail("KEEPSAKE_INVALID_LIMIT");
    this.maxBytes = options.maxBytes; this.maxCount = options.maxCount;
    this.directory = privateDirectory(path.join(ownerDirectory, "keepsakes"));
  }
  private location(id: string) {
    if (!ID.test(id)) fail("KEEPSAKE_INVALID_ID");
    const location = path.join(this.directory, id); noLinks(location);
    if (!fs.existsSync(location)) fail("KEEPSAKE_NOT_FOUND");
    if (!fs.lstatSync(location).isDirectory()) fail("KEEPSAKE_INVALID_STORAGE");
    return location;
  }
  private record(id: string): KeepsakeRecord {
    const directory = this.location(id);
    if (fs.readdirSync(directory).sort().join(",") !== "image.png,record.json") fail("KEEPSAKE_INVALID_STORAGE");
    let value: any;
    // The root ACL is validated on construction; immutable files are created by
    // writePrivate. Descriptor/no-link checks avoid a shell ACL probe per entry
    // when listing a large collection. The host owner remains trusted.
    try { value = JSON.parse(readBinary(path.join(directory, "record.json"), METADATA_BYTES).toString("utf8")); }
    catch { return fail("KEEPSAKE_INVALID_STORAGE"); }
    const keys = Object.keys(value || {}).sort().join(",");
    if (keys !== "id,imageBytes,origin,savedAt,sha256,title,version" && keys !== "id,imageBytes,note,origin,savedAt,sha256,title,version") fail("KEEPSAKE_INVALID_STORAGE");
    if (value.version !== 1 || value.id !== id || !labelsValid(value) || !originValid(value.origin)
      || !date(value.savedAt) || !ID.test(value.sha256) || !Number.isSafeInteger(value.imageBytes)
      || value.imageBytes < 1 || value.imageBytes > IMAGE_BYTES || sourceId(value.origin, value.sha256) !== id
      || regular(path.join(directory, "image.png"), IMAGE_BYTES).size !== value.imageBytes) fail("KEEPSAKE_INVALID_STORAGE");
    return value;
  }
  status(): KeepsakeStatus {
    noLinks(this.directory);
    let usedBytes = 0, count = 0, pendingEntries = 0;
    for (const name of fs.readdirSync(this.directory)) {
      const directory = path.join(this.directory, name); noLinks(directory);
      if (name === ".write.lock") { regular(directory, 256); continue; }
      if (!ID.test(name) && !/^\.pending-[a-f0-9-]{36}$/.test(name)) fail("KEEPSAKE_INVALID_STORAGE");
      if (!fs.lstatSync(directory).isDirectory()) fail("KEEPSAKE_INVALID_STORAGE");
      if (ID.test(name)) count++; else pendingEntries++;
      for (const file of fs.readdirSync(directory)) {
        if (file !== "image.png" && file !== "record.json") fail("KEEPSAKE_INVALID_STORAGE");
        usedBytes += regular(path.join(directory, file), file === "image.png" ? IMAGE_BYTES : METADATA_BYTES).size;
      }
      if (ID.test(name) && fs.readdirSync(directory).sort().join(",") !== "image.png,record.json") fail("KEEPSAKE_INVALID_STORAGE");
    }
    const migrationRecommended = (this.maxBytes !== null && usedBytes >= this.maxBytes * 0.8)
      || (this.maxCount !== null && count + pendingEntries >= this.maxCount * 0.8);
    return { storage: "owner-host", maxBytes: this.maxBytes, maxCount: this.maxCount, usedBytes, count, pendingEntries,
      migrationRecommended, warning: pendingEntries ? "Incomplete save remains in owner storage; owner inspection required. Nothing was automatically deleted."
        : migrationRecommended ? "Keepsake storage is at least 80% full. Ask the owner to export and verify a migration; existing keepsakes are never automatically deleted." : null };
  }
  save(origin: KeepsakeOrigin, input: Buffer, labels: { title: string; note?: string }) {
    if (!originValid(origin) || !labelsValid(labels)) fail("KEEPSAKE_INVALID_METADATA");
    if (input.length > IMAGE_BYTES) fail("KEEPSAKE_IMAGE_LIMIT");
    const png = requirePng(input), digest = sha(png), id = sourceId(origin, digest);
    const record: KeepsakeRecord = { version: 1, id, title: labels.title, ...(labels.note === undefined ? {} : { note: labels.note }),
      savedAt: new Date().toISOString(), origin: { ...origin }, sha256: digest, imageBytes: png.length };
    const metadata = JSON.stringify(record);
    if (Buffer.byteLength(metadata) > METADATA_BYTES) fail("KEEPSAKE_INVALID_METADATA");
    const lock = path.join(this.directory, ".write.lock");
    try { writePrivate(lock, String(process.pid)); } catch { fail("KEEPSAKE_STORAGE_BUSY"); }
    let pending: string | undefined;
    try {
      const destination = path.join(this.directory, id); noLinks(destination);
      if (fs.existsSync(destination)) {
        const existing = this.open(id);
        return { record: existing.record, created: false, status: existing.status };
      }
      const status = this.status(), bytes = png.length + Buffer.byteLength(metadata);
      if ((this.maxBytes !== null && status.usedBytes + bytes > this.maxBytes)
        || (this.maxCount !== null && status.count + status.pendingEntries >= this.maxCount)) throw new KeepsakeError("KEEPSAKE_CAPACITY_REACHED", status);
      pending = privateDirectory(path.join(this.directory, ".pending-" + randomUUID()));
      writePrivate(path.join(pending, "image.png"), png);
      writePrivate(path.join(pending, "record.json"), metadata);
      syncFile(path.join(pending, "image.png")); syncFile(path.join(pending, "record.json"));
      fs.renameSync(pending, destination); pending = undefined;
      return { record, created: true, status: this.status() };
    } finally {
      // Only this call's unpublished files may be removed; never touch committed records.
      if (pending) {
        noLinks(pending);
        for (const name of ["image.png", "record.json"]) {
          const file = path.join(pending, name); noLinks(file);
          if (fs.existsSync(file)) { regular(file, name === "image.png" ? IMAGE_BYTES : METADATA_BYTES); fs.unlinkSync(file); }
        }
        fs.rmdirSync(pending);
      }
      noLinks(lock); regular(lock, 256); fs.unlinkSync(lock);
    }
  }
  list(options: { limit?: number; before?: string } = {}) {
    const limit = options.limit ?? 10;
    if (!Number.isInteger(limit) || limit < 1 || limit > 30 || (options.before !== undefined && !ID.test(options.before))) fail("KEEPSAKE_INVALID_CURSOR");
    const status = this.status();
    const records = fs.readdirSync(this.directory).filter(name => ID.test(name)).map(id => this.record(id))
      .sort((a, b) => b.savedAt.localeCompare(a.savedAt) || b.id.localeCompare(a.id));
    const start = options.before === undefined ? 0 : records.findIndex(record => record.id === options.before) + 1;
    if (options.before !== undefined && start === 0) fail("KEEPSAKE_INVALID_CURSOR");
    const selected = records.slice(start, start + limit);
    return { records: selected, nextBefore: start + selected.length < records.length ? selected.at(-1)!.id : null, status };
  }
  open(id: string) {
    return { ...this.read(id), status: this.status() };
  }
  private read(id: string) {
    const record = this.record(id);
    const png = readBinary(path.join(this.location(id), "image.png"), IMAGE_BYTES);
    if (sha(png) !== record.sha256) fail("KEEPSAKE_CHECKSUM_MISMATCH");
    requirePng(png);
    return { record, png };
  }
  /** Owner CLI only. A new private destination is mandatory; the source is never removed. */
  exportTo(target: string) {
    const destination = path.resolve(target), relative = path.relative(this.directory, destination);
    noLinks(destination);
    if (relative === "" || (!relative.startsWith(".." + path.sep) && relative !== ".." && !path.isAbsolute(relative))) fail("KEEPSAKE_EXPORT_INSIDE_SOURCE");
    if (fs.existsSync(destination)) fail("KEEPSAKE_EXPORT_DESTINATION_EXISTS");
    fs.mkdirSync(destination, { mode: 0o700 });
    privateDirectory(destination);
    const records: KeepsakeRecord[] = [];
    const status = this.status();
    for (const id of fs.readdirSync(this.directory).filter(name => ID.test(name)).sort()) {
      const { record, png } = this.read(id);
      const directory = privateDirectory(path.join(destination, id));
      writePrivate(path.join(directory, "image.png"), png);
      writePrivate(path.join(directory, "record.json"), JSON.stringify(record));
      if (sha(readBinary(path.join(directory, "image.png"), IMAGE_BYTES)) !== record.sha256
        || readBinary(path.join(directory, "record.json"), METADATA_BYTES).toString("utf8") !== JSON.stringify(record)) fail("KEEPSAKE_EXPORT_VERIFY_FAILED");
      records.push(record);
    }
    const manifest = { version: 1, exportedAt: new Date().toISOString(), sourceRetained: true, checksum: "sha256", records, sourceStatus: status };
    writePrivate(path.join(destination, "manifest.json"), JSON.stringify(manifest, null, 2));
    return { destination, count: records.length, verified: true, sourceRetained: true, pendingEntriesNotExported: status.pendingEntries };
  }
}
