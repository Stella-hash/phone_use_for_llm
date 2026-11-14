import { createHash } from "node:crypto";
import { PolicyError } from "./security.js";
import { LIMITS } from "./limits.js";
import type { Decision } from "./delegation-model.js";

const reject = (code: string): never => { throw new PolicyError(code); };
export function availableEvent(entry: any) {
  return !!entry && !entry.callerClaim?.private && Date.parse(entry.startedAt) > Date.now() - LIMITS.retentionMs
    && entry.outcome === "completed" && Array.isArray(entry.observation?.elements) && !entry.observation.passwordInputVisible;
}
export function textSource(entry: any, web?: any) {
  if (!availableEvent(entry)) return reject("DELEGATION_EVIDENCE_UNAVAILABLE");
  const spans: any[] = [];
  if (web) {
    if (typeof web.text !== "string" || !web.documentId || !web.url) return reject("DELEGATION_WEB_SOURCE_UNBOUND");
    const saved = entry.observation.elements.find((e: any) => e.type === "ChromePageText");
    if (saved?.text !== web.text) return reject("DELEGATION_WEB_SOURCE_UNBOUND");
    for (const text of web.text.split("\n")) spans.push({ index: spans.length, text });
  } else {
    for (const [elementIndex, e] of entry.observation.elements.entries()) {
      if (e.editable || e.password) continue;
      for (const field of ["text", "label"]) if (typeof e[field] === "string" && e[field].trim()) spans.push({ index: spans.length, text: e[field], elementIndex, field });
    }
  }
  // Do not silently truncate proof: oversized sources are an explicit obstacle.
  if (spans.length > 1024 || Buffer.byteLength(JSON.stringify(spans)) > 48000) return reject("DELEGATION_SOURCE_LIMIT");
  return { eventId: entry.id, sourceType: web ? "chrome_text" : "android_ui", observedAt: entry.observation.at,
    packageName: entry.observation.foregroundApp?.packageName,
    ...(web ? { url: web.url, documentId: web.documentId, title: web.title, truncated: web.truncated, scope: web.scope } : {}),
    sha256: createHash("sha256").update(JSON.stringify(spans)).digest("hex"), spans };
}
export function bindFinding(decision: Decision, sources: Map<number, any>, images: Set<number>, open: (id: number) => any) {
  const f = decision.finding;
  if (!f || decision.targetIndex !== null || decision.value !== null) return reject("DELEGATION_REPORT_INVALID");
  const evidence = f.references.map(ref => {
    const source = sources.get(ref.readEventId);
    if (!source || !availableEvent(open(ref.readEventId))) return reject("DELEGATION_EVIDENCE_EXPIRED_OR_UNKNOWN");
    const spans = ref.spanIds.map(i => {
      if (!source.spans[i] || source.spans[i].index !== i) return reject("DELEGATION_SPAN_UNKNOWN");
      return source.spans[i];
    });
    const { spans: ignored, ...metadata } = source;
    return { ...metadata, readEventId: source.eventId, spans };
  });
  const visualEvidence = f.visualEventIds.map(eventId => {
    if (!images.has(eventId) || !availableEvent(open(eventId))) return reject("DELEGATION_VISUAL_EVIDENCE_UNAVAILABLE");
    return { eventId, interpretation: "model-derived visual interpretation, not exact text proof", historical: true };
  });
  if (decision.action !== "blocked" && !evidence.length && !visualEvidence.length) return reject("DELEGATION_FINDING_NEEDS_EVIDENCE");
  const result = { intentVersion: decision.intentVersion, summary: f.summary, question: f.question, uncertainty: f.uncertainty,
    interpretation: "model-derived; exact text spans copied by code", evidence, visualEvidence };
  if (Buffer.byteLength(JSON.stringify(result)) > 24000) return reject("DELEGATION_FINDING_SIZE_LIMIT");
  return result;
}
