import type { LocalAgentMcpServerConfig } from "./mcp.js";
import type { AgentPermissionSelection } from "./permissions.js";

export type LaunchPlan = {
  args: string[];
  command: string;
  cwd: string;
  env?: Record<string, string>;
  fallbackPlan?: LaunchPlan;
  prompt: string;
  promptInput: "stdin" | "argv";
  mcpServers?: LocalAgentMcpServerConfig[];
  model?: string;
  permission?: AgentPermissionSelection;
  redactionSecrets?: string[];
  resume?: {
    mode: "native" | "provider" | "fresh";
    providerSessionId?: string;
    resumeToken?: string;
  };
  runId?: string;
  transport?: TransportKind;
  timeoutMs?: number;
};

export type TransportKind = "jsonl" | "plain" | "acp-json-rpc";
