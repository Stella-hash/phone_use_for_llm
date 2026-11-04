/** Bound optional model responses while streaming, before JSON parsing. */
export async function readJsonResponse(response: Response, maxBytes = 131072): Promise<any> {
  if (!response.body || Number(response.headers.get("content-length") || 0) > maxBytes) throw new Error("Model response size limit");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.length;
      if (bytes > maxBytes) throw new Error("Model response size limit");
      chunks.push(value);
    }
  } finally { await reader.cancel(); }
  return JSON.parse(Buffer.concat(chunks).toString());
}
