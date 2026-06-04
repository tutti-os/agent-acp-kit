import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCodexProvider } from "../../src/providers/codex/index.js";
import { buildCodexLaunchPlan } from "../../src/providers/codex/launch-plan.js";

describe("buildCodexLaunchPlan", () => {
  it("uses trusted local execution, stdin delivery, cwd pinning, and repeatable add-dir flags", () => {
    expect(
      buildCodexLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "draw a poster",
        extraAllowedDirs: ["/repo/skills", "", "/tmp/codex/generated_images"],
      }),
    ).toEqual({
      command: "codex",
      cwd: "/tmp/project",
      env: undefined,
      prompt: "draw a poster",
      promptInput: "stdin",
      args: [
        "exec",
        "--json",
        "--skip-git-repo-check",
        "--disable",
        "plugins",
        "--ignore-rules",
        "--dangerously-bypass-approvals-and-sandbox",
        "-C",
        "/tmp/project",
        "--add-dir",
        "/repo/skills",
        "--add-dir",
        "/tmp/codex/generated_images",
      ],
    });
  });

  it("clamps reasoning for GPT-5.4+", () => {
    expect(
      buildCodexLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "ship it",
        model: "gpt-5.4",
        reasoning: "minimal",
      }).args,
    ).toEqual([
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--disable",
      "plugins",
      "--ignore-rules",
      "--dangerously-bypass-approvals-and-sandbox",
      "-C",
      "/tmp/project",
      "--model",
      "gpt-5.4",
      "-c",
      'model_reasoning_effort="low"',
    ]);
  });

  it("prepends system prompts to the stdin prompt for provider runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "codex-system-prompt-plan-"));
    try {
      const plan = await createCodexProvider().buildLaunchPlan({
        runId: "run-1",
        cwd,
        prompt: "draw a poster",
        systemPrompt: "Host system rules",
      });

      expect(plan.prompt).toMatch(/^Host system rules\n\n/);
      expect(plan.prompt).toContain("Current request:\n\ndraw a poster");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
