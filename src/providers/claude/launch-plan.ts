import type { AgentRunParams, ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { applyManagedAgentInvocationToLaunchPlan } from "../../core/managed-invocation.js";

function normalizeClaudeModel(model: string | undefined) {
  if (model?.startsWith("claude:")) return model.slice("claude:".length);
  return model;
}

function resolveProviderResumeId(
  resume: AgentRunParams<"local-agent", "claude">["resume"],
) {
  if (!resume || resume.mode === "fresh") return undefined;
  return (resume.providerSessionId ?? resume.resumeToken)?.trim() || undefined;
}

export function buildClaudeLaunchPlan(
  params: AgentRunParams<"local-agent", "claude">,
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
  args.push("--permission-mode", "bypassPermissions");
  const plan: ProviderLaunchPlan = {
    args,
    command: executablePath,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
    prompt: params.prompt,
    promptInput: "stdin",
  };
  return applyManagedAgentInvocationToLaunchPlan(
    "claude",
    plan,
    params.managedAgentInvocation,
  );
}
