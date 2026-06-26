import { describe, expect, it } from "vitest";

import {
  loadTuttiAgentSkillBundle,
  loadTuttiAgentSkillContext,
  parseTuttiAgentSkillBundle,
  resolveTuttiCliCommand,
  type TuttiCliJsonRunner,
} from "../../src/tutti/index.js";

describe("Tutti skill bundle helpers", () => {
  it("loads and validates the Tutti CLI skill bundle", async () => {
    const calls: Array<{
      args: string[];
      options: { cwd?: string; maxBuffer: number; timeoutMs: number };
    }> = [];
    const runTuttiCli: TuttiCliJsonRunner = async (args, options) => {
      calls.push({ args, options });
      return {
        schemaVersion: 1,
        provider: "codex",
        agentSessionId: "run-1",
        recommendedSystemPrompt: {
          format: "text/markdown",
          content: "Use Tutti skills.",
        },
        skills: [
          {
            skillId: "tutti/cli",
            slug: "tutti-cli",
            deliveryMode: "prompt-injection",
            content: "Use the Tutti CLI.",
          },
        ],
      };
    };

    const context = await loadTuttiAgentSkillContext({
      agentSessionId: "run-1",
      cwd: "/workspace",
      provider: "codex",
      runTuttiCli,
      timeoutMs: 123,
      maxBuffer: 456,
    });

    expect(calls).toEqual([
      {
        args: [
          "agent",
          "tutti-cli-skill-bundle",
          "--provider",
          "codex",
          "--agent-session-id",
          "run-1",
          "--json",
        ],
        options: { cwd: "/workspace", maxBuffer: 456, timeoutMs: 123 },
      },
    ]);
    expect(context.skills).toHaveLength(1);
    expect(context.skillManifest).toBe(context.skills);
    expect(context.recommendedSystemPrompt?.content).toBe("Use Tutti skills.");
  });

  it("returns an empty bundle when no command is configured", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        env: {},
        provider: "codex",
      }),
    ).resolves.toEqual({ skills: [] });
  });

  it("checks provider and session echo values", async () => {
    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        provider: "codex",
        runTuttiCli: async () => ({
          provider: "claude",
          agentSessionId: "expected-run",
          skills: [],
        }),
      }),
    ).rejects.toThrow(
      "Tutti skill bundle provider mismatch: expected codex, got claude",
    );

    await expect(
      loadTuttiAgentSkillBundle({
        agentSessionId: "expected-run",
        provider: "codex",
        runTuttiCli: async () => ({
          provider: "codex",
          agentSessionId: "other-run",
          skills: [],
        }),
      }),
    ).rejects.toThrow(
      "Tutti skill bundle session mismatch: expected expected-run, got other-run",
    );
  });

  it("parses skill bundle JSON strictly", () => {
    expect(
      parseTuttiAgentSkillBundle(
        JSON.stringify({
          skills: [
            {
              skillId: "tutti/cli",
              slug: "tutti-cli",
              deliveryMode: "materialized-files",
              materializedPath: ".local-agent/tutti-cli",
              content: "# Tutti CLI",
              files: [{ path: "notes.md", content: "notes" }],
            },
          ],
        }),
      ).skills,
    ).toHaveLength(1);

    expect(() => parseTuttiAgentSkillBundle({ skills: [{}] })).toThrow(
      "Tutti skill bundle contains an invalid skill record at index 0",
    );
    expect(() => parseTuttiAgentSkillBundle("not json")).toThrow(
      "Tutti skill bundle response is not valid JSON",
    );
  });

  it("resolves app-specific Tutti CLI env vars before the default", () => {
    expect(
      resolveTuttiCliCommand({
        env: {
          GROUP_CHAT_TUTTI_CLI: " /custom/tutti ",
          TUTTI_CLI: "/default/tutti",
        },
        envNames: ["GROUP_CHAT_TUTTI_CLI"],
      }),
    ).toBe("/custom/tutti");
    expect(resolveTuttiCliCommand({ env: { TUTTI_CLI: "/default/tutti" } }))
      .toBe("/default/tutti");
  });

});
