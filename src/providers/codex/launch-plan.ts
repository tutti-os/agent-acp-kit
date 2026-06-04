import type { AgentRunParams, ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { clampCodexReasoning } from "./fallback-models.js";

export function buildCodexLaunchPlan(
  params: AgentRunParams<"local-agent", "codex">,
  executablePath = "codex",
): ProviderLaunchPlan {
  const args = [
    "exec",
    "--json",
    "--skip-git-repo-check",
    "--disable",
    "plugins",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
  ];
  args.push("-C", params.cwd);

  if (params.model && params.model !== "default") {
    args.push("--model", params.model);
  }

  const reasoning = clampCodexReasoning(params.model, params.reasoning);
  if (reasoning) {
    args.push("-c", `model_reasoning_effort="${reasoning}"`);
  }

  for (const dir of params.extraAllowedDirs ?? []) {
    if (dir) {
      args.push("--add-dir", dir);
    }
  }

  return {
    args,
    command: executablePath,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
    prompt: params.prompt,
    promptInput: "stdin",
  };
}
