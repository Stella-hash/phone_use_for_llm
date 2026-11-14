import { PolicyError } from "./security.js";
import type { Decision } from "./delegation-model.js";

const reject = (code: string): never => { throw new PolicyError(code); };
const protectedControl = (e: any) => /Switch|CheckBox|RadioButton|CheckedTextView|SeekBar|NumberPicker|Spinner/i.test(e.type ?? "")
  || /switch|checkbox|radio_button|seekbar|toggle/i.test(e.identifier ?? "");
const sensitive = /\b(trade|buy|sell|order|deposit|withdraw|transfer|subscribe|purchase|login|password|portfolio|account|settings|download|accept|agree|post|send)\b|sign in|log in|add symbol|create screener|交易|买入|卖出|下单|转账|入金|出金|开户|订阅|购买|登录|密码|持仓|账户|设置|下载|同意|发布|发送/i;
function rebind(target: any, elements: any[]) {
  if (!target?.rect || target.password || target.editable) return reject("DELEGATION_TARGET_INVALID");
  const matches = elements.filter(e => e.type === target.type && (e.identifier ?? "") === (target.identifier ?? "")
    && (e.text ?? "") === (target.text ?? "") && (e.label ?? "") === (target.label ?? ""));
  if (matches.length !== 1) return reject("DELEGATION_TARGET_AMBIGUOUS");
  const e = matches[0];
  if (["x", "y", "width", "height"].some(k => !Number.isFinite(e.rect?.[k]) || Math.abs(e.rect[k] - target.rect[k]) > 4)) return reject("DELEGATION_TARGET_MOVED");
  const y = e.rect.y + e.rect.height / 2;
  if (e.rect.width <= 0 || e.rect.height <= 0 || protectedControl(e)
    || elements.some(v => protectedControl(v) && y >= v.rect.y - 8 && y <= v.rect.y + v.rect.height + 8)) return reject("DELEGATION_VALUE_CONTROL_BLOCKED");
  return e;
}
export function navigation(d: Decision, frame: any, fresh: any[], browser: boolean) {
  if (fresh.some(e => e.password)) return reject("DELEGATION_PASSWORD_BOUNDARY");
  if (d.action === "search") {
    const fields = fresh.filter(e => e.focused && e.editable && /search|搜索|查找/i.test([e.identifier, e.label].join(" ")));
    if (browser || fields.length !== 1 || !d.value?.trim() || d.value.length > 80) return reject("DELEGATION_SEARCH_FIELD_UNAVAILABLE");
    return { name: "android_set_text", args: { text: d.value } };
  }
  if (d.action === "scroll") {
    if (!["up", "down", "left", "right"].includes(d.value ?? "")) return reject("DELEGATION_SCROLL_DIRECTION_INVALID");
    if (d.targetIndex === null) {
      // The existing tool derives native screen coordinates. With no bound
      // target, refuse a screen containing value controls or focused editors.
      if (!["up", "down"].includes(d.value!) || fresh.some(e => protectedControl(e) || (e.editable && e.focused))) return reject("DELEGATION_SCROLL_BOUNDARY");
      return { name: "android_swipe", args: { direction: d.value, duration: 450 } };
    }
    const e = rebind(frame.elements[d.targetIndex], fresh), r = e.rect;
    const horizontal = ["left", "right"].includes(d.value!), distance = Math.floor((horizontal ? r.width : r.height) * .35);
    if (distance < 30) return reject("DELEGATION_SCROLL_TARGET_TOO_SMALL");
    return { name: "android_swipe", args: { direction: d.value, x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2), distance, duration: 450 } };
  }
  if (d.action !== "tap" || d.targetIndex === null) return reject("DELEGATION_NAVIGATION_UNSUPPORTED");
  const e = rebind(frame.elements[d.targetIndex], fresh);
  if (browser && e.webView === undefined && frame.elements[d.targetIndex].webView === undefined) return reject("DELEGATION_WEB_TARGET_REQUIRED");
  if (sensitive.test([e.text, e.label, e.identifier].filter(Boolean).join(" "))) return reject("DELEGATION_SENSITIVE_CONTROL_BLOCKED");
  const args: any = { className: e.type, ...(e.identifier ? { resourceId: e.identifier } : {}),
    ...(e.text ? { text: e.text } : e.label ? { contentDesc: e.label } : {}) };
  if (!args.resourceId && !args.text && !args.contentDesc) return reject("DELEGATION_SELECTOR_UNAVAILABLE");
  const matches = fresh.filter(v => v.type === args.className && (!args.resourceId || v.identifier === args.resourceId)
    && (!args.text || v.text === args.text) && (!args.contentDesc || (v.label ?? "").toLowerCase().includes(args.contentDesc.toLowerCase())));
  if (matches.length !== 1) return reject("DELEGATION_SELECTOR_AMBIGUOUS");
  return { name: "android_tap_element", args };
}
