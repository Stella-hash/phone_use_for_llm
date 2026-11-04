import { AsyncLocalStorage } from "node:async_hooks";
import { performance } from "node:perf_hooks";

const deadlines = new AsyncLocalStorage<number>();

export class DeadlineExceeded extends Error {
  constructor() {
    super("Phone operation deadline exceeded; an attempted action may have completed. Inspect its activity record before retrying.");
    this.name = "DeadlineExceeded";
  }
}

/** Nested work shares the earlier deadline, including subprocesses and retries. */
export function withDeadline<T>(timeoutMs: number, run: () => T): T {
  return deadlines.run(Math.min(deadlines.getStore() ?? Infinity, performance.now() + timeoutMs), run);
}

export function remainingTime(capMs = 30000): number {
  const remaining = Math.min(capMs, (deadlines.getStore() ?? Infinity) - performance.now());
  if (remaining <= 0) throw new DeadlineExceeded();
  return Math.max(1, Math.ceil(remaining));
}
