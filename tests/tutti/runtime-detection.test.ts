import { describe, expect, it, vi } from "vitest";

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
      { provider: "codex", supported: true, authState: "ok", defaultModelId: "codex-default" },
      { provider: "claude-code", supported: true, authState: "ok", defaultModelId: "claude-code-default" },
    ]);
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

  it("does not fall back to standalone detection after a managed CLI failure", async () => {
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
  });
});
