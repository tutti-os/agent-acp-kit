import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createCodexProvider } from "../../src/providers/codex/index.js";
import { buildCodexLaunchPlan } from "../../src/providers/codex/launch-plan.js";

describe("buildCodexLaunchPlan", () => {
  it("advertises same-provider native resume support", () => {
    expect(createCodexProvider().capabilities()).toMatchObject({
      nativeResume: true,
    });
  });

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

  it("uses the Codex exec resume subcommand when same-provider resume metadata exists", () => {
    expect(
      buildCodexLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "continue",
        model: "gpt-5.4",
        reasoning: "high",
        extraAllowedDirs: ["/repo/skills"],
        resume: {
          mode: "provider",
          providerSessionId: "codex-session-1",
        },
      }),
    ).toEqual({
      command: "codex",
      cwd: "/tmp/project",
      env: undefined,
      prompt: "continue",
      promptInput: "stdin",
      args: [
        "exec",
        "resume",
        "--json",
        "--skip-git-repo-check",
        "--disable",
        "plugins",
        "--ignore-rules",
        "--dangerously-bypass-approvals-and-sandbox",
        "--model",
        "gpt-5.4",
        "-c",
        'model_reasoning_effort="high"',
        "codex-session-1",
        "-",
      ],
    });
  });

  it("falls back to fresh Codex exec when resume metadata is empty", () => {
    expect(
      buildCodexLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "continue",
        resume: {
          mode: "provider",
        },
      }).args,
    ).toContain("-C");
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

  it("preserves configured Codex model providers in the per-run CODEX_HOME", async () => {
    const sourceHome = await mkdtemp(join(tmpdir(), "codex-source-home-"));
    const cwd = await mkdtemp(join(tmpdir(), "codex-provider-plan-"));
    let runHome: string | undefined;

    try {
      await mkdir(join(sourceHome, "skills"), { recursive: true });
      await writeFile(
        join(sourceHome, "auth.json"),
        JSON.stringify({ OPENAI_API_KEY: "test-key" }),
        "utf8",
      );
      await writeFile(
        join(sourceHome, "config.toml"),
        [
          'model_provider = "OpenAI"',
          'model = "minimax-m2.5"',
          "",
          "[model_providers.OpenAI]",
          'name = "OpenAI"',
          'base_url = "https://llm-api.nextop.sh/v1"',
          'wire_api = "responses"',
          "",
          "[profiles.unrelated]",
          'model = "other"',
          "",
        ].join("\n"),
        "utf8",
      );

      const adapter = createCodexProvider().createAdapter();
      const plan = await adapter!.buildLaunchPlan({
        runId: "run-1",
        cwd,
        prompt: "draw a poster",
        model: "gpt-5.4",
        env: { CODEX_HOME: sourceHome },
        mcpServers: [
          {
            type: "stdio",
            name: "aimc",
            command: "node",
            args: ["server.js"],
            env: { AIMC_TOOL_TOKEN: "tool-token" },
          },
        ],
      });
      runHome = plan.env?.CODEX_HOME;

      expect(runHome).toBeTruthy();
      expect(runHome).not.toBe(sourceHome);

      const config = await readFile(join(runHome!, "config.toml"), "utf8");
      expect(config).toContain('model_provider = "OpenAI"');
      expect(config).toContain('model = "gpt-5.4"');
      expect(config).toContain("[model_providers.OpenAI]");
      expect(config).toContain('base_url = "https://llm-api.nextop.sh/v1"');
      expect(config).toContain("[mcp_servers.aimc]");
      expect(config.indexOf('model = "gpt-5.4"')).toBeLessThan(
        config.indexOf("[model_providers.OpenAI]"),
      );
      expect(config).not.toContain("[profiles.unrelated]");
    } finally {
      await rm(sourceHome, { recursive: true, force: true });
      await rm(cwd, { recursive: true, force: true });
      if (runHome) {
        await rm(runHome, { recursive: true, force: true });
      }
    }
  });

  it("returns Codex thread ids on done events for future provider resume", async () => {
    const adapter = createCodexProvider().createAdapter();
    expect(adapter).toBeDefined();

    async function* stream() {
      yield { type: "thread.started", thread: { id: "codex-thread-1" } };
      yield { type: "done", status: "completed" };
    }

    const events = [];
    for await (const event of adapter!.parseEvents(stream())) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "done",
      status: "completed",
      sessionId: "codex-thread-1",
    });
  });
});
