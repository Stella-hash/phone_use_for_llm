/** Parse one bounded JSON document, rejecting ambiguous duplicate object keys. */
export function strictJson(text: string): any {
  if (Buffer.byteLength(text) > 65536) throw new Error("JSON size limit");
  const value = JSON.parse(text);
  const stack: { object: boolean; key: boolean; keys: Set<string> }[] = [];
  const tokens = text.matchAll(/"(?:[^"\\]|\\[\s\S])*"|[{}\[\],:]|[^{}\[\],:\s]+/g);
  for (const [token] of tokens) {
    const top = stack.at(-1);
    if (token === "{" || token === "[") {
      stack.push({ object: token === "{", key: token === "{", keys: new Set() });
      if (stack.length > 16) throw new Error("JSON depth limit");
    } else if (token === "}" || token === "]") stack.pop();
    else if (top && token === ",") top.key = top.object;
    else if (top && token === ":") top.key = false;
    else if (top?.object && top.key) {
      const key = JSON.parse(token);
      if (top.keys.has(key)) throw new Error("Duplicate JSON key");
      top.keys.add(key);
    }
  }
  return value;
}
