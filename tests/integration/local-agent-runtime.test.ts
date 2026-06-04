import { describe, expect, it, vi } from "vitest";

import {
  createFakeProvider,
  createLocalAgentRuntime,
  type AgentEvent,
  type LocalAgentProviderPlugin,
  type RawAgentStream,
  type Transport,
} from "../../src/index.js";

describe("createLocalAgentRuntime", () => {
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
        result: {
          authState: "ok",
          supported: true,
        },
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
          params.signal?.addEventListener("abort", () => resolve(), { once: true });
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
      { provider: "ok", result: { authState: "ok" } },
      { provider: "bad", result: null },
    ]);
    await runtime.detect();

    expect(detectOk).toHaveBeenCalledTimes(1);
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

    expect(calls).toEqual([
      "adapter:run_pipe:test",
      "parse",
      "transport:hello",
    ]);
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
