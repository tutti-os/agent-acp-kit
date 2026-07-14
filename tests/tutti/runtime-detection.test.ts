import { describe, expect, it, vi } from "vitest";

import { TuttiIntegrationError } from "../../src/tutti/cli-json-runner.js";
import { detectTuttiManagedProviders } from "../../src/tutti/runtime-detection.js";

const context = {
  managedAgentInvocation: { credential: "secret", cwd: "/workspace" },
};

const descriptors = [
  { id: "codex", displayName: "Codex", requiresKnownAuth: false },
  { id: "claude-code", displayName: "Claude Code", requiresKnownAuth: true },
] as const;

function catalog() {
  return {
    schemaVersion: 2,
    defaultProviderId: "codex",
    providers: descriptors.map((provider) => ({
      providerId: provider.id,
      displayName: provider.displayName,
      availability: { status: "available", reasonCode: "", detail: "" },
    })),
  };
}

function composer(provider: string) {
  return {
    schemaVersion: 1,
    provider,
    effectiveSettings: { model: `${provider}-default` },
    modelConfig: {
      configurable: true,
      currentValue: `${provider}-default`,
      defaultValue: `${provider}-default`,
      options: [{ id: "default", value: `${provider}-default`, label: `${provider} default` }],
    },
    permissionConfig: { configurable: false, defaultValue: "", modes: [] },
    reasoningConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
    speedConfig: { configurable: false, currentValue: "", defaultValue: "", options: [] },
  };
}

describe("managed runtime detection", () => {
  it("loads providers once and starts eligible composer requests concurrently", async () => {
    const calls: string[][] = [];
    const releases = new Map<string, (value: unknown) => void>();
    const runTuttiCli = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes("providers")) return catalog();
      const provider = args.at(-1)!;
      return await new Promise((resolve) => releases.set(provider, resolve));
    });

    const pending = detectTuttiManagedProviders({ context, descriptors: [...descriptors], runTuttiCli });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get("codex")!(composer("codex"));
    releases.get("claude-code")!(composer("claude-code"));
    const result = await pending;

    expect(calls.filter((args) => args.includes("providers"))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("composer-options"))).toHaveLength(2);
    expect(result).toMatchObject([
      { provider: "codex", supported: true, authState: "ok", defaultModelId: "codex-default", isDefault: true },
      { provider: "claude-code", supported: true, authState: "ok", defaultModelId: "claude-code-default" },
    ]);
    expect(result.filter((entry) => entry.isDefault)).toHaveLength(1);
  });

  it("degrades only failed model enumeration and keeps the provider supported", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (args.includes("providers")) return catalog();
        if (args.at(-1) === "claude-code") throw new Error("timeout");
        return composer("codex");
      },
    });
    expect(result[1]).toMatchObject({
      provider: "claude-code",
      supported: true,
      models: [{ id: "default", label: "Default" }],
      defaultModelId: "default",
    });
  });

  it("canonicalizes and preserves an unavailable default provider", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (!args.includes("providers")) return composer(args.at(-1)!);
        const payload = catalog();
        payload.defaultProviderId = "claude";
        payload.providers[1]!.providerId = "claude";
        payload.providers[1]!.availability = {
          status: "unavailable",
          reasonCode: "auth_required",
          detail: "Provider authentication is required.",
        };
        return payload;
      },
    });

    expect(result[1]).toMatchObject({
      provider: "claude-code",
      supported: false,
      authState: "missing",
      isDefault: true,
    });
    expect(result.filter((entry) => entry.isDefault)).toHaveLength(1);
  });

  it("does not request composer options for an unavailable provider", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) => {
      if (args.includes("providers")) {
        const payload = catalog();
        payload.providers[1]!.availability = {
          status: "unavailable",
          reasonCode: "auth_required",
          detail: "Provider authentication is required.",
        };
        return payload;
      }
      return composer(args.at(-1)!);
    });

    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli,
    });

    expect(
      runTuttiCli.mock.calls
        .filter(([args]) => args.includes("composer-options"))
        .map(([args]) => args.at(-1)),
    ).toEqual(["codex"]);
    expect(result[1]).toMatchObject({
      provider: "claude-code",
      supported: false,
      authState: "missing",
      reason: "Provider authentication is required.",
      models: [],
    });
  });

  it("uses the exact timeout fallback without making the provider unsupported", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (args.includes("providers")) {
          const payload = catalog();
          payload.defaultProviderId = "claude-code";
          return payload;
        }
        if (args.at(-1) === "claude-code") {
          throw new TuttiIntegrationError("cli_timeout", "timed out");
        }
        return composer("codex");
      },
    });

    expect(result[1]).toMatchObject({
      supported: true,
      isDefault: true,
      reason: "Model discovery timed out; using the configured default.",
      models: [{ id: "default", label: "Default" }],
      defaultModelId: "default",
    });
  });

  it("does not fall back to standalone detection after a managed CLI failure", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await detectTuttiManagedProviders({
        context,
        descriptors: [...descriptors],
        runTuttiCli: async () => { throw new Error("unavailable"); },
      });
      expect(result).toEqual(descriptors.map((descriptor) => ({
        provider: descriptor.id,
        displayName: descriptor.displayName,
        supported: false,
        authState: "unknown",
        reason: "Managed provider catalog is unavailable.",
        models: [],
      })));
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "agent_acp_kit.managed_provider_catalog_unavailable",
        command: "tutti --json agent providers",
        errorCode: "cli_execution_failed",
        descriptorCount: descriptors.length,
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("logs unsupported catalog schemas before using the managed fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await detectTuttiManagedProviders({
        context,
        descriptors: [...descriptors],
        runTuttiCli: async () => ({ schemaVersion: 1, providers: [] }),
      });
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "agent_acp_kit.managed_provider_catalog_unavailable",
        errorCode: "unsupported_schema",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
