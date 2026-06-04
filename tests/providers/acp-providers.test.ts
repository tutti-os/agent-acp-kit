import { describe, expect, it } from "vitest";

import {
  createGenericAcpProvider,
  createHermesProvider,
  createKimiProvider,
  createKiroProvider,
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
    const providers = [
      createHermesProvider(),
      createKimiProvider(),
      createKiroProvider(),
    ];

    expect(providers.map((provider) => provider.id)).toEqual([
      "hermes",
      "kimi",
      "kiro",
    ]);

    for (const provider of providers) {
      const plan = await provider.buildLaunchPlan({
        runId: `run_${provider.id}`,
        cwd: "/tmp",
        prompt: "hello",
        runtimeKind: "local-agent",
        runtimeProvider: provider.id,
      });

      expect(plan.promptInput).toBe("stdin");
      expect(plan.args).toEqual(["acp"]);
      expect(provider.capabilities()).toMatchObject({
        nativeResume: false,
        streaming: true,
      });
    }
  });
});
