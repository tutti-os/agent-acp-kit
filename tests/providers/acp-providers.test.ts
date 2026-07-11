import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  ACP_PROVIDER_SPECS,
  DEFAULT_LOCAL_AGENT_PROVIDER_IDS,
  MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV,
  MANAGED_AGENT_MCP_ATTACHMENT_ENV,
  createDefaultLocalAgentProviderPlugins,
  createGenericAcpProvider,
  createKnownAcpProvider,
} from "../../src/index.js";

describe("ACP provider wrappers", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reports unsupported when an ACP provider command is not installed", async () => {
    const provider = createGenericAcpProvider({
      args: ["acp"],
      command: "definitely-missing-acp-provider",
      displayName: "Missing ACP",
      providerId: "missing-acp",
    });

    await expect(provider.detect()).resolves.toMatchObject({
      authState: "missing",
      executablePath: "definitely-missing-acp-provider",
      supported: false,
      unsupportedReason: expect.stringContaining("Executable not found"),
      version: "not-installed",
    });
  });

  it("keeps a redacted diagnostic when ACP model discovery fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-acp-diagnostic-"));
    tempDirs.push(dir);
    const command = join(dir, "broken-acp");
    const secret = "acp-diagnostic-secret";
    writeFileSync(
      command,
      `#!${process.execPath}
process.stderr.write("registry probe failed with ${secret}");
setTimeout(() => process.exit(42), 10);
`,
    );
    chmodSync(command, 0o755);
    const provider = createGenericAcpProvider({
      args: [],
      command: "broken-acp",
      displayName: "Broken ACP",
      providerId: "broken-acp",
    });

    const detection = await provider.detect({
      env: { PATH: dir },
      redactionSecrets: [secret],
    });

    expect(detection).toMatchObject({
      executablePath: command,
      models: [],
      supported: true,
      diagnostics: [
        {
          message: expect.stringContaining(
            "ACP model detection exited with code 42",
          ),
          source: "acp-model-discovery",
        },
      ],
    });
    expect(detection?.diagnostics?.[0]?.message).toContain("[REDACTED]");
    expect(detection?.diagnostics?.[0]?.message).not.toContain(secret);
  });

  it("exposes concrete provider plugins backed by the shared ACP transport", async () => {
    for (const spec of ACP_PROVIDER_SPECS) {
      const provider = createKnownAcpProvider(spec.id);
      const plan = await provider.buildLaunchPlan({
        runId: `run_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        permission: { modeId: "full-access", semantic: "full-access" },
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });

      expect(plan.promptInput).toBe("stdin");
      expect(plan.permission).toEqual({
        modeId: "full-access",
        semantic: "full-access",
      });
      const defaultPlan = await provider.buildLaunchPlan({
        runId: `run_default_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });
      expect(defaultPlan.permission).toEqual({ semantic: "full-access" });
      expect(plan.args).toEqual(spec.args);
      expect(provider.capabilities()).toMatchObject({
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
        nativeResume: false,
        streaming: true,
      });
    }
  });

  it("applies managed invocation to generic ACP providers when the provider id is nexight", async () => {
    const provider = createGenericAcpProvider({
      args: ["acp"],
      command: "nexight",
      displayName: "Nexight",
      providerId: "nexight",
    });

    const plan = await provider.buildLaunchPlan({
      runId: "run_nexight",
      cwd: "/tmp/project",
      prompt: "hello",
      managedAgentInvocation: {
        credential: "managed-nexight-secret",
        cwd: "/workspace/project",
      },
    });

    expect(plan).toMatchObject({
      command: "nexight",
      cwd: "/workspace/project",
      env: {
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-nexight-secret",
      },
      redactionSecrets: ["managed-nexight-secret"],
      transport: "acp-json-rpc",
    });
  });

  it("moves managed generic ACP MCP servers into tsh handoff env", async () => {
    const provider = createGenericAcpProvider({
      args: ["acp"],
      command: "nexight",
      displayName: "Nexight",
      providerId: "nexight",
    });

    const plan = await provider.buildLaunchPlan({
      runId: "run_nexight_mcp",
      cwd: "/tmp/project",
      prompt: "hello",
      managedAgentInvocation: {
        credential: "managed-nexight-secret",
        cwd: "/workspace/project",
      },
      mcpServers: [
        {
          name: "aimc",
          command: process.execPath,
          args: ["/tmp/aimc-mcp.js"],
          env: { AIMC_TOOL_TOKEN: "tool-token" },
        },
      ],
    });

    const encoded = plan.env?.[MANAGED_AGENT_MCP_ATTACHMENT_ENV];
    expect(encoded).toBeTruthy();
    expect(plan.mcpServers).toBeUndefined();
    expect(plan.redactionSecrets).toContain("managed-nexight-secret");
    expect(plan.redactionSecrets).toContain("tool-token");
    expect(plan.redactionSecrets).toContain(encoded);
  });

  it("builds the default provider list with dedicated Codex and Claude plus ACP presets", () => {
    const providers = createDefaultLocalAgentProviderPlugins();

    expect(providers.map((provider) => provider.id)).toEqual(
      DEFAULT_LOCAL_AGENT_PROVIDER_IDS,
    );
    expect(providers.map((provider) => provider.kind)).toEqual(
      providers.map(() => "local-agent"),
    );
  });
});
