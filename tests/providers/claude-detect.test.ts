import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { detectClaude } from "../../src/providers/claude/detect.js";

const claudeSdk = vi.hoisted(() => ({
  query: vi.fn(),
}));

vi.mock("@anthropic-ai/claude-agent-sdk", () => ({
  query: claudeSdk.query,
}));

describe("detectClaude", () => {
  const tempDirs: string[] = [];

  beforeEach(() => {
    claudeSdk.query.mockReset();
    claudeSdk.query.mockImplementation(() => {
      throw new Error("Claude SDK unavailable in test.");
    });
  });

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reports unsupported when Claude Code and fallbacks are not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-missing-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-empty-"));
    tempDirs.push(dir, configDir);

    const detection = await detectClaude({
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection).toMatchObject({
      authState: "missing",
      executablePath: "claude",
      supported: false,
      version: "not-installed",
    });
    expect(detection.unsupportedReason).toContain("Executable not found");
    expect(detection.models.map((model) => model.id)).toEqual(["default"]);
  });

  it("falls back to openclaude and reports config roots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-detect-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-empty-"));
    tempDirs.push(dir, configDir);
    const openClaude = join(dir, "openclaude");
    writeFileSync(
      openClaude,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"openclaude 0.9.0\"; exit 0; fi\nexit 1\n",
    );
    chmodSync(openClaude, 0o755);

    const detection = await detectClaude({
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection).toMatchObject({
      executablePath: openClaude,
      version: "openclaude 0.9.0",
      configDir,
      skillsDir: join(configDir, "skills"),
      supported: true,
    });
    expect(detection.models.map((model) => model.id)).toEqual([
      "default",
    ]);
  });

  it("uses Claude SDK supportedModels as the dynamic model source", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "agent-acp-kit-claude-sdk-models-"),
    );
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, configDir);
    const openClaude = join(dir, "openclaude");
    writeFileSync(
      openClaude,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"openclaude 0.9.0\"; exit 0; fi\nexit 1\n",
    );
    chmodSync(openClaude, 0o755);
    const close = vi.fn();
    claudeSdk.query.mockReturnValue({
      close,
      supportedModels: vi.fn().mockResolvedValue([
        {
          value: "default",
          displayName: "Default (recommended)",
          description: "Use the default model (currently minimax-m2.5)",
        },
        {
          value: "opus",
          displayName: "minimax-m2.5",
          description: "Custom Opus model",
        },
        {
          value: "sonnet",
          displayName: "minimax-m2.5",
          description: "Custom Sonnet model",
        },
        {
          value: "minimax-m2.5",
          displayName: "minimax-m2.5",
          description: "Custom model",
        },
      ]),
    });

    const detection = await detectClaude({
      cwd: dir,
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection.configDir).toBe(configDir);
    expect(detection.models).toEqual([
      {
        id: "default",
        label: "Default (recommended)",
        description: "Use the default model (currently minimax-m2.5)",
      },
      {
        id: "opus",
        label: "minimax-m2.5",
        description: "Custom Opus model",
      },
      {
        id: "sonnet",
        label: "minimax-m2.5",
        description: "Custom Sonnet model",
      },
      {
        id: "minimax-m2.5",
        label: "minimax-m2.5",
        description: "Custom model",
      },
    ]);
    expect(claudeSdk.query).toHaveBeenCalledWith({
      prompt: expect.any(Object),
      options: {
        cwd: dir,
        env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
        includePartialMessages: true,
        pathToClaudeCodeExecutable: openClaude,
        settingSources: ["user", "project", "local"],
      },
    });
    expect(close).toHaveBeenCalled();
  });
});
