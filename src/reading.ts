import type { ScreenElement } from "./ui.js";

// Exact source text only. This observer neither reads pixels nor calls a model.
interface Block { text: string; elementIndex: number; y: number }
interface Snapshot {
  eventId: number; app: string | null; scope: string | null;
  title: string | null; author: string | null; blocks: Block[];
  issue: string | null; sampledAt: string | null; hasImage: boolean;
  mediaIndex: number | null; mediaTotal: number | null; mediaElementIndex: number | null;
}
const normalize = (text: string) => text.replace(/\s+/gu, " ").trim();
const hasText = (e: ScreenElement) => typeof e.text === "string" && e.text.trim().length > 0;

function snapshot(event: any): Snapshot {
  const obs = event?.observation;
  const out: Snapshot = { eventId: event.id, app: obs?.foregroundApp?.packageName ?? null,
    scope: null, title: null, author: null, blocks: [], issue: null,
    sampledAt: obs?.at ?? null, hasImage: !!obs?.screenshot,
    mediaIndex: null, mediaTotal: null, mediaElementIndex: null };
  if (event.callerClaim?.private || obs?.passwordInputVisible) { out.issue = "private_observation"; out.hasImage = false; return out; }
  if (event.outcome !== "completed" || !Array.isArray(obs?.elements)) { out.issue = "text_unavailable"; return out; }
  const elements: ScreenElement[] = obs.elements;
  const nodes = (id: string) => elements.filter(e => e.identifier === `${out.app}:id/${id}`);
  const value = (...ids: string[]) => {
    const values = [...new Set(ids.flatMap(id => nodes(id).filter(hasText).map(e => e.text!.trim())))];
    return values.length === 1 && values[0].length <= 1024 ? values[0] : null;
  };
  if (out.app === "com.xingin.xhs") {
    out.scope = "post_caption";
    out.title = value("noteTitleTV"); out.author = value("nickNameTV");
    const counters = nodes("imageNumberTextView").filter(hasText);
    if (nodes("noteDetailRoot").length === 1 && counters.length === 1) {
      const text = counters[0].text!.trim();
      const match = text.length <= 30 ? text.match(/^([1-9]\d*)\s*\/\s*([1-9]\d*)$/u) : null;
      if (match) {
        const index = Number(match[1]), total = Number(match[2]);
        if (Number.isSafeInteger(index) && Number.isSafeInteger(total) && index <= total) {
          out.mediaIndex = index; out.mediaTotal = total; out.mediaElementIndex = elements.indexOf(counters[0]);
        }
      }
    }
    const bodies = nodes("imageNoteTextView").filter(hasText);
    if (nodes("noteDetailRoot").length !== 1 || bodies.length !== 1) {
      out.issue = bodies.length > 1 ? "ambiguous_body" : "body_unavailable"; return out;
    }
    const body = bodies[0];
    out.blocks = [{ text: body.text!, elementIndex: elements.indexOf(body), y: body.rect.y }];
  } else if (out.app === "com.moomoo.trade.ca") {
    out.scope = "article_webview";
    out.title = value("title_text"); out.author = value("author_name_text", "toolbar_user_name");
    const webviews = elements.filter(e => e.type === "android.webkit.WebView");
    if (nodes("media_detail_content_container").length !== 1 || !webviews.length) {
      out.issue = "article_scope_unavailable"; return out;
    }
    // Old flattened dumps cannot prove WebView ancestry. Do not guess using bounds.
    if (webviews.some(view => view.webView === undefined)) { out.issue = "webview_scope_unavailable"; return out; }
    const groups = new Set(webviews.map(view => view.webView));
    if (groups.size !== 1) { out.issue = "article_scope_unavailable"; return out; }
    const group = webviews[0].webView;
    const seen = new Set<string>();
    for (const [index, e] of elements.entries()) {
      if (e.webView !== group || !hasText(e) || e.password || /Image|Button|EditText/.test(e.type)) continue;
      const text = e.text!;
      const key = JSON.stringify([normalize(text), e.rect]);
      if (seen.has(key)) continue;
      seen.add(key);
      out.blocks.push({ text, elementIndex: index, y: e.rect.y });
    }
    if (!out.blocks.length) out.issue = "body_unavailable";
  } else out.issue = "unsupported_page";
  if (out.blocks.length > 160 || out.blocks.reduce((n, b) => n + b.text.length, 0) > 16000) {
    out.blocks = []; out.issue = "source_too_large";
  }
  return out;
}

