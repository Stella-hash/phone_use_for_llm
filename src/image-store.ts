import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { privateDirectory, noLinks, writePrivate } from "./private-files.js";
import { LIMITS } from "./limits.js";
import { requirePng } from "./screenshot.js";

export class ImageStore {
  readonly directory: string;
  constructor(directory: string) { this.directory = privateDirectory(path.join(directory, "images")); this.prune(); }
  prune(requiredBytes = 0) {
    const files = fs.readdirSync(this.directory).filter(n => /^event-\d+-[a-f0-9-]{36}\.png$/.test(n)).map(name => {
      const file = path.join(this.directory, name); noLinks(file);
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.nlink !== 1) throw new Error("Invalid image storage");
      return { file, size: stat.size, time: stat.mtimeMs };
    }).sort((a, b) => a.time - b.time);
    let total = files.reduce((s, f) => s + f.size, 0), count = files.length;
    for (const f of files) {
      if (f.time < Date.now() - LIMITS.retentionMs || total + requiredBytes > LIMITS.imagesBytes || count >= LIMITS.images) {
        fs.unlinkSync(f.file); total -= f.size; count--;
      }
    }
  }
  save(eventId: number, input: Buffer) {
    if (input.length > LIMITS.imageBytes) throw new Error("Image storage limit");
    const png = requirePng(input);
    this.prune(png.length);
    const filename = `event-${eventId}-${randomUUID()}.png`;
    writePrivate(path.join(this.directory, filename), png);
    return { filename, storage: "owner-host", galleryIndexed: false };
  }
  open(reference: any) {
    if (reference?.storage !== "owner-host" || !/^event-\d+-[a-f0-9-]{36}\.png$/.test(reference?.filename || "")) throw new Error("No owner image");
    this.prune();
    const file = path.join(this.directory, reference.filename); noLinks(file);
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > LIMITS.imageBytes) throw new Error("Invalid stored image");
    return requirePng(fs.readFileSync(file));
  }
  available(reference: any) {
    try {
      if (reference?.storage !== "owner-host" || !/^event-\d+-[a-f0-9-]{36}\.png$/.test(reference?.filename || "")) return false;
      const file = path.join(this.directory, reference.filename); noLinks(file);
      const stat = fs.statSync(file);
      return stat.isFile() && stat.nlink === 1 && stat.size <= LIMITS.imageBytes && stat.mtimeMs >= Date.now() - LIMITS.retentionMs;
    } catch { return false; }
  }
}
