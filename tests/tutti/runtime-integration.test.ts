import { describe, expect, it, vi } from "vitest";

import type { RuntimeAgentDescriptor } from "../../src/runtime/create-runtime.js";
import { createTuttiRuntimeIntegration } from "../../src/tutti/runtime-integration.js";

const descriptors: RuntimeAgentDescriptor<"local-agent", string>[] = [
  {
    id: "codex",
    displayName: "Codex",
    kind: "local-agent",
    requiresKnownAuth: false,
  },
  {
    id: "claude-code",
    displayName: "Claude Code",
    kind: "local-agent",
    requiresKnownAuth: true,
  },
];

function catalog() {
  return {
    schemaVersion: 1,
    defaultAgentTargetId: "team:writer",
    agents: [
      {
        id: "team:writer",
        name: "Writer",
        provider: "codex",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
      {
        id: "team:reviewer",
        name: "Reviewer",
        provider: "codex",
        availability: { status: "available", reasonCode: "", detail: "" },
      },
      {
        id: "local:claude-code",
        name: "Claude Code",
        provider: "claude-code",
        availability: {
          status: "unavailable",
          reasonCode: "auth_required",
          detail: "Provider authentication is required.",
        },
      },
    ],
  };
}

function composer(agentTargetId: string) {
  const model = agentTargetId === "team:writer" ? "writer-model" : "reviewer-model";
  return {
    schemaVersion: 2,
    agentTargetId,
    providerId: "codex",
    effectiveSettings: { model },
    modelConfig: {
      configurable: true,
      currentValue: model,
      defaultValue: model,
      options: [{ id: model, value: model, label: model }],
    },
    permissionConfig: {
      configurable: true,
      defaultValue: "auto",
      modes: [{ id: "auto", label: "Auto", semantic: "auto" }],
    },
    reasoningConfig: {
      configurable: true,
      currentValue: "high",
      defaultValue: "medium",
      options: [{ id: "high", value: "high", label: "High" }],
    },
    speedConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
  };
}

describe("Tutti-aware runtime integration", () => {
  it("returns exact Agent Targets and target-scoped models from one detect call", async () => {
    const calls: string[][] = [];
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) return catalog();
        const target = args[args.indexOf("--agent-id") + 1]!;
        return composer(target);
      },
    });

    const detected = await integration.detect({
      descriptors,
      context: { cwd: "/workspace/project" },
    });

    expect(detected).toMatchObject([
      {
        agentTargetId: "team:writer",
        provider: "codex",
        displayName: "Writer",
        supported: true,
        isDefault: true,
        defaultModelId: "writer-model",
        models: [{ id: "writer-model", label: "writer-model" }],
      },
      {
        agentTargetId: "team:reviewer",
        provider: "codex",
        supported: true,
        defaultModelId: "reviewer-model",
      },
      {
        agentTargetId: "local:claude-code",
        provider: "claude-code",
        supported: false,
        authState: "missing",
        models: [],
      },
    ]);
    expect(calls.filter((args) => args.includes("list"))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("composer-options"))).toHaveLength(2);
  });

  it("single-flights and caches Tutti detection until refresh", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) =>
      args.includes("list") ? catalog() : composer(args[args.indexOf("--agent-id") + 1]!),
    );
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const input = { descriptors, context: { cwd: "/workspace/project" } };

    await Promise.all([integration.detect(input), integration.detect(input)]);
    expect(runTuttiCli.mock.calls.filter(([args]) => args.includes("list"))).toHaveLength(1);

    await integration.detect({ ...input, context: { ...input.context, refresh: true } });
    expect(runTuttiCli.mock.calls.filter(([args]) => args.includes("list"))).toHaveLength(2);
  });

  it("reuses workspace and exact-target caches when project cwd changes", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) =>
      args.includes("list") ? catalog() : composer(args[args.indexOf("--agent-id") + 1]!),
    );
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const env = {
      TUTTI_CLI: "/opt/tsh/bundle/bin/tutti",
      TUTTI_WORKSPACE_ID: "workspace-1",
    };

    await integration.detect({ descriptors, context: { cwd: "/workspace", env } });
    await integration.detect({
      descriptors,
      context: { cwd: "/workspace/.tsh/apps/data/app-1/projects/project-1", env },
    });

    expect(runTuttiCli.mock.calls.filter(([args]) => args.includes("list"))).toHaveLength(1);
    expect(runTuttiCli.mock.calls.filter(([args]) => args.includes("composer-options"))).toHaveLength(2);
  });

  it("reuses the exact-target composer cache during runtime preparation", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) =>
      args.includes("list") ? catalog() : composer(args[args.indexOf("--agent-id") + 1]!),
    );
    const integration = createTuttiRuntimeIntegration({ runTuttiCli });
    const env = {
      TUTTI_CLI: "/opt/tsh/bundle/bin/tutti",
      TUTTI_WORKSPACE_ID: "workspace-1",
    };
    await integration.detect({ descriptors, context: { cwd: "/workspace", env } });

    await integration.prepareRun({
      descriptors,
      env,
      run: {
        agentTargetId: "team:writer",
        runId: "run-cached-target",
        provider: "codex",
        cwd: "/workspace/.tsh/apps/data/app-1/projects/project-1",
        prompt: "hello",
      },
    });

    expect(runTuttiCli.mock.calls.filter(([args]) => args.includes("list"))).toHaveLength(1);
    expect(
      runTuttiCli.mock.calls.filter(
        ([args]) => args.includes("composer-options") && args.includes("team:writer"),
      ),
    ).toHaveLength(1);
  });

  it("applies target-scoped composer defaults before runtime launch", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) =>
        args.includes("list") ? catalog() : composer("team:writer"),
    });
    const prepared = await integration.prepareRun({
      descriptors,
      env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
      run: {
        agentTargetId: "team:writer",
        runId: "run-1",
        provider: "codex",
        cwd: "/workspace/project",
        prompt: "hello",
      },
    });
    expect(prepared).toMatchObject({
      model: "writer-model",
      reasoning: "high",
      permission: { semantic: "auto", modeId: "auto" },
    });
  });

  it("rejects provider-only runs when Tutti CLI is active", async () => {
    const integration = createTuttiRuntimeIntegration();
    await expect(
      integration.prepareRun({
        descriptors,
        env: { TUTTI_CLI: "/usr/bin/tutti-cli" },
        run: {
          runId: "run-provider-only",
          provider: "codex",
          cwd: "/workspace/project",
          prompt: "hello",
        },
      }),
    ).rejects.toThrow("exact agentTargetId");
  });

  it("does not activate Tutti behavior without a configured CLI", async () => {
    const integration = createTuttiRuntimeIntegration();
    await expect(
      integration.detect({ descriptors, context: { env: { TUTTI_CLI: "" } } }),
    ).resolves.toBeUndefined();
  });

  it("fails closed without inventing standalone targets when the Tutti catalog fails", async () => {
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async () => {
        throw new Error("catalog unavailable");
      },
    });

    await expect(
      integration.detect({
        descriptors,
        context: { env: { TUTTI_CLI: "/usr/bin/tutti-cli" } },
      }),
    ).resolves.toEqual([]);
  });

  it("retries after a transient Tutti catalog failure instead of caching the empty result", async () => {
    let catalogAttempts = 0;
    const integration = createTuttiRuntimeIntegration({
      runTuttiCli: async (args) => {
        if (args.includes("list") && catalogAttempts++ === 0) {
          throw new Error("temporary catalog failure");
        }
        return args.includes("list")
          ? catalog()
          : composer(args[args.indexOf("--agent-id") + 1]!);
      },
    });
    const input = {
      descriptors,
      context: { env: { TUTTI_CLI: "/usr/bin/tutti-cli" } },
    };

    await expect(integration.detect(input)).resolves.toEqual([]);
    await expect(integration.detect(input)).resolves.toHaveLength(3);
    expect(catalogAttempts).toBe(2);
  });
});
