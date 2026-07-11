import { describe, expect, it, vi } from "vitest";

import type { LocalAgentRuntime } from "../../src/runtime/create-runtime.js";
import {
  loadTuttiAgentProviderCatalog,
  TuttiIntegrationError,
} from "../../src/tutti/index.js";

function fakeRuntime(input: {
  providers?: Array<{
    id: string;
    displayName: string;
    kind: string;
    requiresKnownAuth?: boolean;
  }>;
  detections?: Array<Record<string, unknown>>;
} = {}): LocalAgentRuntime<string, string> {
  return {
    cancel: vi.fn(),
    listProviders: () =>
      input.providers ?? [
        { id: "codex", displayName: "Codex", kind: "local-agent" },
        {
          id: "claude-code",
          displayName: "Claude Code",
          kind: "local-agent",
          requiresKnownAuth: true,
        },
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
    expect(catalog.defaultProviderId).toBe("codex");
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

  it("uses provider-owned policy for unknown standalone authentication", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      env: {},
      runtime: fakeRuntime({
        providers: [
          {
            id: "strict-agent",
            displayName: "Strict Agent",
            kind: "local-agent",
            requiresKnownAuth: true,
          },
          { id: "relaxed-acp", displayName: "Relaxed ACP", kind: "local-agent" },
        ],
        detections: ["strict-agent", "relaxed-acp"].map((provider) => ({
          provider,
          displayName: provider,
          result: {
            authState: "unknown",
            executablePath: provider,
            supported: true,
            version: "1",
          },
        })),
      }),
    });
    expect(catalog.providers).toMatchObject([
      {
        providerId: "strict-agent",
        availability: {
          status: "unknown",
          reasonCode: "auth_unknown",
        },
      },
      {
        providerId: "relaxed-acp",
        availability: { status: "available" },
      },
    ]);
    expect(catalog.defaultProviderId).toBe("relaxed-acp");
  });

  it("canonicalizes the legacy Claude ingress without exposing an alias", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        schemaVersion: 2,
        defaultProviderId: "claude",
        providers: [{
          providerId: "claude",
          displayName: "Claude Code",
          availability: { status: "available", reasonCode: "", detail: "" },
        }],
      }),
    });
    expect(catalog.defaultProviderId).toBe("claude-code");
    expect(catalog.providers).toMatchObject([
      { providerId: "claude-code", runtimeSupported: true },
    ]);
  });

  it("marks every runtime-unsupported provider unavailable", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      runtime: fakeRuntime(),
      runTuttiCli: async () => ({
        schemaVersion: 2,
        defaultProviderId: "future-agent",
        providers: [{
          providerId: "future-agent",
          displayName: "Future Agent",
          availability: { status: "unknown", reasonCode: "probing", detail: "Waiting" },
        }],
      }),
    });
    expect(catalog.providers[0]).toMatchObject({
      runtimeSupported: false,
      availability: { status: "unavailable", reasonCode: "kit_runtime_unavailable" },
    });
  });

  it("disables CLI providers that managed invocation cannot execute", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      runtime: fakeRuntime({
        providers: [
          { id: "codex", displayName: "Codex", kind: "local-agent" },
          { id: "opencode", displayName: "OpenCode", kind: "local-agent" },
        ],
      }),
      detectContext: {
        managedAgentInvocation: { credential: "secret", cwd: "/tmp/managed-run" },
      },
      runTuttiCli: async () => ({
        schemaVersion: 2,
        defaultProviderId: "opencode",
        providers: [
          {
            providerId: "opencode",
            displayName: "OpenCode",
            availability: { status: "available", reasonCode: "", detail: "" },
          },
          {
            providerId: "codex",
            displayName: "Codex",
            availability: { status: "available", reasonCode: "", detail: "" },
          },
        ],
      }),
    });
    expect(catalog.providers).toMatchObject([
      {
        providerId: "opencode",
        runtimeSupported: false,
        availability: { status: "unavailable", reasonCode: "managed_provider_unsupported" },
      },
      { providerId: "codex", runtimeSupported: true },
    ]);
    expect(catalog.defaultProviderId).toBe("codex");
  });

  it("applies the managed provider boundary in standalone mode too", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      env: {},
      runtime: fakeRuntime({
        providers: [
          { id: "opencode", displayName: "OpenCode", kind: "local-agent" },
          { id: "codex", displayName: "Codex", kind: "local-agent" },
        ],
        detections: [
          {
            provider: "opencode",
            displayName: "OpenCode",
            result: { authState: "ok", executablePath: "opencode", version: "1" },
          },
          {
            provider: "codex",
            displayName: "Codex",
            result: { authState: "ok", executablePath: "codex", version: "1" },
          },
        ],
      }),
      detectContext: {
        managedAgentInvocation: { credential: "secret", cwd: "/tmp/managed-run" },
      },
    });
    expect(catalog.providers).toMatchObject([
      {
        providerId: "opencode",
        runtimeSupported: false,
        availability: { status: "unavailable", reasonCode: "managed_provider_unsupported" },
      },
      { providerId: "codex", runtimeSupported: true },
    ]);
    expect(catalog.defaultProviderId).toBe("codex");
  });

  it("prefers a managed-supported standalone default when no provider is available", async () => {
    const catalog = await loadTuttiAgentProviderCatalog({
      env: {},
      runtime: fakeRuntime({
        providers: [
          { id: "opencode", displayName: "OpenCode", kind: "local-agent" },
          { id: "codex", displayName: "Codex", kind: "local-agent" },
        ],
        detections: [],
      }),
      detectContext: {
        managedAgentInvocation: { credential: "secret", cwd: "/tmp/managed-run" },
      },
    });
    expect(catalog.providers).toMatchObject([
      { providerId: "opencode", runtimeSupported: false },
      {
        providerId: "codex",
        runtimeSupported: true,
        availability: { status: "unavailable" },
      },
    ]);
    expect(catalog.defaultProviderId).toBe("codex");
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
