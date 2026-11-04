import type { IncomingMessage } from "node:http";
import { deny } from "./security.js";
import { strictJson } from "./json.js";

export const LIMITS = Object.freeze({ bodyBytes: 65536, jsonDepth: 12, jsonNodes: 4096, arrayItems: 512,
  stringLength: 8192, fields: 64, httpConnections: 16, queue: 8, payloadBytes: 256 * 1024,
  events: 2000, requestIds: 20000, retentionMs: 7 * 24 * 3600000, databaseBytes: 32 * 1024 * 1024,
  imageBytes: 16 * 1024 * 1024, imagesBytes: 64 * 1024 * 1024, images: 200 });

export function boundedValue(input: unknown) {
  let count = 0;
  const walk = (v: any, depth: number) => {
    if (++count > LIMITS.jsonNodes || depth > LIMITS.jsonDepth) deny("STRUCTURE_LIMIT");
    if (typeof v === "string" && v.length > LIMITS.stringLength) deny("FIELD_LIMIT");
    if (Array.isArray(v)) { if (v.length > LIMITS.arrayItems) deny("COLLECTION_LIMIT"); v.forEach(x => walk(x, depth + 1)); }
    else if (v && typeof v === "object") {
      if (Object.keys(v).length > LIMITS.fields) deny("FIELD_LIMIT");
      for (const [k, x] of Object.entries(v)) { if (k.length > 128 || ["__proto__", "constructor", "prototype"].includes(k)) deny("FIELD_LIMIT"); walk(x, depth + 1); }
    }
  };
  walk(input, 0);
}

export async function readRequest(req: IncomingMessage) {
  if (req.headers["content-encoding"] || !/^application\/json(?:\s*;|$)/i.test(req.headers["content-type"] || "")) deny("CONTENT_TYPE");
  if (Number(req.headers["content-length"] || 0) > LIMITS.bodyBytes) deny("BODY_LIMIT");
  let bytes = 0;
  const chunks: Buffer[] = [];
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    for await (const chunk of req) {
      bytes += chunk.length;
      if (bytes > LIMITS.bodyBytes) deny("BODY_LIMIT");
      chunks.push(chunk);
    }
  } finally { clearTimeout(timer); }
  const body = strictJson(Buffer.concat(chunks).toString());
  if (Array.isArray(body)) deny("BATCH_DISABLED");
  boundedValue(body);
  return body;
}
