import { z } from "zod";
import { performance } from "node:perf_hooks";
import { remainingTime, withDeadline } from "./deadline.js";
import type { VisualDecision, VisualFrame } from "./decisions.js";

const point = z.object({ x: z.number().finite().nonnegative(), y: z.number().finite().nonnegative() }).strict();
export const dragPilotSchema = z.object({
  target: z.string().trim().min(1).max(1200), goal: z.string().trim().min(1).max(1200),
  expectedPackage: z.string().regex(/^[a-zA-Z0-9_.]+$/).max(200),
  imageSize: z.object({ width: z.number().int().positive().max(32768), height: z.number().int().positive().max(32768) }).strict(),
  steps: z.array(z.object({ from: point, to: point, durationMs: z.number().int().min(100).max(1500) }).strict()).min(1).max(2),
  timeoutMs: z.number().int().min(1000).max(25000).default(20000),
}).strict();
export type DragPilotPlan = z.infer<typeof dragPilotSchema>;
type MappedDrag = { points: { x: number; y: number }[]; durationMs: number; expectedPackage: string };
export type PilotPorts = {
  observe: () => Promise<VisualFrame>;
  judge: (reference: VisualFrame, current: VisualFrame, target: string, goal: string) => Promise<VisualDecision>;
  // Production use needs a single serialized owner, current-frame and app guards at dispatch.
  // The fixture adapter checks its exact page and sends only these predeclared points.
  drag: (action: MappedDrag, observationId: string) => Promise<{ pointerReleased: boolean }>;
};
export function mapImagePoint(p: { x: number; y: number }, displayed: DragPilotPlan["imageSize"], frame: Pick<VisualFrame, "width" | "height">) {
  if (p.x < 0 || p.y < 0 || p.x >= displayed.width || p.y >= displayed.height
    || Math.abs((displayed.width / displayed.height) / (frame.width / frame.height) - 1) > 0.01)
    throw new Error("Point outside the displayed image, or its aspect ratio changed; cropped/rotated references are unsupported.");
  return { x: Math.min(frame.width - 1, Math.round(p.x * frame.width / displayed.width)),
    y: Math.min(frame.height - 1, Math.round(p.y * frame.height / displayed.height)) };
}

export async function runDragPilot(input: unknown, ports: PilotPorts) {
  const plan = dragPilotSchema.parse(input);
  // Reject invalid plans before observation or a paid request.
  for (const step of plan.steps) for (const p of [step.from, step.to]) mapImagePoint(p, plan.imageSize, plan.imageSize);
  const started = performance.now();
  const observations: { id: string; capturedAt: string; pixelsChanged: boolean | null; decision?: VisualDecision }[] = [];
  const actions: { observationId: string; action: MappedDrag; acknowledged: boolean }[] = [];
  let current: VisualFrame | undefined, reference: VisualFrame | undefined;
  let phase = "observe", confirming = false;
  const finish = (status: string) => ({ status, evidence: "bounded pilot; visual conclusions are model inference",
    elapsedMs: Math.round(performance.now() - started), actions, observations,
    finalFrame: current ? { id: current.id, width: current.width, height: current.height, capturedAt: current.capturedAt } : null });
  return withDeadline(plan.timeoutMs, async () => {
    try {
      // Initial observation + at most two drags + one separate success confirmation.
      for (let sample = 0; sample < plan.steps.length + 2; sample++) {
        phase = "observe"; remainingTime();
        const previous = current;
        current = await ports.observe(); remainingTime();
        observations.push({ id: current.id, capturedAt: current.capturedAt, pixelsChanged: previous ? current.id !== previous.id : null });
        reference ||= current;
        if (confirming && (!Number.isFinite(Date.parse(current.capturedAt))
          || Date.parse(current.capturedAt) <= Date.parse(previous!.capturedAt))) return finish("confirmation_not_fresh");
        if (current.packageName !== plan.expectedPackage) return finish("app_changed");
        if (current.width !== reference.width || current.height !== reference.height) return finish("geometry_changed");
        mapImagePoint(plan.steps[0].from, plan.imageSize, current);
        phase = "judge";
        const decision = await ports.judge(reference, current, plan.target, plan.goal);
        observations.at(-1)!.decision = decision; remainingTime();
        if (decision.status === "scene_changed") return finish("scene_changed");
        if (decision.status === "unknown") return finish("judgment_unknown");
        if (decision.status === "achieved") {
          if (confirming) return finish("goal_observed_twice");
          confirming = true;
          phase = "wait";
          const delay = Math.min(250, remainingTime());
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        if (confirming) return finish("success_signal_unstable");
        if (actions.length === plan.steps.length) return finish("step_limit");
        const step = plan.steps[actions.length];
        const action = { points: [step.from, step.to].map(p => mapImagePoint(p, plan.imageSize, current!)),
          durationMs: step.durationMs, expectedPackage: plan.expectedPackage };
        // Reserve time for observation; never start another action at an exhausted boundary.
        if (remainingTime() < step.durationMs + 7000) return finish("insufficient_time_for_action_and_observation");
        phase = "drag";
        actions.push({ observationId: current.id, action, acknowledged: false });
        const acknowledgement = await ports.drag(action, current.id);
        if (acknowledgement.pointerReleased !== true) return finish("action_uncertain");
        actions.at(-1)!.acknowledged = true;
      }
      return finish("sample_limit");
    } catch {
      // Once attempted, a failed/uncertain action is never replayed. Preserve its evidence.
      return finish(phase === "drag" ? "action_uncertain" : `${phase}_failed_or_deadline`);
    }
  });
}
