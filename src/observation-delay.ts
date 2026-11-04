import { performance } from "node:perf_hooks";
import { setTimeout } from "node:timers/promises";
import { DeadlineExceeded, remainingTime } from "./deadline.js";

export interface ObservationDelay {
  requestedMs: number;
  elapsedMs: number;
  status: "elapsed" | "budget_limited" | "action_failed";
}

/** Delay one final observation, reserving its existing 10-second budget. No completion inference. */
export async function delayObservation(requestedMs: number): Promise<ObservationDelay> {
  if (!Number.isInteger(requestedMs) || requestedMs < 0 || requestedMs > 5000)
    throw new Error("observeAfterMs must be an integer between 0 and 5000");
  let available = 0;
  try { available = Math.max(0, remainingTime() - 10000); }
  catch (error) { if (!(error instanceof DeadlineExceeded)) throw error; }
  const delay = Math.min(requestedMs, available);
  const start = performance.now();
  if (delay > 0) await setTimeout(delay);
  return { requestedMs, elapsedMs: Math.round(performance.now() - start),
    status: delay === requestedMs ? "elapsed" : "budget_limited" };
}
