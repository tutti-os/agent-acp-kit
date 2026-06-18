import type { AgentDetection } from "./provider-plugin.js";
import type { ManagedAgentInvocation } from "./managed-invocation.js";

export type DetectContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  managedAgentInvocation?: ManagedAgentInvocation;
  now?: () => number;
  redactionSecrets?: string[];
};

export type DetectionResult = AgentDetection;
