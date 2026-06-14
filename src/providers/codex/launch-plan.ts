import type { AgentRunParams, ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { clampCodexReasoning } from "./reasoning.js";

function resolveProviderResumeId(
  resume: AgentRunParams<"local-agent", "codex">["resume"],
) {
  if (!resume || resume.mode === "fresh") return undefined;
  return (resume.providerSessionId ?? resume.resumeToken)?.trim() || undefined;
}

export function buildCodexLaunchPlan(
  params: AgentRunParams<"local-agent", "codex">,
  executablePath = "codex",
): ProviderLaunchPlan {
  const resumeId = resolveProviderResumeId(params.resume);
  const args = resumeId ? ["exec", "resume", "--json"] : ["exec", "--json"];
  args.push(
    "--skip-git-repo-check",
    "--disable",
    "plugins",
    "--ignore-rules",
    "--dangerously-bypass-approvals-and-sandbox",
  );
  if (!resumeId) {
    args.push("-C", params.cwd);
  }

  if (params.model && params.model !== "default") {
    args.push("--model", params.model);
  }

  const reasoning = clampCodexReasoning(params.model, params.reasoning);
  if (reasoning) {
    args.push("-c", `model_reasoning_effort="${reasoning}"`);
  }

  if (!resumeId) {
    for (const dir of params.extraAllowedDirs ?? []) {
      if (dir) {
        args.push("--add-dir", dir);
      }
    }
  }

  if (resumeId) {
    args.push(resumeId, "-");
  }

  const plan: ProviderLaunchPlan = {
    args,
    command: executablePath,
    cwd: params.cwd,
    ...(params.env ? { env: params.env } : {}),
    prompt: params.prompt,
    promptInput: "stdin",
  };

  if (resumeId) {
    plan.fallbackPlan = buildCodexLaunchPlan(
      {
        ...params,
        resume: { mode: "fresh" },
      },
      executablePath,
    );
  }

  return plan;
}
