import type { DetectContext } from "../core/detection.js";

export type RuntimeDetectionStrategy = "tutti-managed" | "standalone";

export function selectRuntimeDetectionStrategy(
  context: DetectContext | undefined,
): RuntimeDetectionStrategy {
  return context?.managedAgentInvocation ? "tutti-managed" : "standalone";
}
