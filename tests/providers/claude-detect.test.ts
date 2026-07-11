import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV } from "../../src/core/managed-invocation.js";
import {
  detectClaude,
  detectClaudeAuthState,
} from "../../src/providers/claude/detect.js";

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

  it("passes cwd and env through Claude Code version and SDK model discovery", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-managed-"));
    const cwd = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-managed-cwd-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, cwd, configDir);
    const claudeBin = join(dir, "claude");
    const credential = "managed-claude-secret";
    writeFileSync(
      claudeBin,
      `#!${process.execPath}
const fs = require("node:fs");
const expectedCwd = fs.realpathSync(${JSON.stringify(cwd)});
const expectedCredential = ${JSON.stringify(credential)};
if (process.argv[2] === "--version" &&
  fs.realpathSync(process.cwd()) === expectedCwd &&
  process.env.${MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV} === expectedCredential) {
  console.log("claude 2.0.0");
  process.exit(0);
}
if (process.argv[2] === "auth" && process.argv[3] === "status" &&
  fs.realpathSync(process.cwd()) === expectedCwd &&
  process.env.${MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV} === expectedCredential) {
  console.log(JSON.stringify({ loggedIn: true, authMethod: "managed" }));
  process.exit(0);
}
process.exit(9);
`,
    );
    chmodSync(claudeBin, 0o755);
    const close = vi.fn();
    claudeSdk.query.mockReturnValue({
      close,
      supportedModels: vi.fn().mockResolvedValue([
        { value: "sonnet", displayName: "Sonnet" },
      ]),
    });

    const detection = await detectClaude({
      cwd,
      env: {
        PATH: dir,
        CLAUDE_CONFIG_DIR: configDir,
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: credential,
      },
    });

    expect(detection).toMatchObject({
      executablePath: claudeBin,
      supported: true,
      version: "claude 2.0.0",
    });
    expect(claudeSdk.query).toHaveBeenCalledWith({
      prompt: expect.any(Object),
      options: {
        cwd,
        env: {
          PATH: dir,
          CLAUDE_CONFIG_DIR: configDir,
          [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: credential,
        },
        includePartialMessages: true,
        pathToClaudeCodeExecutable: claudeBin,
        settingSources: ["user", "project", "local"],
      },
    });
    expect(close).toHaveBeenCalled();
  });

  it("redacts managed invocation credentials from version failures", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-redact-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, configDir);
    const claudeBin = join(dir, "claude");
    const credential = "managed-claude-redact-secret";
    writeFileSync(
      claudeBin,
      `#!${process.execPath}
if (process.argv[2] === "--version") {
  process.stderr.write("failed with " + process.env.${MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV});
  process.exit(9);
}
process.exit(1);
`,
    );
    chmodSync(claudeBin, 0o755);

    const detection = await detectClaude({
      env: {
        PATH: dir,
        CLAUDE_CONFIG_DIR: configDir,
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: credential,
      },
    });

    expect(detection).toMatchObject({
      supported: false,
      version: "unknown",
    });
    expect(detection.unsupportedReason).toContain("[REDACTED]");
    expect(detection.unsupportedReason).not.toContain(credential);
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
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"openclaude 0.9.0\"; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true}'; exit 0; fi\nexit 1\n",
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

  it("reports an installed but logged-out Claude CLI as missing auth", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-logged-out-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, configDir);
    const claudeBin = join(dir, "claude");
    writeFileSync(
      claudeBin,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'claude 2.1.0'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":false,\"authMethod\":\"none\"}'; exit 1; fi\nexit 1\n",
    );
    chmodSync(claudeBin, 0o755);

    const detection = await detectClaude({
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection).toMatchObject({
      authState: "missing",
      executablePath: claudeBin,
      supported: true,
      version: "claude 2.1.0",
    });
    expect(claudeSdk.query).not.toHaveBeenCalled();
  });

  it("fails closed when a nonzero auth command claims a positive login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-auth-failed-"));
    tempDirs.push(dir);
    const claudeBin = join(dir, "claude");
    writeFileSync(
      claudeBin,
      "#!/bin/sh\necho '{\"loggedIn\":true}'\nexit 1\n",
    );
    chmodSync(claudeBin, 0o755);

    await expect(detectClaudeAuthState({ executablePath: claudeBin }))
      .resolves.toBe("unknown");
  });

  it("reports expired Claude credentials and does not probe models", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-expired-"));
    const configDir = mkdtempSync(join(tmpdir(), "agent-acp-kit-claude-home-"));
    tempDirs.push(dir, configDir);
    const claudeBin = join(dir, "claude");
    writeFileSync(
      claudeBin,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo 'claude 2.1.0'; exit 0; fi\nif [ \"$1\" = \"auth\" ]; then echo '{\"loggedIn\":true,\"expiresAt\":\"2000-01-01T00:00:00.000Z\"}'; exit 0; fi\nexit 1\n",
    );
    chmodSync(claudeBin, 0o755);

    const detection = await detectClaude({
      env: { PATH: dir, CLAUDE_CONFIG_DIR: configDir },
    });

    expect(detection.authState).toBe("expired");
    expect(claudeSdk.query).not.toHaveBeenCalled();
  });
});
