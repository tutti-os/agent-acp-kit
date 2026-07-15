import type { AgentDetection } from "./provider-plugin.js";

export type DetectContext = {
  cwd?: string;
  env?: Record<string, string | undefined>;
  now?: () => number;
  refresh?: boolean;
  redactionSecrets?: string[];
};

export type DetectionResult = AgentDetection;
