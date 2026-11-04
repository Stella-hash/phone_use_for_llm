import { PNG } from "pngjs";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { requirePng } from "./screenshot.js";
import { remainingTime } from "./deadline.js";

export const IMAGE_BYTE_LIMIT = 1024 * 1024;
export const DEFAULT_IMAGE_EDGE = 1600;

/** Bound transport payloads; keep the source file intact. Coordinates remain in source pixels. */
export function prepareImage(input: Buffer, maxEdge = DEFAULT_IMAGE_EDGE) {
  if (!Number.isInteger(maxEdge) || maxEdge < 256 || maxEdge > 2048) throw new Error("imageMaxEdge must be an integer from 256 to 2048");
  requirePng(input);
  const width = input.readUInt32BE(16), height = input.readUInt32BE(20);
  if (width * height > 32000000 || input.length > 64 * 1024 * 1024) throw new Error("Screenshot exceeds supported decode bounds");
  const source = { width, height, bytes: input.length };
  const finish = (bytes: Buffer, w: number, h: number) => ({ bytes, metadata: {
    source, returned: { width: w, height: h, bytes: bytes.length },
    coordinateScale: { x: width / w, y: height / h },
    resized: w !== width || h !== height, byteLimit: IMAGE_BYTE_LIMIT,
  } });
  if (Math.max(width, height) <= maxEdge && input.length <= IMAGE_BYTE_LIMIT) return finish(input, width, height);
  remainingTime();
  const decoded = PNG.sync.read(input);
  let scale = Math.min(1, maxEdge / Math.max(width, height));
  for (let attempt = 0; attempt < 10; attempt++, scale *= 0.7) {
    remainingTime();
    const w = Math.max(1, Math.round(width * scale)), h = Math.max(1, Math.round(height * scale));
    const data = Buffer.alloc(w * h * 4);
    // Bilinear sampling keeps text edges usable without a native image dependency.
    for (let y = 0; y < h; y++) {
      if (y % 64 === 0) remainingTime();
      const sy = Math.max(0, Math.min(height - 1, (y + 0.5) * height / h - 0.5));
      const y0 = Math.floor(sy), y1 = Math.min(height - 1, y0 + 1), fy = sy - y0;
      for (let x = 0; x < w; x++) {
        const sx = Math.max(0, Math.min(width - 1, (x + 0.5) * width / w - 0.5));
        const x0 = Math.floor(sx), x1 = Math.min(width - 1, x0 + 1), fx = sx - x0;
        for (let c = 0; c < 4; c++) {
          const a = decoded.data[(y0 * width + x0) * 4 + c] * (1 - fx) + decoded.data[(y0 * width + x1) * 4 + c] * fx;
          const b = decoded.data[(y1 * width + x0) * 4 + c] * (1 - fx) + decoded.data[(y1 * width + x1) * 4 + c] * fx;
          data[(y * w + x) * 4 + c] = Math.round(a * (1 - fy) + b * fy);
        }
      }
    }
    const bytes = PNG.sync.write({ width: w, height: h, data } as PNG, { deflateLevel: 6 });
    if (bytes.length <= IMAGE_BYTE_LIMIT) return finish(bytes, w, h);
  }
  throw new Error("Screenshot could not fit the image byte limit");
}

/** An image encoding/delivery preparation failure must not discard the action's text result. */
export function boundResultImages(result: CallToolResult, sourceEventId: number, maxEdge = DEFAULT_IMAGE_EDGE, deferred = false) {
  let inline = false;
  result.content = result.content.flatMap((item): CallToolResult["content"] => {
    if (item.type !== "image") return [item];
    let metadata: any;
    try {
      if (deferred) metadata = { status: "deferred", sourceEventId };
      else {
        if (item.mimeType !== "image/png") throw new Error("Unsupported screenshot format");
        const prepared = prepareImage(Buffer.from(item.data, "base64"), maxEdge);
        inline = true;
        return [{ ...item, data: prepared.bytes.toString("base64") },
          { type: "text" as const, text: JSON.stringify({ phoneImage: { status: "inline", sourceEventId, ...prepared.metadata } }) }];
      }
    } catch (error) {
      metadata = { status: "unavailable", sourceEventId, error: error instanceof Error ? error.message : "Image preparation failed" };
    }
    return [{ type: "text" as const, text: JSON.stringify({ phoneImage: metadata }) }];
  });
  return inline;
}
