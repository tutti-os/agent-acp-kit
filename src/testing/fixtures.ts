import type { AgentEvent } from "../core/events.js";

export const SAMPLE_AGENT_EVENTS: AgentEvent[] = [
  { type: "status", stage: "running" },
  { type: "text_delta", text: "hello" },
  { type: "done", reason: "completed", exitCode: 0 },
];
