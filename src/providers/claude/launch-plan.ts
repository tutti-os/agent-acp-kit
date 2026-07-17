import type { AgentRunParams, ProviderLaunchPlan } from "../../core/provider-plugin.js";

function normalizeClaudeModel(model: string | undefined) {
  if (model?.startsWith("claude:")) return model.slice("claude:".length);
  return model;
}

function resolveProviderResumeId(
  resume: AgentRunParams<"local-agent", "claude-code">["resume"],
) {
  if (!resume || resume.mode === "fresh") return undefined;
  return (resume.providerSessionId ?? resume.resumeToken)?.trim() || undefined;
}

function applyClaudePermissionArgs(
  args: string[],
  permission: AgentRunParams<"local-agent", "claude-code">["permission"],
) {
  switch (permission?.semantic) {
    case "accept-edits":
      args.push("--permission-mode", "acceptEdits");
      break;
    case "locked-down":
      args.push("--permission-mode", "dontAsk");
      break;
    case "auto":
      args.push("--permission-mode", "auto");
      break;
    case "full-access":
      args.push("--dangerously-skip-permissions");
      break;
    default:
      break;
  }
}

export function buildClaudeLaunchPlan(
  params: AgentRunParams<"local-agent", "claude-code">,
  executablePath = "claude",
  options?: { mcpConfigPath?: string },
): ProviderLaunchPlan {
  const args = ["-p", "--output-format", "stream-json", "--verbose"];
  const model = normalizeClaudeModel(params.model);
  if (model && model !== "default") {
    args.push("--model", model);
  }
  const resumeId = resolveProviderResumeId(params.resume);
  if (resumeId) {
    args.push("--resume", resumeId);
  }
  if (options?.mcpConfigPath) {
    args.push("--mcp-config", options.mcpConfigPath, "--strict-mcp-config");
  }
  for (const dir of params.extraAllowedDirs ?? []) {
    if (dir) args.push("--add-dir", dir);
  }
  applyClaudePermissionArgs(args, params.permission);
  const plan: ProviderLaunchPlan = {
    args,
    command: executablePath,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
    prompt: params.prompt,
    promptInput: "stdin",
    ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
    ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
  };
  return plan;
}
