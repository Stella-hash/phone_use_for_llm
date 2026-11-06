import { z } from "zod";
import type { Tool, CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { ClipStore, ClipStoreError, type ClipRecord } from "./clip-store.js";
import { prepareImage } from "./image-delivery.js";

const id = z.string().regex(/^clip-[1-9]\d*-[a-f0-9-]{36}$/);
export const clipOpenSchema = z.object({ id: id.optional(), keepsakeId: z.string().max(100).optional(),
  frameIndices: z.array(z.number().int().min(0).max(599)).min(1).max(6).optional(),
  collection: z.enum(["clips", "keepsakes"]).optional(),
  limit: z.number().int().min(1).max(30).optional(), before: z.string().max(100).optional(),
}).strict().refine(q => q.id || q.keepsakeId ? !(q.id && q.keepsakeId) && !q.collection && !q.limit && !q.before : !q.frameIndices,
  "Use id or keepsakeId with optional frameIndices to open media; collection, limit and before are for lists");
export const clipKeepSchema = z.object({ id, title: z.string().trim().min(1).max(160),
  note: z.string().max(4096).optional(), frameIndex: z.number().int().min(0).max(599).optional(),
}).strict();
const point = { type: "object", additionalProperties: false, properties: {
  x: { type: "integer", minimum: 0, maximum: 32767 }, y: { type: "integer", minimum: 0, maximum: 32767 },
}, required: ["x", "y"] };
export const clipTools: Tool[] = [
  { name: "android_capture_clip", title: "Capture a Short Animation", description: "Record 1–5 seconds of silent video into a bounded disposable host cache, optionally with one native-coordinate tap. Requires requestId even without a tap, owner-enabled shortClips for this non-browser app, an awake unlocked phone, current expectedPackage and expectedDisplay. A tap needs exact signed approval or an explicit app grant for this tool. No automatic wake, pause, retry or phone gallery file. Returns a clip ID, expiry, actual decoded frame timestamps and storage status; use android_clip_open for frames. 30 fps is a ceiling. Video PTS and host input timestamps are separate clocks; pre-roll does not prove the first frame arrived before input. Password UI and private=true reject capture. Only endpoint/pre-tap privacy checks are possible: intermediate frames may include overlays, notifications or another app, as acknowledged in owner setup. Recover a lost response by requestId before any new action.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      expectedPackage: { type: "string", maxLength: 200 },
      expectedDisplay: { type: "object", additionalProperties: false, properties: {
        width: { type: "integer", minimum: 1, maximum: 32768 }, height: { type: "integer", minimum: 1, maximum: 32768 },
      }, required: ["width", "height"] },
      durationMs: { type: "integer", minimum: 1000, maximum: 5000, default: 3000 }, tap: point,
    }, required: ["expectedPackage", "expectedDisplay"] }, annotations: { readOnlyHint: false } },
  { name: "android_clip_open", title: "Browse Clips or Inspect Frames", description: "Read host clips without phone contact. Without id/keepsakeId, list disposable clips or collection=keepsakes with retention and budget status. With id, inspect a cached clip; with keepsakeId, inspect an independent permanent copy after its source cache expires. Return at most six images labelled with zero-based frame index and actual video-relative timestamp. The default time-spaced overview may miss brief events; frameIndices selects exact frames. Frames are historical encoded-video pixels without native tap coordinates. Decode checked media on demand, without a frame cache. Failed/pending records are listed honestly and cannot be opened as complete recordings. Keepsakes require separate owner opt-in.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      id: { type: "string", maxLength: 100 }, keepsakeId: { type: "string", maxLength: 100 }, frameIndices: { type: "array", minItems: 1, maxItems: 6, items: { type: "integer", minimum: 0, maximum: 599 } },
      collection: { type: "string", enum: ["clips", "keepsakes"] }, limit: { type: "integer", minimum: 1, maximum: 30 }, before: { type: "string", maxLength: 100 },
      imageMaxEdge: { type: "integer", minimum: 256, maximum: 2048, description: "Maximum returned frame edge. Defaults to 640 for an overview or 1280 for one frame. A PNG byte cap may reduce it further. These are historical video pixels with no native tap mapping." },
    } }, annotations: { readOnlyHint: true } },
  { name: "android_clip_keep", title: "Keep a Clip or a Particular Frame", description: "Copy an existing complete clip or one zero-based frameIndex, with provenance, into permanent host keepsakes. Requires owner-enabled clip keepsakes and requestId; no phone input, capture or signed phone-input approval. Copies survive source cache expiry. Separate byte/count limits reject new saves; at 80 percent, status recommends owner migration. Old keepsakes are never automatically deleted. Repeated saves preserve the first title/note. Browse with android_clip_open collection=keepsakes, then open keepsakeId. Private calls cannot save keepsakes.",
    inputSchema: { type: "object", additionalProperties: false, properties: { id: { type: "string", maxLength: 100 }, title: { type: "string", minLength: 1, maxLength: 160 }, note: { type: "string", maxLength: 4096 }, frameIndex: { type: "integer", minimum: 0, maximum: 599 } }, required: ["id", "title"] }, annotations: { readOnlyHint: false } },
];

