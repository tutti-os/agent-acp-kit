import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectClaude } from "../../src/providers/claude/detect.js";

describe("detectClaude", () => {
  const tempDirs: string[] = [];

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
    expect(detection.models.map((model) => model.id)).toContain("sonnet");
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
      "sonnet",
      "opus",
      "haiku",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
  });

  it("adds configured Claude Code custom models after the default model hint", async () => {
    const dir = mkdtempSync(
      join(tmpdir(), "agent-acp-kit-claude-config-models-"),
    );
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, configDir);
    const openClaude = join(dir, "openclaude");
    writeFileSync(
      openClaude,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"openclaude 0.9.0\"; exit 0; fi\nexit 1\n",
    );
    chmodSync(openClaude, 0o755);
    writeFileSync(
      join(configDir, "settings.json"),
      JSON.stringify({
        model: "sonnet",
        env: {
          ANTHROPIC_MODEL: "minimax-m2.5",
          ANTHROPIC_DEFAULT_SONNET_MODEL: "minimax-m2.5",
          ANTHROPIC_DEFAULT_OPUS_MODEL: "router-opus",
        },
      }),
    );

    const detection = await detectClaude({
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection.configDir).toBe(configDir);
    expect(detection.models.map((model) => model.id)).toEqual([
      "default",
      "minimax-m2.5",
      "router-opus",
      "sonnet",
      "opus",
      "haiku",
      "claude-opus-4-5",
      "claude-sonnet-4-5",
      "claude-haiku-4-5",
    ]);
  });
});
