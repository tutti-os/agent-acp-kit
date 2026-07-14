import { afterEach, describe, expect, it, vi } from "vitest";

import {
  MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV,
  createDefaultLocalAgentRuntime,
  createFakeProvider,
  createLocalAgentRuntime,
  type AgentEvent,
  type AgentRunParams,
  type LocalAgentProviderPlugin,
  type RawAgentStream,
  type Transport,
} from "../../src/index.js";

describe("createLocalAgentRuntime", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("accepts provider aliases only at input and lists canonical ids", async () => {
    const permissions: AgentRunParams["permission"][] = [];
    const provider: LocalAgentProviderPlugin<"local-agent", "canonical"> = {
      id: "canonical",
      aliases: ["legacy"],
      displayName: "Canonical",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "canonical", version: "1" };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        permissions.push(params.permission);
        yield {
          type: "done",
          status: "completed",
          sessionId: String(params.runtimeProvider),
        };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });
    expect(runtime.listProviders()).toEqual([
      { id: "canonical", displayName: "Canonical", kind: "local-agent" },
    ]);
    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "alias-run",
      provider: "legacy" as "canonical",
      cwd: process.cwd(),
      prompt: "hello",
    })) {
      events.push(event);
    }
    expect(events[0]).toMatchObject({ type: "done", sessionId: "canonical" });
    expect(permissions).toEqual([{ semantic: "full-access" }]);
    for await (const _event of runtime.run({
      runId: "narrow-permission",
      provider: "canonical",
      cwd: process.cwd(),
      prompt: "hello",
      permission: { semantic: "locked-down" },
    })) {
      // Drain the provider stream.
    }
    expect(permissions).toEqual([{ semantic: "full-access" }, { semantic: "locked-down" }]);
  });

  it("rejects duplicate provider ids and aliases during construction", () => {
    const base = createFakeProvider();
    expect(() => createLocalAgentRuntime({ providers: [base, base] })).toThrow(
      "Duplicate local agent provider id: fake",
    );
    expect(() =>
      createLocalAgentRuntime({
        providers: [
          { ...base, id: "one", aliases: ["shared"] },
          { ...base, id: "two", aliases: ["shared"] },
        ],
      }),
    ).toThrow("Duplicate local agent provider alias shared");
    expect(() =>
      createLocalAgentRuntime({
        providers: [{ ...base, id: " spaced " }],
      }),
    ).toThrow("Local agent provider id must not contain surrounding whitespace");
  });

  it("detects registered providers and streams normalized agent events", async () => {
    const runtime = createLocalAgentRuntime({
      providers: [
        createFakeProvider({
          events: [
            { type: "status", status: "running" },
            { type: "text_delta", text: "hello" },
            { type: "done", status: "completed" },
          ],
        }),
      ],
    });

    await expect(runtime.detect()).resolves.toMatchObject([
      {
        provider: "fake",
        displayName: "Fake Local Agent",
        authState: "ok",
        supported: true,
      },
    ]);

    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "run_1",
      provider: "fake",
      cwd: process.cwd(),
      prompt: "Say hello",
    })) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "status", status: "running" },
      { type: "text_delta", text: "hello" },
      { type: "done", status: "completed", reason: "completed" },
    ]);
  });

  it("keeps managed detection when the default runtime uses custom providers", async () => {
    const provider = createFakeProvider();
    const detect = vi.spyOn(provider, "detect");
    const runtime = createDefaultLocalAgentRuntime({ providers: [provider] });

    await expect(
      runtime.detect({
        env: { TUTTI_CLI: "/definitely/missing/tutti" },
        managedAgentInvocation: {
          credential: "test-credential",
          cwd: "/workspace",
        },
      }),
    ).resolves.toEqual([
      {
        provider: "fake",
        displayName: "Fake Local Agent",
        supported: false,
        authState: "unknown",
        reason: "Managed agent catalog is unavailable.",
        models: [],
      },
    ]);
    expect(detect).not.toHaveBeenCalled();
  });

  it("forwards cancel to the active provider run", async () => {
    let releaseRun: (() => void) | undefined;
    const cancel = vi.fn();
    const provider: LocalAgentProviderPlugin<"local-agent", "cancelable"> = {
      id: "cancelable",
      displayName: "Cancelable Provider",
      kind: "local-agent",
      async detect() {
        return {
          authState: "ok",
          executablePath: "cancelable",
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      cancel,
      async *run(params) {
        await new Promise<void>((resolve) => {
          releaseRun = resolve;
          params.signal?.addEventListener("abort", () => resolve(), {
            once: true,
          });
        });
        yield { type: "done", status: "canceled", reason: "cancelled" };
      },
    };

    const runtime = createLocalAgentRuntime({ providers: [provider] });
    const iterator = runtime.run({
      runId: "run_cancel",
      provider: "cancelable",
      cwd: process.cwd(),
      prompt: "wait",
    });

    const first = iterator.next();
    await runtime.cancel("run_cancel");
    releaseRun?.();

    await expect(first).resolves.toEqual({
      done: false,
      value: { type: "done", status: "canceled", reason: "cancelled" },
    });
    expect(cancel).toHaveBeenCalledWith("run_cancel");
  });

  it("forwards cancel to the active transport handle", async () => {
    const cancel = vi.fn();
    let transportStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      transportStarted = resolve;
    });
    const provider: LocalAgentProviderPlugin<"local-agent", "transport-cancel"> = {
      id: "transport-cancel",
      displayName: "Transport Cancel Provider",
      kind: "local-agent",
      async detect() {
        return {
          authState: "ok",
          executablePath: "transport-cancel",
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      createAdapter() {
        return {
          async buildLaunchPlan(params) {
            return {
              args: [],
              command: "transport-cancel",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream: RawAgentStream) {
            for await (const item of stream) {
              yield item as AgentEvent;
            }
          },
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const transport: Transport = {
      kind: "plain",
      run() {
        transportStarted();
        return Object.assign(
          (async function* () {
            await new Promise((resolve) => setTimeout(resolve, 50));
            yield { type: "done", status: "completed" };
          })(),
          { cancel },
        );
      },
    };

    const runtime = createLocalAgentRuntime({
      providers: [provider],
      transports: [transport],
    });
    const iterator = runtime.run({
      runId: "run_transport_cancel",
      provider: "transport-cancel",
      cwd: process.cwd(),
      prompt: "wait",
    });

    const first = iterator.next();
    await started;
    await runtime.cancel("run_transport_cancel");
    await first.catch(() => undefined);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("isolates provider detection failures and caches successful results", async () => {
    const detectOk = vi.fn(async () => ({
      authState: "ok" as const,
      executablePath: "ok",
      version: "1.0.0",
    }));
    const okProvider: LocalAgentProviderPlugin<"local-agent", "ok"> = {
      id: "ok",
      displayName: "OK Provider",
      kind: "local-agent",
      detect: detectOk,
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const badProvider: LocalAgentProviderPlugin<"local-agent", "bad"> = {
      ...okProvider,
      id: "bad",
      displayName: "Bad Provider",
      async detect() {
        throw new Error("boom");
      },
    };

    const runtime = createLocalAgentRuntime({
      providers: [okProvider, badProvider],
    });

    await expect(runtime.detect()).resolves.toMatchObject([
      { provider: "ok", authState: "ok", supported: true },
      { provider: "bad", authState: "unknown", supported: false },
    ]);
    await runtime.detect();

    expect(detectOk).toHaveBeenCalledTimes(1);
    await runtime.detect({ refresh: true });
    expect(detectOk).toHaveBeenCalledTimes(2);
  });

  it("never calls provider detection for managed discovery", async () => {
    vi.stubEnv("CODEX_HOME", "/tmp/user-codex-home");
    vi.stubEnv("CLAUDE_CONFIG_DIR", "/tmp/user-claude-config");
    const calls: Array<{
      claudeConfigDir?: string;
      codexHome?: string;
      credential?: string;
      cwd?: string;
      home?: string;
      leaked?: string;
      path?: string;
    }> = [];
    const detect = vi.fn(async (context) => {
      calls.push({
        claudeConfigDir: context?.env?.CLAUDE_CONFIG_DIR,
        codexHome: context?.env?.CODEX_HOME,
        credential: context?.env?.[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV],
        cwd: context?.cwd,
        home: context?.env?.HOME,
        leaked: process.env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV],
        path: context?.env?.PATH,
      });
      return {
        authState: "ok" as const,
        executablePath: "codex",
        supported: true,
        version: "1.0.0",
      };
    });
    const provider: LocalAgentProviderPlugin<"local-agent", "codex"> = {
      id: "codex",
      displayName: "Codex",
      kind: "local-agent",
      detect,
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });

    await runtime.detect({
      managedAgentInvocation: {
        credential: "managed-detect-secret-1",
        cwd: "/workspace/project",
      },
    });
    await runtime.detect({
      managedAgentInvocation: {
        credential: "managed-detect-secret-2",
        cwd: "/workspace/project/subdir",
      },
    });

    expect(detect).not.toHaveBeenCalled();
    expect(calls).toEqual([]);
    expect(process.env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]).not.toBe(
      "managed-detect-secret-1",
    );
    expect(process.env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]).not.toBe(
      "managed-detect-secret-2",
    );
  });

  it("does not forward the user's Tutti Agent home into managed runs", async () => {
    vi.stubEnv("TUTTI_AGENT_HOME", "/tmp/user-tutti-agent-home");
    let receivedHome: string | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "tutti-agent"> = {
      id: "tutti-agent",
      displayName: "Tutti Agent",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "tutti-agent", version: "1" };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: true,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        receivedHome = params.env?.TUTTI_AGENT_HOME;
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });

    for await (const _event of runtime.run({
      runId: "managed-tutti-agent-home",
      provider: "tutti-agent",
      cwd: "/tmp/app-cwd",
      prompt: "hello",
      managedAgentInvocation: {
        credential: "managed-tutti-agent-secret",
        cwd: "/tmp/managed-tutti-agent-run",
      },
    })) {
      // Drain the provider stream.
    }

    expect(receivedHome).toBeUndefined();
    expect(process.env.TUTTI_AGENT_HOME).toBe("/tmp/user-tutti-agent-home");
  });

  it("does not probe unsupported plugins during managed discovery", async () => {
    let receivedContext: unknown;
    const provider: LocalAgentProviderPlugin<"local-agent", "nextop"> = {
      id: "nextop",
      displayName: "Nextop",
      kind: "local-agent",
      async detect(context) {
        receivedContext = context;
        return {
          authState: "ok",
          executablePath: "nextop",
          supported: true,
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };

    await createLocalAgentRuntime({ providers: [provider] }).detect({
      env: {
        KEEP: "1",
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "should-not-forward",
      },
      managedAgentInvocation: {
        credential: "managed-nextop-secret",
        cwd: "/workspace/project",
      },
    });

    expect(receivedContext).toBeUndefined();
  });

  it("does not probe unsupported plugins during managed discovery regardless of cwd", async () => {
    let receivedContext: unknown;
    const detect = vi.fn(async () => ({
      authState: "ok" as const,
      executablePath: "nextop",
      supported: true,
      version: "1.0.0",
    }));
    const provider: LocalAgentProviderPlugin<"local-agent", "nextop"> = {
      id: "nextop",
      displayName: "Nextop",
      kind: "local-agent",
      detect(context) {
        receivedContext = context;
        return detect(context);
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };

    await createLocalAgentRuntime({ providers: [provider] }).detect({
      managedAgentInvocation: {
        credential: "managed-secret",
        cwd: "/tmp/not-workspace",
      },
    });

    expect(detect).not.toHaveBeenCalled();
    expect(receivedContext).toBeUndefined();
  });

  it("injects managed invocation env and cwd into runtime launch plans", async () => {
    let adapterParams: AgentRunParams<"local-agent", "codex"> | undefined;
    let transportPlan: Parameters<Transport["run"]>[0] | undefined;

    function providerFactory(): LocalAgentProviderPlugin<"local-agent", "codex"> {
      const provider: LocalAgentProviderPlugin<"local-agent", "codex"> = {
        id: "codex",
        displayName: "Codex",
        kind: "local-agent",
        async detect() {
          return {
            authState: "ok",
            executablePath: "codex",
            supported: true,
            version: "1.0.0",
          };
        },
        capabilities() {
          return {
            cancel: true,
            nativeResume: false,
            streaming: true,
            toolGateway: false,
            maxConcurrentRuns: 1,
          };
        },
        async buildLaunchPlan() {
          throw new Error("not used");
        },
        createAdapter() {
          return {
            async buildLaunchPlan(params) {
              adapterParams = params;
              return {
                args: [],
                command: "codex",
                cwd: "/tmp/adapter-ignored-cwd",
                env: { KEEP: "1" },
                fallbackPlan: {
                  args: [],
                  command: "codex",
                  cwd: "/tmp/fallback",
                  prompt: params.prompt,
                  promptInput: "stdin",
                },
                prompt: params.prompt,
                promptInput: "stdin",
                redactionSecrets: ["existing-secret"],
                transport: "plain",
              };
            },
            capabilities: () => provider.capabilities(),
            parseEvents: async function* (stream: RawAgentStream) {
              for await (const item of stream) {
                yield item as AgentEvent;
              }
            },
          };
        },
        async *run() {
          throw new Error("not used");
        },
      };
      return provider;
    }

    const runtime = createLocalAgentRuntime({
      providers: [providerFactory()],
      transports: [
        {
          kind: "plain",
          async *run(plan) {
            transportPlan = plan;
            yield { type: "done", status: "completed" };
          },
        },
      ],
    });

    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "run_managed",
      provider: "codex",
      cwd: "/tmp/input-cwd",
      prompt: "hello",
      managedAgentInvocation: {
        credential: "managed-run-secret",
        cwd: "/workspace/project",
      },
    })) {
      events.push(event);
    }

    expect(adapterParams).toMatchObject({
      cwd: "/workspace/project",
      env: {
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-run-secret",
      },
    });
    expect(transportPlan).toMatchObject({
      cwd: "/workspace/project",
      env: {
        KEEP: "1",
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-run-secret",
      },
      fallbackPlan: {
        cwd: "/workspace/project",
        env: {
          [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-run-secret",
        },
      },
      redactionSecrets: ["existing-secret", "managed-run-secret"],
    });
    expect(events).toEqual([{ type: "done", status: "completed", reason: "completed" }]);
    expect(process.env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]).not.toBe("managed-run-secret");
  });

  it("runs managed invocations from cwd outside /workspace", async () => {
    let receivedParams: AgentRunParams<"local-agent", "codex"> | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "codex"> = {
      id: "codex",
      displayName: "Codex",
      kind: "local-agent",
      async detect() {
        return {
          authState: "ok",
          executablePath: "codex",
          supported: true,
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        receivedParams = params;
        yield { type: "done", status: "completed" as const };
      },
    };
    const runtime = createLocalAgentRuntime({
      providers: [provider],
    });

    const collect = async () => {
      for await (const _event of runtime.run({
        runId: "run_bad_managed_cwd",
        provider: "codex",
        cwd: "/tmp/input-cwd",
        prompt: "hello",
        managedAgentInvocation: {
          credential: "managed-secret",
          cwd: "/tmp/not-workspace",
        },
      })) {
        // drain
      }
    };

    await expect(collect()).resolves.toBeUndefined();
    expect(receivedParams).toMatchObject({
      cwd: "/tmp/not-workspace",
      env: {
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-secret",
      },
      managedAgentInvocation: {
        credential: "managed-secret",
        cwd: "/tmp/not-workspace",
      },
    });
  });

  it("rejects managed invocation for unsupported run providers", async () => {
    const provider: LocalAgentProviderPlugin<"local-agent", "nextop"> = {
      id: "nextop",
      displayName: "Nextop",
      kind: "local-agent",
      async detect() {
        return {
          authState: "ok",
          executablePath: "nextop",
          supported: true,
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const runtime = createLocalAgentRuntime({
      providers: [provider],
    });

    const collect = async () => {
      for await (const _event of runtime.run({
        runId: "run_nextop_managed",
        provider: "nextop",
        cwd: "/workspace/project",
        prompt: "hello",
        managedAgentInvocation: {
          credential: "managed-secret",
          cwd: "/workspace/project",
        },
      })) {
        // drain
      }
    };

    await expect(collect()).rejects.toThrow(/codex, claude-code, tutti-agent/);
  });

  it("runs provider adapters through the transport pipeline", async () => {
    const calls: string[] = [];
    const provider: LocalAgentProviderPlugin<"local-agent", "pipe"> = {
      id: "pipe",
      displayName: "Pipeline Provider",
      kind: "local-agent",
      async detect() {
        return {
          authState: "ok",
          executablePath: "pipe",
          version: "1.0.0",
        };
      },
      capabilities() {
        return {
          cancel: true,
          nativeResume: false,
          streaming: true,
          toolGateway: false,
          maxConcurrentRuns: 1,
        };
      },
      async buildLaunchPlan(params) {
        calls.push(`legacy:${params.runId}`);
        return {
          args: [],
          command: "pipe",
          cwd: params.cwd,
          prompt: params.prompt,
          promptInput: "stdin",
          transport: "plain",
        };
      },
      createAdapter() {
        return {
          buildLaunchPlan: async (params) => {
            calls.push(`adapter:${params.runId}:${params.metadata?.source ?? "none"}`);
            return {
              args: [],
              command: "pipe",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream: RawAgentStream) {
            calls.push("parse");
            for await (const item of stream) {
              yield item as AgentEvent;
            }
          },
        };
      },
      async *run() {
        throw new Error("provider.run should not be used when createAdapter is available");
      },
    };
    const transport: Transport = {
      kind: "plain",
      async *run(plan) {
        calls.push(`transport:${plan.prompt}`);
        yield { type: "tool_result", id: "tool_1", name: "probe" };
        yield { type: "done", reason: "completed" };
      },
    };

    const runtime = createLocalAgentRuntime({
      providers: [provider],
      transports: [transport],
    });
    const events: AgentEvent[] = [];
    for await (const event of runtime.run({
      runId: "run_pipe",
      provider: "pipe",
      cwd: process.cwd(),
      prompt: "hello",
      metadata: { source: "test" },
    })) {
      events.push(event);
    }

    expect(calls).toEqual(["adapter:run_pipe:test", "parse", "transport:hello"]);
    expect(events).toEqual([
      {
        type: "tool_result",
        id: "tool_1",
        name: "probe",
        status: "completed",
        isError: false,
      },
      {
        type: "done",
        reason: "completed",
        status: "completed",
      },
    ]);
  });
});
