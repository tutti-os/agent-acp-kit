import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER,
  createManagedAgentDetectContextFromHeaders,
} from "../../src/core/managed-invocation.js";
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
    schemaVersion: 1,
    defaultAgentTargetId: "local:codex",
    agents: descriptors.map((provider) => ({
      id: `local:${provider.id}`,
      name: provider.displayName,
      provider: provider.id,
      availability: { status: "available", reasonCode: "", detail: "" },
    })),
  };
}

function composer(agentTargetId: string, provider: string) {
  return {
    schemaVersion: 2,
    agentTargetId,
    provider,
    effectiveSettings: { model: `${provider}-default` },
    modelConfig: {
      configurable: true,
      currentValue: `${provider}-default`,
      defaultValue: `${provider}-default`,
      options: [
        {
          id: "default",
          value: `${provider}-default`,
          label: `${provider} default`,
        },
      ],
    },
    permissionConfig: { configurable: false, defaultValue: "", modes: [] },
    reasoningConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
    speedConfig: {
      configurable: false,
      currentValue: "",
      defaultValue: "",
      options: [],
    },
  };
}

function composerForSelector(selector: string) {
  const provider = selector.replace(/^local:/u, "");
  return composer(selector, provider);
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("managed runtime detection", () => {
  it("inherits host environment for agent catalog and composer requests", async () => {
    vi.stubEnv("TUTTI_CLI", "/opt/tsh/app-runner-cli-shims/tutti");
    vi.stubEnv("TSH_WORKSPACE_ID", "workspace-1");
    vi.stubEnv("TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL", "ambient-secret");
    vi.stubEnv("TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL", "ambient-reverse-secret");
    const managedContext = createManagedAgentDetectContextFromHeaders(
      {
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER]: "request-secret",
      },
      { appDataDir: "/tmp/aimc-app-data" },
    );
    const childEnvs: Array<Readonly<NodeJS.ProcessEnv>> = [];
    await detectTuttiManagedProviders({
      context: managedContext!,
      descriptors: [...descriptors],
      runTuttiCli: async (args, options) => {
        childEnvs.push(options.env);
        return args.includes("list") ? catalog() : composerForSelector(args.at(-1)!);
      },
    });

    expect(childEnvs).toHaveLength(3);
    for (const env of childEnvs) {
      expect(env).toMatchObject({
        TUTTI_CLI: "/opt/tsh/app-runner-cli-shims/tutti",
        TSH_WORKSPACE_ID: "workspace-1",
        TUTTI_APP_DATA_DIR: "/tmp/aimc-app-data",
        TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL: "request-secret",
      });
      expect(env).not.toHaveProperty("TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL");
    }
  });

  it("loads agents once and starts eligible target composer requests concurrently", async () => {
    const calls: string[][] = [];
    const releases = new Map<string, (value: unknown) => void>();
    const runTuttiCli = vi.fn(async (args: string[]) => {
      calls.push(args);
      if (args.includes("list")) return catalog();
      const agentTargetId = args.at(-1)!;
      return await new Promise((resolve) => releases.set(agentTargetId, resolve));
    });

    const pending = detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli,
    });
    await vi.waitFor(() => expect(releases.size).toBe(2));
    releases.get("local:codex")!(composer("local:codex", "codex"));
    releases.get("local:claude-code")!(composer("local:claude-code", "claude-code"));
    const result = await pending;

    expect(calls.filter((args) => args.includes("list"))).toHaveLength(1);
    expect(calls.filter((args) => args.includes("composer-options"))).toHaveLength(2);
    expect(result).toMatchObject([
      {
        provider: "codex",
        supported: true,
        authState: "ok",
        defaultModelId: "codex-default",
        isDefault: true,
      },
      {
        provider: "claude-code",
        supported: true,
        authState: "ok",
        defaultModelId: "claude-code-default",
      },
    ]);
  });

  it("degrades only failed target model enumeration", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (args.includes("list")) return catalog();
        if (args.at(-1) === "local:claude-code") throw new Error("timeout");
        return composer("local:codex", "codex");
      },
    });
    expect(result[1]).toMatchObject({
      provider: "claude-code",
      supported: true,
      models: [{ id: "default", label: "Default" }],
      defaultModelId: "default",
    });
  });

  it("does not request composer options for an unavailable agent", async () => {
    const runTuttiCli = vi.fn(async (args: string[]) => {
      if (args.includes("list")) {
        const payload = catalog();
        payload.agents[1]!.availability = {
          status: "unavailable",
          reasonCode: "auth_required",
          detail: "Agent authentication is required.",
        };
        return payload;
      }
      return composerForSelector(args.at(-1)!);
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
    ).toEqual(["local:codex"]);
    expect(result[1]).toMatchObject({
      provider: "claude-code",
      supported: false,
      authState: "missing",
      reason: "Agent authentication is required.",
      models: [],
    });
  });

  it("preserves the daemon-selected default even when that agent is unavailable", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (args.includes("list")) {
          const payload = catalog();
          payload.defaultAgentTargetId = "local:claude-code";
          payload.agents[1]!.availability = {
            status: "unavailable",
            reasonCode: "auth_required",
            detail: "Agent authentication is required.",
          };
          return payload;
        }
        return composerForSelector(args.at(-1)!);
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

  it("uses the exact timeout fallback without disabling the runtime", async () => {
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        if (args.includes("list")) return catalog();
        if (args.at(-1) === "local:claude-code") {
          throw new TuttiIntegrationError("cli_timeout", "timed out");
        }
        return composer("local:codex", "codex");
      },
    });
    expect(result[1]).toMatchObject({
      supported: true,
      reason: "Model discovery timed out; using the configured default.",
      models: [{ id: "default", label: "Default" }],
      defaultModelId: "default",
    });
  });

  it("uses old provider commands when agent list is unavailable", async () => {
    const calls: string[][] = [];
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) => {
        calls.push(args);
        if (args.includes("list")) {
          throw new TuttiIntegrationError("unsupported_command", "unknown command");
        }
        if (args.includes("providers")) {
          return {
            schemaVersion: 2,
            defaultProviderId: "codex",
            providers: descriptors.map((provider) => ({
              providerId: provider.id,
              displayName: provider.displayName,
              agentTargetId: `local:${provider.id}`,
              availability: {
                status: "available",
                reasonCode: "",
                detail: "",
              },
            })),
          };
        }
        return {
          ...composer(`local:${args.at(-1)!}`, args.at(-1)!),
          schemaVersion: 1,
          agentTargetId: undefined,
        };
      },
    });
    expect(calls.filter((args) => args.includes("composer-options"))).toEqual([
      ["--json", "agent", "composer-options", "--provider", "codex"],
      ["--json", "agent", "composer-options", "--provider", "claude-code"],
    ]);
    expect(result.every((entry) => entry.supported)).toBe(true);
  });

  it("fails provider projection closed when multiple agents share a runtime", async () => {
    const payload = catalog();
    payload.agents.push({
      ...payload.agents[0]!,
      id: "team:codex-two",
    });
    const result = await detectTuttiManagedProviders({
      context,
      descriptors: [...descriptors],
      runTuttiCli: async (args) =>
        args.includes("list") ? payload : composerForSelector(args.at(-1)!),
    });
    expect(result[0]).toMatchObject({
      provider: "codex",
      supported: false,
      reason: "Multiple agents share this runtime; select an exact agent target.",
    });
  });

  it("does not fall back to standalone detection after CLI failures", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      const result = await detectTuttiManagedProviders({
        context,
        descriptors: [...descriptors],
        runTuttiCli: async () => {
          throw new Error("unavailable");
        },
      });
      expect(result).toEqual(
        descriptors.map((descriptor) => ({
          provider: descriptor.id,
          displayName: descriptor.displayName,
          supported: false,
          authState: "unknown",
          reason: "Managed agent catalog is unavailable.",
          models: [],
        })),
      );
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "agent_acp_kit.managed_agent_catalog_unavailable",
        command: "tutti --json agent list",
        errorCode: "cli_execution_failed",
      });
    } finally {
      warn.mockRestore();
    }
  });

  it("logs malformed new catalog schemas without protocol fallback", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    try {
      await detectTuttiManagedProviders({
        context,
        descriptors: [...descriptors],
        runTuttiCli: async () => ({ schemaVersion: 7, agents: [] }),
      });
      expect(JSON.parse(String(warn.mock.calls[0]?.[0]))).toMatchObject({
        event: "agent_acp_kit.managed_agent_catalog_unavailable",
        errorCode: "unsupported_schema",
      });
    } finally {
      warn.mockRestore();
    }
  });
});
