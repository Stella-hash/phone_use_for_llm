import { z } from "zod";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";

const id = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._:-]{7,127}$/);
const runId = z.string().regex(/^delegate-[a-f0-9]{24}$/);
const context = z.object({ private: z.boolean().optional() }).strict().optional();
const budgetFields = { modelCalls: z.number().int().min(1).max(30).default(12),
  seconds: z.number().int().min(1).max(600).default(180), totalTokens: z.number().int().min(256).max(200000).default(24000),
};
export const budgetSchema = z.object(budgetFields).strict().prefault({});
const intent = { goal: z.string().trim().min(1).max(2400), doneWhen: z.string().max(1600).default(""), budget: budgetSchema };
export const delegateSchemas = {
  android_delegate_start: z.object({ requestId: id, ...intent, context,
    app: z.string().regex(/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z0-9_]+)+$/).max(200).optional(), url: z.string().max(4096).optional(),
  }).strict(),
  android_delegate_status: z.object({ runId: runId.optional(), startRequestId: id.optional(), waitMs: z.number().int().min(0).max(10000).default(0) }).strict(),
  android_delegate_update: z.object({ runId, requestId: id, expectedVersion: z.number().int().positive(), ...intent,
    budget: z.object(budgetFields).strict().optional(), context }).strict(),
  android_delegate_stop: z.object({ runId, requestId: id, expectedVersion: z.number().int().positive() }).strict(),
};
const descriptions = {
  android_delegate_start: "Start an optional short delegation on an already awake/unlocked app or exact HTTPS URL. This host mutation may call the configured model and submit existing phone tools. It grants no input permission. One input owner; at most four model calls per intent, final call report-only. No automatic wake/launch. Requires owner opt-in, model egress consent and retained text evidence; context.private is unsupported. Use status for findings, update to revise, stop to take over.",
  android_delegate_status: "Read a delegation by runId or startRequestId without phone/model work or a new request ID. Remains reachable while the worker runs. Findings distinguish copied text from visual interpretation; images are historical and opened explicitly with android_activity_open. handoffReady is false until admitted input settles. A yielded finding is pending the main operator's review, not independently verified task completion.",
  android_delegate_update: "Revise the goal with expectedVersion. Supersedes older model decisions and starts a fresh observation. Cumulative model/time/token usage survives updates; the budget is a cumulative ceiling, not a new allowance. Does not change app/URL scope or grant input permission. Interrupted jobs never resume after restart.",
  android_delegate_stop: "Request takeover with expectedVersion; no phone input is sent. Invalidates old decisions and cancels the local model wait. An already admitted input cannot be undone; status reports handoffReady only after its bound receipt settles. Uncertain input is never replayed. Reachable even while delegation is disabled or its model is unavailable.",
};
export const delegationTools: Tool[] = Object.entries(delegateSchemas).map(([name, schema]) => {
  const inputSchema: any = z.toJSONSchema(schema, { io: "input" }); delete inputSchema.$schema;
  return { name, description: descriptions[name as keyof typeof descriptions], inputSchema,
    annotations: { readOnlyHint: name === "android_delegate_status", destructiveHint: name !== "android_delegate_status", openWorldHint: name !== "android_delegate_status" && name !== "android_delegate_stop" } };
});
export const delegationNames = new Set(Object.keys(delegateSchemas));
