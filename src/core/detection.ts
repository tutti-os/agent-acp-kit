import type { AgentDetection } from "./provider-plugin.js";

export type DetectContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
};

export type DetectionResult = AgentDetection;
