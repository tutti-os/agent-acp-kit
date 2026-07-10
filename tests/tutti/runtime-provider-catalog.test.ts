import { describe, expect, it, vi } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import { resolveTuttiAgentProviderCatalog } from "../../src/tutti/index.js";

function runtime(): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    listProviders: () => [
      { id: "codex", displayName: "Codex", kind: "local-agent" },
      { id: "claude-code", displayName: "Claude Code", kind: "local-agent" },
    ],
    detect: vi.fn(async () => [
      {
        provider: "codex",
        displayName: "Codex",
        result: {
          authState: "ok",
          executablePath: "codex",
          models: [{ id: "detected-model", label: "Detected" }],
          supported: true,
          version: "1",
        },
      },
      { provider: "claude-code", displayName: "Claude Code", result: null },
    ]),
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

describe("Tutti app-facing provider catalog", () => {
  it("reuses one standalone detection and excludes undetected providers from defaults", async () => {
    const localRuntime = runtime();
    const result = await resolveTuttiAgentProviderCatalog({
      env: {},
      runtime: localRuntime,
    });

    expect(localRuntime.detect).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      defaultProvider: "codex",
      source: "standalone",
      providers: [
        { provider: "codex", available: true, models: [{ id: "detected-model" }] },
        { provider: "claude-code", available: false },
      ],
    });
  });

  it("combines the CLI catalog with runtime readiness and composer model values", async () => {
    const localRuntime = runtime();
    const calls: string[][] = [];
    const result = await resolveTuttiAgentProviderCatalog({
      runtime: localRuntime,
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("composer-options")) {
          return {
            schemaVersion: 1,
            provider: "codex",
            effectiveSettings: { model: "gpt-5" },
            modelConfig: {
              configurable: true,
              currentValue: "gpt-5",
              defaultValue: "gpt-5",
              options: [{ id: "display-id", value: "gpt-5", label: "GPT-5" }],
            },
            permissionConfig: { configurable: false, defaultValue: "", modes: [] },
            reasoningConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
            speedConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
          };
        }
        return {
          schemaVersion: 2,
          defaultProviderId: "codex",
          providers: [
            {
              providerId: "codex",
              displayName: "Codex",
              availability: { status: "available", reasonCode: "", detail: "" },
            },
            {
              providerId: "claude-code",
              displayName: "Claude Code",
              availability: { status: "available", reasonCode: "", detail: "" },
            },
          ],
        };
      },
    });

    expect(localRuntime.detect).toHaveBeenCalledTimes(1);
    expect(calls.filter((args) => args.includes("composer-options"))).toHaveLength(1);
    expect(result.defaultProvider).toBe("codex");
    expect(result.providers).toMatchObject([
      {
        provider: "codex",
        available: true,
        defaultModelId: "gpt-5",
        models: [{ id: "gpt-5", label: "GPT-5" }],
      },
      { provider: "claude-code", available: false },
    ]);
  });

  it("allows managed execution without requiring a local executable", async () => {
    const localRuntime = runtime();
    localRuntime.detect = vi.fn(async () => [
      { provider: "codex", displayName: "Codex", result: null },
    ]);
    const result = await resolveTuttiAgentProviderCatalog({
      detectContext: {
        managedAgentInvocation: { credential: "secret", cwd: "/tmp/managed" },
      },
      includeComposerModels: false,
      runtime: localRuntime,
      runTuttiCli: async () => ({
        schemaVersion: 2,
        defaultProviderId: "codex",
        providers: [{
          providerId: "codex",
          displayName: "Codex",
          availability: { status: "available", reasonCode: "", detail: "" },
        }],
      }),
    });

    expect(result.providers[0]).toMatchObject({ provider: "codex", available: true });
  });
});
