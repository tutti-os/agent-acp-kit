import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createClaudeProvider } from "../../src/providers/claude/index.js";
import { buildClaudeLaunchPlan } from "../../src/providers/claude/launch-plan.js";

describe("buildClaudeLaunchPlan", () => {
  it("advertises same-provider native resume support", () => {
    expect(createClaudeProvider().capabilities()).toMatchObject({
      nativeResume: true,
    });
  });

  it("builds a stream-json stdin launch plan with repeatable add-dir flags", () => {
    expect(
      buildClaudeLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "refine the poster",
        model: "sonnet",
        extraAllowedDirs: ["/repo/skills", "", "/repo/design-system"],
      }),
    ).toEqual({
      command: "claude",
      cwd: "/tmp/project",
      prompt: "refine the poster",
      promptInput: "stdin",
      args: [
        "-p",
        "--output-format",
        "stream-json",
        "--verbose",
        "--model",
        "sonnet",
        "--add-dir",
        "/repo/skills",
        "--add-dir",
        "/repo/design-system",
        "--permission-mode",
        "bypassPermissions",
      ],
    });
  });

  it("adds Claude Code --resume only when same-provider resume metadata exists", () => {
    expect(
      buildClaudeLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "continue",
        model: "claude:sonnet",
        resume: {
          mode: "provider",
          providerSessionId: "claude-session-1",
        },
      }).args,
    ).toEqual([
      "-p",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "sonnet",
      "--resume",
      "claude-session-1",
      "--permission-mode",
      "bypassPermissions",
    ]);
  });

  it("does not add Claude Code --resume for empty resume metadata", () => {
    expect(
      buildClaudeLaunchPlan({
        runId: "run-1",
        cwd: "/tmp/project",
        prompt: "continue",
        resume: {
          mode: "provider",
        },
      }).args,
    ).not.toContain("--resume");
  });

  it("passes MCP servers through a per-run Claude Code config file", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-mcp-plan-"));
    try {
      const plan = await createClaudeProvider().buildLaunchPlan({
        runId: "run-1",
        cwd,
        prompt: "generate a poster",
        mcpServers: [
          {
            name: "host-tools",
            type: "stdio",
            command: "node",
            args: ["/tmp/host-tools-mcp.js"],
            env: {
              HOST_TOOL_TOKEN: "secret-token",
            },
          },
        ],
      });

      const configIndex = plan.args.indexOf("--mcp-config");
      expect(configIndex).toBeGreaterThan(-1);
      const configPath = plan.args[configIndex + 1];
      expect(configPath).toContain(cwd);
      await expect(readFile(configPath, "utf8")).resolves.toBe(
        JSON.stringify({
          mcpServers: {
            "host-tools": {
              type: "stdio",
              command: "node",
              args: ["/tmp/host-tools-mcp.js"],
              env: {
                HOST_TOOL_TOKEN: "secret-token",
              },
            },
          },
        }),
      );
      expect(plan.redactionSecrets).toEqual(["secret-token"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("serializes HTTP MCP servers for Claude Code configs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-http-mcp-plan-"));
    try {
      const plan = await createClaudeProvider().buildLaunchPlan({
        runId: "run-1",
        cwd,
        prompt: "inspect",
        mcpServers: [
          {
            name: "remote",
            type: "http",
            url: "https://example.com/mcp",
            headers: {
              Authorization: "Bearer token",
            },
            env: [{ key: "EXTRA", value: "value" }],
          },
        ],
      });

      const configIndex = plan.args.indexOf("--mcp-config");
      const configPath = plan.args[configIndex + 1];
      await expect(readFile(configPath, "utf8")).resolves.toBe(
        JSON.stringify({
        mcpServers: {
            remote: {
              type: "http",
              url: "https://example.com/mcp",
              headers: {
                Authorization: "Bearer token",
              },
              env: {
                EXTRA: "value",
              },
            },
          },
        }),
      );
      expect(plan.redactionSecrets).toEqual(["value", "Bearer token"]);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("prepends system prompts to the stdin prompt for provider runs", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "claude-system-prompt-plan-"));
    try {
      const plan = await createClaudeProvider().buildLaunchPlan({
        runId: "run-1",
        cwd,
        prompt: "refine the poster",
        systemPrompt: "Host system rules",
      });

      expect(plan.prompt).toMatch(/^Host system rules\n\n/);
      expect(plan.prompt).toContain("Current request:\n\nrefine the poster");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  it("returns Claude session ids on done events for future provider resume", async () => {
    const adapter = createClaudeProvider().createAdapter();
    expect(adapter).toBeDefined();

    async function* stream() {
      yield { type: "system", subtype: "init", session_id: "claude-session-1" };
      yield { type: "done", status: "completed" };
    }

    const events = [];
    for await (const event of adapter!.parseEvents(stream())) {
      events.push(event);
    }

    expect(events).toContainEqual({
      type: "done",
      status: "completed",
      sessionId: "claude-session-1",
    });
  });
});
