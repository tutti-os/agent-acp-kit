import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER,
  type AgentRunInput,
  type LocalAgentRuntime,
} from "../../src/index.js";
import {
  createTuttiAgentAppRuntime,
  TuttiAgentAppRuntimeError,
} from "../../src/tutti/index.js";
import type { TuttiWorkspaceAppAgentClient } from "../../src/tutti/workspace-app-client.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) =>
      rm(directory, { force: true, recursive: true }),
    ),
  );
});

describe("createTuttiAgentAppRuntime", () => {
  it("uses standalone detection when Tutti app environment is absent", async () => {
    const runtime = createRuntime({
      providers: [
        { id: "claude", displayName: "Claude Code" },
        { id: "cursor", displayName: "Cursor Agent" },
      ],
      detections: [
        {
          provider: "claude",
          displayName: "Claude Code",
          result: {
            authState: "ok",
            executablePath: "/bin/claude",
            models: [{ id: "sonnet", label: "Sonnet" }],
            version: "1.0.0",
          },
        },
        {
          provider: "cursor",
          displayName: "Cursor Agent",
          result: null,
        },
      ],
    });
    const agents = createTuttiAgentAppRuntime({
      runtime,
      env: {},
    });

    await expect(
      agents.getProviderCatalog({ preferredProviderId: "claude-code" }),
    ).resolves.toEqual({
      source: "standalone",
      status: "ready",
      capturedAt: null,
      defaultProviderId: null,
      selectedProviderId: "claude-code",
      providers: [
        {
          id: "claude-code",
          displayName: "Claude Code",
          available: true,
          authState: "authenticated",
          models: [{ id: "sonnet", label: "Sonnet" }],
        },
        {
          id: "cursor",
          displayName: "Cursor Agent",
          available: false,
          reasonCode: "not_installed",
          authState: "unknown",
          models: [],
        },
      ],
    });
  });

  it("preserves Tutti visibility and intersects ready status with runtime support", async () => {
    const runtime = createRuntime({
      providers: [
        { id: "codex", displayName: "Codex" },
        { id: "claude", displayName: "Claude Code" },
      ],
    });
    const client: TuttiWorkspaceAppAgentClient = {
      async getProviderStatuses() {
        return {
          capturedAt: "2026-07-10T00:00:00Z",
          defaultProvider: "codex",
          providers: [
            {
              provider: "codex",
              availability: { status: "ready" },
              auth: { status: "authenticated" },
            },
            {
              provider: "claude-code",
              availability: {
                status: "auth_required",
                reasonCode: "login_required",
              },
              auth: { status: "required" },
            },
            {
              provider: "opencode",
              availability: { status: "ready" },
              auth: { status: "authenticated" },
            },
          ],
        };
      },
      async getProviderComposerOptions(providerId) {
        return {
          provider: providerId,
          modelConfig: {
            configurable: true,
            currentValue: "gpt-5",
            options: [{ id: "gpt-5", value: "gpt-5", label: "GPT-5" }],
          },
          reasoningConfig: { configurable: false, options: [] },
        };
      },
    };
    const agents = createTuttiAgentAppRuntime({
      runtime,
      client,
      mode: "tutti",
      env: tuttiEnvironment(),
    });

    const catalog = await agents.getProviderCatalog({
      preferredProviderId: "claude-code",
    });

    expect(catalog.selectedProviderId).toBe("codex");
    expect(catalog.providers).toEqual([
      expect.objectContaining({
        id: "codex",
        available: true,
        composerStatus: "ready",
        models: [{ id: "gpt-5", label: "GPT-5" }],
      }),
      expect.objectContaining({
        id: "claude-code",
        available: false,
        reasonCode: "login_required",
      }),
      expect.objectContaining({
        id: "opencode",
        available: false,
        reasonCode: "kit_runtime_unavailable",
      }),
    ]);
  });

  it("keeps a composer failure local to one ready provider", async () => {
    const runtime = createRuntime({
      providers: [
        { id: "codex", displayName: "Codex" },
        { id: "claude", displayName: "Claude Code" },
      ],
    });
    const client: TuttiWorkspaceAppAgentClient = {
      async getProviderStatuses() {
        return {
          capturedAt: null,
          defaultProvider: "codex",
          providers: [
            {
              provider: "codex",
              availability: { status: "ready" },
              auth: { status: "authenticated" },
            },
            {
              provider: "claude-code",
              availability: { status: "ready" },
              auth: { status: "authenticated" },
            },
          ],
        };
      },
      async getProviderComposerOptions(providerId) {
        if (providerId === "claude-code") throw new Error("unavailable");
        return {
          provider: providerId,
          modelConfig: { configurable: false, options: [] },
          reasoningConfig: { configurable: false, options: [] },
        };
      },
    };
    const agents = createTuttiAgentAppRuntime({
      runtime,
      client,
      mode: "tutti",
      env: tuttiEnvironment(),
    });

    const catalog = await agents.getProviderCatalog();

    expect(catalog.status).toBe("ready");
    expect(catalog.providers[0]).toMatchObject({ composerStatus: "ready" });
    expect(catalog.providers[1]).toMatchObject({
      available: true,
      composerStatus: "unavailable",
    });
  });

  it("calls only workspace-app scoped routes with the server token", async () => {
    const requests: Array<{ url: string; authorization: string | null }> = [];
    const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requests.push({
        url,
        authorization: new Headers(init?.headers).get("authorization"),
      });
      if (url.endsWith("/agent-providers/status")) {
        return Response.json({
          capturedAt: "2026-07-10T00:00:00Z",
          defaultProvider: "codex",
          providers: [
            {
              provider: "codex",
              availability: { status: "ready", reasonCode: null },
              auth: { status: "authenticated" },
            },
          ],
        });
      }
      return Response.json({
        provider: "codex",
        modelConfig: {
          configurable: true,
          options: [{ id: "gpt-5", value: "gpt-5", label: "GPT-5" }],
        },
        reasoningConfig: { configurable: false, options: [] },
      });
    });
    const agents = createTuttiAgentAppRuntime({
      runtime: createRuntime({
        providers: [{ id: "codex", displayName: "Codex" }],
      }),
      fetch: fetchMock as typeof fetch,
      mode: "tutti",
      env: tuttiEnvironment({
        TUTTI_APP_ID: "app/one",
        TUTTI_WORKSPACE_ID: "workspace one",
      }),
    });

    await agents.getProviderCatalog();

    expect(requests).toHaveLength(2);
    expect(requests[0]?.url).toContain(
      "/v1/workspaces/workspace%20one/apps/app%2Fone/agent-providers/status",
    );
    expect(requests[1]?.url).toContain(
      "/v1/workspaces/workspace%20one/apps/app%2Fone/agent-providers/codex/composer-options",
    );
    expect(requests.every((request) => request.authorization === "Bearer secret-token")).toBe(true);
    expect(requests.some((request) => request.url.includes("/v1/agent-providers"))).toBe(false);
  });

  it("prepares local and managed runs without exposing credentials", async () => {
    const appDataDir = await mkdtemp(path.join(tmpdir(), "agent-acp-kit-app-"));
    temporaryDirectories.push(appDataDir);
    const capturedRuns: AgentRunInput[] = [];
    const runtime = createRuntime({
      providers: [{ id: "claude", displayName: "Claude Code" }],
      capturedRuns,
    });
    const agents = createTuttiAgentAppRuntime({
      runtime,
      mode: "standalone",
      env: { TUTTI_APP_DATA_DIR: appDataDir },
    });

    const local = await agents.prepareRun({
      providerId: "claude-code",
      runId: "local-run",
      localCwd: "/tmp/local-project",
    });
    expect(local).toMatchObject({
      providerId: "claude-code",
      cwd: "/tmp/local-project",
    });
    expect(local).not.toHaveProperty("managedAgentInvocation");
    await collect(local.execute({ prompt: "local" }));

    const managed = await agents.prepareRun({
      headers: {
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER]: "managed-secret",
      },
      providerId: "claude-code",
      runId: "managed-run",
      localCwd: "/tmp/local-project",
    });
    expect(managed.cwd).toContain(appDataDir);
    expect(managed).not.toHaveProperty("managedAgentInvocation");
    await collect(managed.execute({ prompt: "managed" }));
    expect(() => managed.execute({ prompt: "again" })).toThrowError(
      expect.objectContaining({ code: "prepared_run_already_started" }),
    );

    expect(capturedRuns[0]).toMatchObject({
      provider: "claude",
      cwd: "/tmp/local-project",
    });
    expect(capturedRuns[0]).not.toHaveProperty("managedAgentInvocation");
    expect(capturedRuns[1]).toMatchObject({
      provider: "claude",
      managedAgentInvocation: { credential: "managed-secret" },
    });
  });

  it("rejects partial Tutti environment and unsupported managed providers", async () => {
    expect(() =>
      createTuttiAgentAppRuntime({
        env: { TUTTI_API_BASE_URL: "http://127.0.0.1:9944" },
      }),
    ).toThrowError(
      expect.objectContaining({ code: "incomplete_tutti_app_environment" }),
    );

    const agents = createTuttiAgentAppRuntime({
      runtime: createRuntime({
        providers: [{ id: "cursor", displayName: "Cursor Agent" }],
      }),
      mode: "standalone",
      env: {},
    });
    await expect(
      agents.prepareRun({
        headers: {
          [MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER]: "managed-secret",
        },
        providerId: "cursor",
        runId: "managed-cursor",
        localCwd: "/tmp/local-project",
      }),
    ).rejects.toBeInstanceOf(TuttiAgentAppRuntimeError);
    await expect(
      agents.prepareRun({
        headers: {
          [MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER]: "managed-secret",
        },
        providerId: "cursor",
        runId: "managed-cursor",
        localCwd: "/tmp/local-project",
      }),
    ).rejects.toMatchObject({ code: "managed_provider_unsupported" });
  });
});

function createRuntime(input: {
  providers: Array<{ id: string; displayName: string }>;
  detections?: Awaited<ReturnType<LocalAgentRuntime["detect"]>>;
  capturedRuns?: AgentRunInput[];
}): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    async detect() {
      return input.detections ?? [];
    },
    listProviders() {
      return input.providers.map((provider) => ({
        ...provider,
        kind: "local-agent",
      }));
    },
    async *run(runInput) {
      input.capturedRuns?.push(runInput);
      yield { type: "done", status: "completed", reason: "completed" };
    },
  };
}

function tuttiEnvironment(
  overrides: Record<string, string> = {},
): Record<string, string> {
  return {
    TUTTI_API_BASE_URL: "http://127.0.0.1:9944",
    TUTTI_APP_ID: "app-one",
    TUTTI_APP_SERVER_TOKEN: "secret-token",
    TUTTI_WORKSPACE_ID: "workspace-one",
    ...overrides,
  };
}

async function collect(events: AsyncIterable<unknown>) {
  const collected = [];
  for await (const event of events) collected.push(event);
  return collected;
}
