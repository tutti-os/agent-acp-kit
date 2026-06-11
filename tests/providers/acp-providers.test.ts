import { describe, expect, it } from "vitest";

import {
  ACP_PROVIDER_SPECS,
  DEFAULT_LOCAL_AGENT_PROVIDER_IDS,
  createDefaultLocalAgentProviderPlugins,
  createGenericAcpProvider,
  createKnownAcpProvider,
} from "../../src/index.js";

describe("ACP provider wrappers", () => {
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

  it("exposes concrete provider plugins backed by the shared ACP transport", async () => {
    for (const spec of ACP_PROVIDER_SPECS) {
      const provider = createKnownAcpProvider(spec.id);
      const plan = await provider.buildLaunchPlan({
        runId: `run_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });

      expect(plan.promptInput).toBe("stdin");
      expect(plan.args).toEqual(spec.args);
      expect(provider.capabilities()).toMatchObject({
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
        nativeResume: false,
        streaming: true,
      });
    }
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
