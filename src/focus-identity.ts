// Schema paths: AOSP android14-release, core/proto/android/server/windowmanagerservice.proto.
// Read only typed focus/display identity. Never search title bytes for dump syntax.
// This is a bounded reader for those paths, not a general protobuf implementation.
type Field = { wire: number; value: bigint | Buffer };
type Message = Map<number, Field[]>;
export type FocusIdentity = { hash: number; userId: number; displayId: 0; title: string };
const maximum = 4 * 1024 * 1024;
const invalid = (): never => { throw new Error("FOCUS_IDENTITY_UNAVAILABLE"); };

function message(data: Buffer): Message {
  if (!data.length || data.length > maximum) invalid();
  let offset = 0, count = 0;
  const varint = () => {
    let result = 0n;
    for (let i = 0; i < 10; i++) {
      if (offset >= data.length) invalid();
      const byte = data[offset++];
      if (i === 9 && byte > 1) invalid();
      result |= BigInt(byte & 127) << BigInt(i * 7);
      if (!(byte & 128)) return result;
    }
    return invalid();
  };
  const result: Message = new Map();
  while (offset < data.length) {
    if (++count > 4096) invalid();
    const tag = varint();
    if (tag > 0xffffffffn || tag < 8n) invalid();
    const field = Number(tag >> 3n), wire = Number(tag & 7n);
    let value: bigint | Buffer;
    if (wire === 0) value = varint();
    else if (wire === 1 || wire === 2 || wire === 5) {
      const size = wire === 2 ? varint() : BigInt(wire === 1 ? 8 : 4);
      if (size > BigInt(data.length - offset)) invalid();
      value = data.subarray(offset, offset + Number(size)); offset += Number(size);
    } else return invalid(); // Groups are not part of this schema.
    const values = result.get(field) ?? [];
    values.push({ wire, value }); result.set(field, values);
  }
  return result;
}
function single(value: Message, field: number, wire: number, optional = false): Field | undefined {
  const entries = value.get(field) ?? [];
  if (entries.length === 0 && optional) return undefined;
  if (entries.length !== 1 || entries[0].wire !== wire) invalid();
  return entries[0];
}
function child(value: Message, field: number): Message {
  return message(single(value, field, 2)!.value as Buffer);
}
function number(value: Message, field: number, optional = false): number {
  const found = single(value, field, 0, optional);
  // Android ProtoOutputStream omits zero-valued integers; the schema default is 0.
  const scalar = found ? found.value as bigint : 0n;
  if (scalar > 0x7fffffffn) invalid();
  return Number(scalar);
}
function identifier(value: Message): Omit<FocusIdentity, "displayId"> {
  const hash = number(value, 1), userId = number(value, 2, true);
  const bytes = single(value, 3, 2)!.value as Buffer;
  if (!hash || bytes.length < 1 || bytes.length > 1024) invalid();
  const title = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(title)) invalid();
  return { hash, userId, title };
}
const equal = (a: Omit<FocusIdentity, "displayId">, b: Omit<FocusIdentity, "displayId">) =>
  a.hash === b.hash && a.userId === b.userId && a.title === b.title;

export function parseFocusIdentity(data: Buffer): FocusIdentity | null {
  try {
    const snapshot = message(data), root = child(snapshot, 2);
    // Do not combine deprecated and current display trees or choose one of several displays.
    if (root.has(2) || root.has(4)) invalid();
    const container = child(root, 1), displays = container.get(5) ?? [];
    if (displays.length !== 1 || displays[0].wire !== 2) invalid();
    const entry = message(displays[0].value as Buffer);
    for (const kind of [2, 4, 5, 6, 7, 8, 9]) if (entry.has(kind)) invalid();
    const display = child(entry, 3);
    if (number(snapshot, 9, true) !== 0 || number(display, 2, true) !== 0
      || number(display, 26) !== 1 || number(display, 36, true) !== 0) invalid();
    const focused = identifier(child(snapshot, 3)), window = child(display, 30);
    if (window.has(2) || number(window, 3, true) !== 0) invalid();
    const displayFocus = identifier(child(child(window, 1), 6));
    if (!equal(focused, displayFocus)) invalid();
    return { ...focused, displayId: 0 };
  } catch { return null; }
}

export function sameFocus(a: FocusIdentity, b: FocusIdentity | null): boolean {
  return !!b && a.displayId === b.displayId && equal(a, b);
}

export type WindowOwner = { uid: number; packageName: string };
const packagePattern = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/;
export function parseWindowOwner(dump: string, focus: FocusIdentity): WindowOwner | null {
  if (!dump || Buffer.byteLength(dump) > 256 * 1024) return null;
  const text = dump.replace(/\r\n/g, "\n"), lines = text.split("\n");
  // The query is the numeric WindowState identity, not a title/name filter.
  // Its header and first two metadata lines precede all free-form window attributes.
  if (lines[0] !== "WINDOW MANAGER WINDOWS (dumpsys window windows)"
    || lines[1] !== `  Window #0 Window{${focus.hash.toString(16)} u${focus.userId} ${focus.title}}:`
    || (text.match(/^\s*Window #/gm) ?? []).length !== 1
    || (text.match(/^\s*mDisplayId=/gm) ?? []).length !== 1
    || (text.match(/^\s*mOwnerUid=/gm) ?? []).length !== 1
    || text.includes("WINDOW MANAGER LAST ANR") || text.includes("\r")) return null;
  const display = lines[2]?.match(/^    mDisplayId=(0|[1-9]\d{0,9})(?: [^\r\n]*)?$/);
  const owner = lines[3]?.match(/^    mOwnerUid=(0|[1-9]\d{0,9}) showForAllUsers=(?:true|false) package=([^\s]+) appop=[^\s]+$/);
  if (!display || Number(display[1]) !== focus.displayId || !owner) return null;
  const uid = Number(owner[1]), packageName = owner[2];
  if (uid > 0x7fffffff || Math.floor(uid / 100000) !== focus.userId
    || packageName.length > 200 || !packagePattern.test(packageName)) return null;
  // A component-looking title may contradict identity, but can never establish it.
  const hint = focus.title.match(/^([A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+)\//)?.[1];
  if (hint && hint !== packageName) return null;
  return { uid, packageName };
}

export function uniqueOwnerPackage(dump: string, owner: WindowOwner): boolean {
  if (!dump || Buffer.byteLength(dump) > 32768) return false;
  const lines = dump.replace(/\r\n/g, "\n").trimEnd().split("\n");
  // A shared UID does not identify one package. Do not choose the allowlisted member.
  return lines.length === 1 && lines[0] === `package:${owner.packageName} uid:${owner.uid}`;
}
