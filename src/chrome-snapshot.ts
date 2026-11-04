import { ActionableError } from "./adb.js";

/** Whitelist semantic output. Raw attributes, cookies, script and password values never leave this function. */
export function normalizeChromeSnapshot(snapshot: any, ax: any, metrics: any, frameId: string, url: string,
  limits: { maxChars: number; maxElements: number }) {
  const strings = snapshot.strings;
  if (!Array.isArray(strings) || !Array.isArray(snapshot.documents) || !Array.isArray(ax.nodes))
    throw new ActionableError("Chrome returned an unsupported snapshot shape");
  const str = (i: number) => typeof strings[i] === "string" ? strings[i] as string : "";
  const doc = snapshot.documents.find((d: any) => str(d.frameId) === frameId);
  const viewport = metrics.cssVisualViewport;
  if (!doc || str(doc.documentURL) !== url || !viewport || ![viewport.pageX, viewport.pageY, viewport.clientWidth, viewport.clientHeight].every(Number.isFinite))
    throw new ActionableError("Chrome document or CSS viewport could not be bound to the selected page");
  // Blink DOMSnapshot uses physical layout units. Page exposes both device-pixel
  // and CSS visual viewports; unlike cssLayoutViewport their widths retain fractions.
  // Derive this conversion per read instead of assuming a device pixel ratio.
  const physicalViewport = metrics.visualViewport;
  const cssPerLayoutUnit = viewport.clientWidth / physicalViewport?.clientWidth;
  const verticalScale = viewport.clientHeight / physicalViewport?.clientHeight;
  if (!Number.isFinite(cssPerLayoutUnit) || cssPerLayoutUnit <= 0 || !Number.isFinite(verticalScale)
    || verticalScale <= 0 || Math.abs(verticalScale / cssPerLayoutUnit - 1) > 0.01)
    throw new ActionableError("Chrome layout-to-CSS conversion is unavailable or changing");
  const nodes = doc.nodes, layout = doc.layout;
  if (!Array.isArray(nodes?.backendNodeId) || !Array.isArray(nodes?.parentIndex) || !Array.isArray(layout?.nodeIndex))
    throw new ActionableError("Chrome DOM layout is unavailable");
  const count = nodes.backendNodeId.length;
  if (count > 100000 || layout.nodeIndex.length > 100000 || ax.nodes.length > 100000)
    throw new ActionableError("Chrome document exceeded the read limit");
  const rare = (data: any) => new Map<number, number>((data?.index || []).map((index: number, i: number) => [index, data.value?.[i]]));
  const inputs = rare(nodes.inputValue), textValues = rare(nodes.textValue);
  const checked = new Set(nodes.inputChecked?.index || []), clickable = new Set(nodes.isClickable?.index || []);
  const layouts = new Map<number, number>(layout.nodeIndex.map((index: number, i: number) => [index, i]));
  const accessible = new Map<number, any>(ax.nodes.filter((n: any) => !n.ignored && Number.isInteger(n.backendDOMNodeId)).map((n: any) => [n.backendDOMNodeId, n]));
  const attrs: Array<Record<string, string>> = [], passwords: boolean[] = [], transparent: boolean[] = [];
  let fieldsTruncated = false;
  const clip = (value: unknown, max = 500) => {
    const text = String(value ?? ""); if (text.length > max) fieldsTruncated = true; return text.slice(0, max);
  };
  // Parent precedes child in DOMSnapshot. Fail rather than misclassifying an unknown hierarchy.
  for (let i = 0; i < count; i++) {
    const parent = nodes.parentIndex[i];
    if (!Number.isInteger(parent) || parent >= i || parent < -1) throw new ActionableError("Chrome DOM hierarchy is invalid");
    const pairs = nodes.attributes?.[i] || [];
    const attributes: Record<string, string> = Object.create(null);
    for (let j = 0; j < pairs.length; j += 2) attributes[str(pairs[j])] = str(pairs[j + 1]);
    attrs.push(attributes);
    const styles = layout.styles?.[layouts.get(i) ?? -1] || [];
    passwords[i] = !!passwords[parent] || attributes.type?.toLowerCase() === "password"
      || (!!str(styles[2]) && str(styles[2]) !== "none");
    transparent[i] = !!transparent[parent] || str(styles[1]) === "0";
  }
  const elements: any[] = [], chunks: string[] = [];
  let textLength = 0, textTruncated = false, eligible = 0;
  for (let i = 0; i < count; i++) {
    const at = layouts.get(i);
    if (at === undefined || transparent[i]) continue;
    const visibility = str(layout.styles?.[at]?.[0]);
    if (visibility === "hidden" || visibility === "collapse") continue;
    const bounds = layout.bounds?.[at];
    if (!Array.isArray(bounds) || bounds.length !== 4 || !bounds.every(Number.isFinite)) continue;
    const [x, y, width, height] = bounds.map(value => value * cssPerLayoutUnit);
    if (width <= 0 || height <= 0 || x + width <= viewport.pageX || y + height <= viewport.pageY
      || x >= viewport.pageX + viewport.clientWidth || y >= viewport.pageY + viewport.clientHeight) continue;
    const password = passwords[i], tag = str(nodes.nodeName?.[i]).toLowerCase(), a = attrs[i], node = accessible.get(nodes.backendNodeId[i]);
    if (!password && nodes.nodeType?.[i] === 3) {
      const text = str(layout.text?.[at]).trim();
      if (text) {
        const available = Math.max(0, limits.maxChars - textLength - (chunks.length ? 1 : 0));
        if (text.length > available) textTruncated = true;
        if (available) { const part = text.slice(0, available); chunks.push(part); textLength += part.length + (chunks.length > 1 ? 1 : 0); }
      }
    }
    if (nodes.nodeType?.[i] !== 1 || ["html", "body", "script", "style"].includes(tag)) continue;
    const role = node?.role?.value ?? null;
    const properties = new Map<string, any>((node?.properties || []).map((p: any) => [p.name, p.value?.value]));
    const nativeControl = ["input", "textarea", "button", "select", "option"].includes(tag);
    if (!node?.name?.value && !nativeControl && !clickable.has(i) && !["canvas", "iframe"].includes(tag) && !a.id) continue;
    eligible++;
    if (elements.length >= limits.maxElements) continue;
    const states: Record<string, unknown> = {};
    for (const key of ["disabled", "focused", "focusable", "checked", "selected", "expanded", "pressed", "readonly", "required", "editable", "valuemin", "valuemax", "level"]) {
      // CDP tristate values use the strings true/false/mixed. Normalize only
      // their boolean representations; preserve mixed and other tokens.
      const raw = properties.get(key);
      const value = ["checked", "pressed"].includes(key) && ["true", "false"].includes(raw) ? raw === "true" : raw;
      if (["string", "number", "boolean"].includes(typeof value)) states[key] = typeof value === "string" ? clip(value, 80) : value;
    }
    if (tag === "input" && ["checkbox", "radio"].includes(a.type?.toLowerCase())) states.checked ??= checked.has(i);
    const input = inputs.has(i) ? str(inputs.get(i)!) : textValues.has(i) ? str(textValues.get(i)!) : node?.value?.value;
    elements.push({ backendNodeId: nodes.backendNodeId[i], tag, identifier: a.id ? clip(a.id, 200) : null,
      role: typeof role === "string" ? clip(role, 80) : null, name: password ? "[password control]" : node?.name ? clip(node.name.value) : null,
      value: password ? "[redacted]" : input === undefined ? null : clip(input), password,
      clickable: clickable.has(i), states,
      bounds: { x, y, width, height },
      viewportBounds: { x: x - viewport.pageX, y: y - viewport.pageY, width, height },
      ...(tag === "canvas" ? { limitation: "Pixels inside this canvas are not described" } : {}),
      ...(tag === "iframe" ? { limitation: "Frame content omitted" } : {}),
    });
  }
  return { title: clip(str(doc.title), 500), text: chunks.join("\n"), elements,
    coordinates: { unit: "CSS pixels", boundsOrigin: "document", viewportBoundsOrigin: "visual viewport",
      conversion: { derived: true, cssPixelsPerLayoutUnit: cssPerLayoutUnit, source: "Page.getLayoutMetrics cssVisualViewport.clientWidth / visualViewport.clientWidth" },
      note: "These are web layout coordinates, not Android screen pixels; browser chrome, zoom and occlusion are not resolved." },
    viewport: { pageX: viewport.pageX, pageY: viewport.pageY, width: viewport.clientWidth, height: viewport.clientHeight, scale: viewport.scale ?? null },
    truncated: { text: textTruncated, elements: eligible > elements.length, fields: fieldsTruncated },
    omissions: { childDocuments: snapshot.documents.length - 1, passwordValues: "redacted", hiddenAndOffscreenLayout: true },
  };
}
