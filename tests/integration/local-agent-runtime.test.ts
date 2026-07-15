import { describe, expect, it, vi } from "vitest";

import {
  createFakeProvider,
  createLocalAgentRuntime,
  type AgentEvent,
  type AgentRunParams,
  type LocalAgentProviderPlugin,
  type RawAgentStream,
  type Transport,
} from "../../src/index.js";

describe("createLocalAgentRuntime", () => {
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
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        permissions.push(params.permission);
        yield { type: "done", status: "completed", sessionId: String(params.runtimeProvider) };
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

  it("passes direct cwd and the VM source Codex home to the provider", async () => {
    let received: AgentRunParams<"local-agent", "codex"> | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "codex"> = {
      id: "codex",
      displayName: "Codex",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "codex", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: true };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      async *run(params) {
        received = params;
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });

    for await (const _event of runtime.run({
      runId: "direct-run",
      provider: "codex",
      cwd: "/workspace/project",
      prompt: "hello",
      env: {
        CODEX_HOME: "/home/tsh-runtime/.codex",
        TMPDIR: "/workspace/.tsh/apps/runtimes/runtime-1/tmp",
      },
    })) {
      // Drain the provider stream.
    }

    expect(received).toMatchObject({
      cwd: "/workspace/project",
      env: {
        CODEX_HOME: "/home/tsh-runtime/.codex",
        TMPDIR: "/workspace/.tsh/apps/runtimes/runtime-1/tmp",
      },
    });
  });

  it("forwards cancellation to the active provider", async () => {
    let release: (() => void) | undefined;
    const cancel = vi.fn();
    const provider: LocalAgentProviderPlugin<"local-agent", "cancelable"> = {
      id: "cancelable",
      displayName: "Cancelable",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "cancelable", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
      },
      async buildLaunchPlan() {
        throw new Error("not used");
      },
      cancel,
      async *run() {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        yield { type: "done", status: "completed" };
      },
    };
    const runtime = createLocalAgentRuntime({ providers: [provider] });
    const consume = (async () => {
      for await (const _event of runtime.run({
        runId: "cancel-run",
        provider: "cancelable",
        cwd: process.cwd(),
        prompt: "wait",
      })) {
        // Drain.
      }
    })();

    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await runtime.cancel("cancel-run");
    release?.();
    await consume;
    expect(cancel).toHaveBeenCalledWith("cancel-run");
  });

  it("forwards cancellation to the active transport handle", async () => {
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
        return { authState: "ok", executablePath: "transport-cancel", version: "1.0.0" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
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
            for await (const item of stream) yield item as AgentEvent;
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

    const runtime = createLocalAgentRuntime({ providers: [provider], transports: [transport] });
    const first = runtime
      .run({
        runId: "run_transport_cancel",
        provider: "transport-cancel",
        cwd: process.cwd(),
        prompt: "wait",
      })
      .next();

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
        return { cancel: true, nativeResume: false };
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
    const runtime = createLocalAgentRuntime({ providers: [okProvider, badProvider] });

    await expect(runtime.detect()).resolves.toMatchObject([
      { provider: "ok", authState: "ok", supported: true },
      { provider: "bad", authState: "unknown", supported: false },
    ]);
    await runtime.detect();
    expect(detectOk).toHaveBeenCalledTimes(1);
    await runtime.detect({ refresh: true });
    expect(detectOk).toHaveBeenCalledTimes(2);
  });

  it("runs provider adapters through the transport pipeline", async () => {
    let adapterParams: AgentRunParams<"local-agent", "pipe"> | undefined;
    let transportPlan: Parameters<Transport["run"]>[0] | undefined;
    const provider: LocalAgentProviderPlugin<"local-agent", "pipe"> = {
      id: "pipe",
      displayName: "Pipeline",
      kind: "local-agent",
      async detect() {
        return { authState: "ok", executablePath: "pipe", version: "1" };
      },
      capabilities() {
        return { cancel: true, nativeResume: false };
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
              command: "pipe",
              cwd: params.cwd,
              prompt: params.prompt,
              promptInput: "stdin",
              transport: "plain",
            };
          },
          capabilities: () => provider.capabilities(),
          parseEvents: async function* (stream: RawAgentStream) {
            for await (const item of stream) yield item as AgentEvent;
          },
        };
      },
      async *run() {
        throw new Error("not used");
      },
    };
    const runtime = createLocalAgentRuntime({
      providers: [provider],
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
      runId: "pipeline-run",
      provider: "pipe",
      cwd: "/workspace/project",
      prompt: "hello",
    })) {
      events.push(event);
    }
    expect(adapterParams?.cwd).toBe("/workspace/project");
    expect(transportPlan?.cwd).toBe("/workspace/project");
    expect(events).toEqual([{ type: "done", status: "completed", reason: "completed" }]);
  });
});
