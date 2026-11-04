/** Execution acknowledgement is distinct from observing the app's intended outcome. */
export function activityReceipt(event: any) {
  if (!event) throw new Error("Activity record not found");
  return {
    eventId: event.id, requestId: event.requestId ?? null, tool: event.tool,
    requestBinding: event.requestBinding ?? null,
    callOutcome: event.outcome,
    execution: event.execution ?? "unknown_legacy",
    executionRecordedAt: event.executionRecordedAt ?? null,
    observation: event.observation ? "recorded" : event.outcome === "running" ? "pending" : "unavailable",
    screenshotAvailable: !!event.observation?.screenshot && !event.callerClaim?.private,
  };
}