export function overviewIndices(record: ClipRecord): number[] {
  const count = Math.min(6, record.frames.length), chosen = new Set<number>();
  for (let i = 0; i < count; i++) {
    const target = count === 1 ? 0 : i * record.video.spanMs / (count - 1);
    let nearest = record.frames[0];
    for (const frame of record.frames) if (Math.abs(frame.relativeMs - target) < Math.abs(nearest.relativeMs - target)) nearest = frame;
    chosen.add(nearest.index);
  }
  return [...chosen].sort((a, b) => a - b);
}

export function openClip(store: ClipStore, input: unknown, maxEdge?: number): CallToolResult {
  const query = clipOpenSchema.parse(input);
  if (!query.id && !query.keepsakeId) return { content: [{ type: "text", text: JSON.stringify({ ...(query.collection === "keepsakes"
    ? { phoneClipKeepsakes: store.keepsakes(query) } : { phoneClips: store.list(query) }), status: store.status(), phoneContacted: false }) }] };
  const kept = query.keepsakeId ? store.openKeepsake(query.keepsakeId) : undefined;
  const record = kept?.clip ?? store.open(query.id!);
  const indices = query.frameIndices ?? (kept?.record.frameIndex != null ? [kept.record.frameIndex] : overviewIndices(record));
  // Validate every selection before decoding any image.
  if (indices.some(index => index >= record.frames.length)) throw new Error("CLIP_FRAME_NOT_FOUND");
  const result: CallToolResult = { content: [{ type: "text", text: JSON.stringify({ phoneClip: record,
    ...(kept ? { phoneClipKeepsake: kept.record, mediaRetention: { source: "independent-keepsake-copy", expiresAt: null, originalCacheExpiresAt: record.expiresAt } }
      : { mediaRetention: { source: "disposable-cache", expiresAt: record.expiresAt } }), status: store.status(), phoneContacted: false,
    selection: { mode: query.frameIndices ? "exact-frame-indices" : "time-spaced-overview", indices,
      exhaustive: new Set(indices).size === record.frames.length, nativeTapCoordinates: false } }) }] };
  for (const index of indices) {
    try {
      const frame = query.keepsakeId ? store.keptFrame(query.keepsakeId, index) : store.frame(record.id, index);
      const prepared = prepareImage(frame.png, maxEdge ?? (indices.length === 1 ? 1280 : 640));
      const { coordinateScale: ignored, ...dimensions } = prepared.metadata;
      result.content.push({ type: "text", text: JSON.stringify({ clipFrame: { clipId: record.id, index,
        ptsMs: frame.ptsMs, relativeMs: frame.relativeMs, timestampKind: frame.timestampKind,
        historical: true, nativeTapCoordinates: false, ...dimensions } }) },
      { type: "image", mimeType: "image/png", data: prepared.bytes.toString("base64") });
    } catch (error) {
      result.isError = true;
      result.content.push({ type: "text", text: JSON.stringify({ clipFrame: { clipId: record.id, index, status: "unavailable",
        error: error instanceof ClipStoreError ? error.code : "CLIP_FRAME_UNAVAILABLE" } }) });
      break;
    }
  }
  return result;
}
