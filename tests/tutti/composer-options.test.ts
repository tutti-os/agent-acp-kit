import { describe, expect, it } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import { loadTuttiAgentComposerOptions } from "../../src/tutti/index.js";

function runtime(): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    listProviders: () => [
      { id: "codex", displayName: "Codex", kind: "local-agent" },
    ],
    detect: async () => [
      {
        provider: "codex",
        displayName: "Codex",
        result: {
          authState: "ok",
          executablePath: "codex",
          version: "1",
          models: [{ id: "gpt-5", label: "GPT-5", description: "Default" }],
        },
      },
    ],
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

const cliCatalog = {
  schemaVersion: 2,
  defaultProviderId: "codex",
  providers: [
    {
      providerId: "codex",
      displayName: "Codex",
      agentTargetId: "local:codex",
      availability: { status: "available", reasonCode: "", detail: "" },
    },
  ],
};

const cliComposer = {
  schemaVersion: 1,
  provider: "codex",
  effectiveSettings: { model: "gpt-5", permissionModeId: "auto" },
  modelConfig: {
    configurable: true,
    currentValue: "gpt-5",
    defaultValue: "gpt-5",
    options: [{ id: "gpt-5", value: "gpt-5", label: "GPT-5" }],
  },
  permissionConfig: {
    configurable: true,
    defaultValue: "auto",
    modes: [{ id: "auto", label: "Auto", semantic: "auto" }],
  },
  reasoningConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
  speedConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
};

describe("Tutti composer options", () => {
  it("validates the CLI catalog and loads canonical provider options", async () => {
    const calls: string[][] = [];
    const options = await loadTuttiAgentComposerOptions({
      runtime: runtime(),
      providerId: "codex",
      cwd: "/workspace",
      includeCapabilityCatalog: false,
      runTuttiCli: async (args) => {
        calls.push(args);
        return calls.length === 1 ? cliCatalog : cliComposer;
      },
    });
    expect(calls).toEqual([
      ["--json", "agent", "providers"],
      [
        "--json",
        "agent",
        "composer-options",
        "--provider",
        "codex",
        "--cwd",
        "/workspace",
        "--include-capability-catalog",
        "false",
      ],
    ]);
    expect(options).toMatchObject({
      source: "tutti-cli",
      providerId: "codex",
      modelConfig: { currentValue: "gpt-5" },
    });
  });

  it("builds conservative standalone options without requiring mode", async () => {
    const options = await loadTuttiAgentComposerOptions({
      env: {},
      runtime: runtime(),
      providerId: "codex",
    });
    expect(options).toMatchObject({
      source: "standalone",
      providerId: "codex",
      modelConfig: { configurable: true, defaultValue: "gpt-5" },
      permissionConfig: { configurable: false },
      reasoningConfig: { configurable: false },
    });
  });

  it("preserves the selected standalone model", async () => {
    const options = await loadTuttiAgentComposerOptions({
      env: {},
      runtime: runtime(),
      providerId: "codex",
      model: "custom-model",
    });
    expect(options).toMatchObject({
      effectiveSettings: { model: "custom-model" },
      modelConfig: { currentValue: "custom-model", defaultValue: "gpt-5" },
    });
  });

  it("rejects unsupported composer schemas", async () => {
    let call = 0;
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        providerId: "codex",
        runTuttiCli: async () => {
          call += 1;
          return call === 1 ? cliCatalog : { ...cliComposer, schemaVersion: 2 };
        },
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
  });

  it("rejects providers absent from the CLI catalog", async () => {
    await expect(
      loadTuttiAgentComposerOptions({
        runtime: runtime(),
        providerId: "future-agent",
        runTuttiCli: async () => cliCatalog,
      }),
    ).rejects.toMatchObject({ code: "provider_not_found" });
  });

  it("accepts the legacy Claude id only at input and returns canonical output", async () => {
    const claudeRuntime = runtime();
    claudeRuntime.listProviders = () => [
      { id: "claude-code", displayName: "Claude Code", kind: "local-agent" },
    ];
    const claudeCatalog = {
      ...cliCatalog,
      defaultProviderId: "claude-code",
      providers: [{
        ...cliCatalog.providers[0],
        providerId: "claude-code",
        displayName: "Claude Code",
      }],
    };
    const claudeComposer = {
      ...cliComposer,
      provider: "claude-code",
    };
    let call = 0;
    const options = await loadTuttiAgentComposerOptions({
      runtime: claudeRuntime,
      providerId: "claude",
      runTuttiCli: async () => {
        call += 1;
        return call === 1 ? claudeCatalog : claudeComposer;
      },
    });
    expect(options.providerId).toBe("claude-code");
  });
});
