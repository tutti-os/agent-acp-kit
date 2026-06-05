import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  getAgentProviderInstallStatus,
  installAgentProvider,
  type AgentProviderInstallCommandResult,
} from "../../src/providers/install.js";

describe("agent provider install", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  function tempPath(prefix: string) {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    tempDirs.push(dir);
    return dir;
  }

  function writeExecutable(dir: string, name: string, body = "exit 0") {
    const filePath = join(dir, name);
    writeFileSync(filePath, `#!/bin/sh\n${body}\n`);
    chmodSync(filePath, 0o755);
    return filePath;
  }

  function successfulRunner(
    onCommand?: (command: string) => void,
  ): Parameters<typeof installAgentProvider>[1]["commandRunner"] {
    return async (command): Promise<AgentProviderInstallCommandResult> => {
      onCommand?.(command);
      return {
        command,
        code: 0,
        signal: null,
        stdout: "installed",
        stderr: "",
        timedOut: false,
        canceled: false,
      };
    };
  }

  it("selects the full Codex install command when the CLI is missing", async () => {
    const dir = tempPath("agent-acp-kit-install-codex-missing-");
    const commands: string[] = [];

    const result = await installAgentProvider("codex", {
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex") },
      commandRunner: successfulRunner((command) => {
        commands.push(command);
        writeExecutable(dir, "codex", "if [ \"$1\" = \"auth\" ]; then exit 0; fi\nexit 0");
        writeExecutable(dir, "codex-acp");
      }),
    });

    expect(commands).toEqual([
      "npm install -g @openai/codex @zed-industries/codex-acp",
    ]);
    expect(result).toMatchObject({
      provider: "codex",
      status: "succeeded",
      before: {
        availability: "not_installed",
        reason: "cli_not_found",
      },
      after: {
        cli: { installed: true },
        adapter: { installed: true },
      },
    });
  });

  it("selects the adapter-only Claude command when the CLI is already installed", async () => {
    const dir = tempPath("agent-acp-kit-install-claude-adapter-");
    writeExecutable(
      dir,
      "claude",
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi\nexit 0",
    );
    const commands: string[] = [];

    const result = await installAgentProvider("claude", {
      env: { PATH: dir },
      commandRunner: successfulRunner((command) => {
        commands.push(command);
        writeExecutable(dir, "claude-agent-acp");
      }),
    });

    expect(commands).toEqual([
      "npm install -g @agentclientprotocol/claude-agent-acp",
    ]);
    expect(result.status).toBe("succeeded");
    expect(result.before.reason).toBe("acp_adapter_not_found");
    expect(result.after.availability).toBe("ready");
  });

  it("skips installation when the provider binaries are already installed", async () => {
    const dir = tempPath("agent-acp-kit-install-ready-");
    writeExecutable(
      dir,
      "claude",
      "if [ \"$1\" = \"auth\" ] && [ \"$2\" = \"status\" ]; then exit 0; fi\nexit 0",
    );
    writeExecutable(dir, "claude-agent-acp");

    const result = await installAgentProvider("claude", {
      env: { PATH: dir },
      commandRunner: async () => {
        throw new Error("should not run");
      },
    });

    expect(result.status).toBe("skipped");
    expect(result.command).toBeNull();
    expect(result.before.availability).toBe("ready");
  });

  it("reports auth_required when both binaries exist but auth is missing", async () => {
    const dir = tempPath("agent-acp-kit-install-auth-required-");
    writeExecutable(dir, "codex");
    writeExecutable(dir, "codex-acp");

    await expect(
      getAgentProviderInstallStatus("codex", {
        env: { PATH: dir, CODEX_HOME: join(dir, ".codex") },
      }),
    ).resolves.toMatchObject({
      availability: "auth_required",
      reason: "auth_required",
      cli: { installed: true },
      adapter: { installed: true },
    });
  });
});
