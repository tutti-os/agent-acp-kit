import { describe, expect, it, vi } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import {
  loadTuttiAgentProviderCatalog,
  TuttiIntegrationError,
} from "../../src/tutti/index.js";

function fakeRuntime(input: {
  providers?: Array<{ id: string; displayName: string; kind: string }>;
  detections?: Array<Record<string, unknown>>;
} = {}): LocalAgentRuntime<string, string> {
  return {
    cancel: vi.fn(),
    listProviders: () =>
      input.providers ?? [
        { id: "codex", displayName: "Codex", kind: "local-agent" },
        { id: "claude-code", displayName: "Claude Code", kind: "local-agent" },
      ],
    detect: async () =>
      (input.detections ?? [
        {
          provider: "codex",
          displayName: "Codex",
          result: { authState: "ok", executablePath: "codex", version: "1" },
        },
        {
          provider: "claude-code",
          displayName: "Claude Code",
          result: null,
        },
      ]) as Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>,
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

describe("Tutti provider catalog", () => {
  it("uses CLI catalog order and never adds runtime-only providers", async () => {
    const calls: string[][] = [];
    const catalog = await loadTuttiAgentProviderCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async (args) => {
        calls.push(args);
        return {
          schemaVersion: 2,
          defaultProviderId: "future-agent",
          providers: [
            {
              providerId: "future-agent",
              displayName: "Future Agent",
              agentTargetId: "user:future",
              availability: { status: "available", reasonCode: "", detail: "" },
            },
            {
              providerId: "codex",
              displayName: "Codex",
              agentTargetId: "local:codex",
              availability: { status: "available", reasonCode: "", detail: "" },
            },
          ],
        };
      },
    });

    expect(calls).toEqual([["--json", "agent", "providers"]]);
    expect(catalog.source).toBe("tutti-cli");
    expect(catalog.providers.map((provider) => provider.providerId)).toEqual([
      "future-agent",
      "codex",
    ]);
    expect(catalog.providers[0]).toMatchObject({
      runtimeSupported: false,
      availability: { status: "unavailable", reasonCode: "kit_runtime_unavailable" },
    });
    expect(catalog.providers.some((provider) => provider.providerId === "claude-code"))
      .toBe(false);
  });

  it("automatically uses standalone discovery when no CLI is configured", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      env: {},
      runtime: fakeRuntime(),
    });
    expect(catalog).toMatchObject({
      schemaVersion: 2,
      source: "standalone",
      defaultProviderId: "codex",
    });
    expect(catalog.providers).toMatchObject([
      { providerId: "codex", availability: { status: "available" } },
      { providerId: "claude-code", availability: { status: "unavailable" } },
    ]);
  });

  it("does not fall back when a configured CLI fails", async () => {
    const runtime = fakeRuntime();
    const detect = vi.spyOn(runtime, "detect");
    await expect(
      loadTuttiAgentProviderCatalog({
        runtime,
        runTuttiCli: async () => {
          throw new Error("secret-output-must-not-leak");
        },
      }),
    ).rejects.toMatchObject<TuttiIntegrationError>({
      code: "cli_execution_failed",
      message: "Tutti CLI request failed.",
    });
    expect(detect).not.toHaveBeenCalled();
  });

  it("rejects unsupported CLI schemas", async () => {
    await expect(
      loadTuttiAgentProviderCatalog({
        runtime: fakeRuntime(),
        runTuttiCli: async () => ({ schemaVersion: 1, providers: [] }),
      }),
    ).rejects.toMatchObject({ code: "unsupported_schema" });
  });
});