function occurrences(haystack: string[], needle: string[]): number[] {
  const starts: number[] = [];
  for (let i = 0; i + needle.length <= haystack.length; i++) {
    if (needle.every((text, j) => text === haystack[i + j])) starts.push(i);
  }
  return starts;
}

/** Compare explicit saved events. The returned cursor tracks delivered source text, not attention. */
export function readingCursor(event: any, previous?: any) {
  if (!event || !Number.isSafeInteger(event.id)) throw new Error("Activity record not found");
  if (previous && (!Number.isSafeInteger(previous.id) || previous.id >= event.id))
    throw new Error("previousEventId must identify an earlier observation");
  const current = snapshot(event);
  const result = {
    skill: "social-feed-cursor", version: "0.2", status: "review" as "seeded" | "unchanged" | "advanced" | "backward" | "review",
    title: current.title, author: current.author,
    media_index: current.mediaIndex, media_total: current.mediaTotal,
    same_post: null as boolean | null,
    new_text: [] as string[], overlap_anchor: null as string | null,
    scroll_result: "unknown" as "advanced" | "backward" | "unchanged" | "unknown",
    needs_review: true, issue: current.issue,
    cursor_event_id: previous?.id ?? null as number | null,
    evidence_frame: current.eventId, evidence_available: current.hasImage,
    source: { kind: "accessibility", scope: current.scope, sampled_at: current.sampledAt,
      element_indices: current.blocks.map(b => b.elementIndex), media_element_index: current.mediaElementIndex },
    identity_basis: null as string | null,
  };
  if (current.issue) return result;
  if (!previous) {
    return { ...result, status: "seeded" as const, new_text: current.blocks.map(b => b.text),
      needs_review: false, cursor_event_id: current.eventId };
  }
  const prior = snapshot(previous);
  if (prior.issue) return { ...result, issue: "previous_text_unavailable" };
  if (prior.app !== current.app || prior.scope !== current.scope
    || (prior.author && current.author && prior.author !== current.author)
    || (prior.title && current.title && prior.title !== current.title)) {
    return { ...result, same_post: false, issue: "different_post_evidence" };
  }
  const metadataMatch = (prior.author && prior.author === current.author)
    || (prior.title && prior.title === current.title);
  if (!metadataMatch) return { ...result, issue: "identity_unverified" };
  const a = prior.blocks.map(b => normalize(b.text)), b = current.blocks.map(b => normalize(b.text));
  // Use a unique, substantial suffix. A repeated quote or a short UI label is not an anchor.
  for (let start = 0; start < a.length; start++) {
    const suffix = a.slice(start);
    if (suffix.join("\n").length < 48 || occurrences(a, suffix).length !== 1) continue;
    const hits = occurrences(b, suffix);
    if (hits.length !== 1) continue;
    const at = hits[0], end = at + suffix.length;
    const dy = current.blocks[at].y - prior.blocks[start].y;
    const movement = dy < -8 ? "advanced" : dy > 8 ? "backward" : "unchanged";
    const newText = current.blocks.slice(end).map(block => block.text);
    // Do not move the delivered-text cursor backwards and resend text on a later forward scroll.
    if (movement === "backward") return { ...result, status: "backward" as const,
      same_post: true, needs_review: false, scroll_result: movement as "backward",
      overlap_anchor: prior.blocks.at(-1)!.text.slice(-120), identity_basis: "derived_metadata_and_unique_text_overlap" };
    return { ...result, status: newText.length ? "advanced" as const : "unchanged" as const,
      same_post: true, new_text: newText, overlap_anchor: prior.blocks.at(-1)!.text.slice(-120),
      scroll_result: movement as "advanced" | "unchanged", needs_review: false,
      cursor_event_id: current.eventId, identity_basis: "derived_metadata_and_unique_text_overlap" };
  }
  // An earlier window entirely contained in the previous one is a revisit, not new text.
  const contained = occurrences(a, b);
  if (b.join("\n").length >= 48 && contained.length === 1
    && current.blocks[0].y - prior.blocks[contained[0]].y > 8) {
    return { ...result, status: "backward" as const, same_post: true, needs_review: false,
      scroll_result: "backward" as const, overlap_anchor: current.blocks.at(-1)!.text.slice(-120),
      identity_basis: "derived_metadata_and_contained_text" };
  }
  return { ...result, issue: "no_unique_overlap" };
}
