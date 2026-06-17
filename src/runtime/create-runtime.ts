import type {
  AgentRuntimeRecord,
  AgentRuntimeStatus,
  RuntimeTarget,
} from "../core/capabilities.js";
import { getRuntimeTarget, getRuntimeTargetKey } from "../core/registry.js";
import type {
  AgentRunParams,
  LocalAgentProviderAdapter,
  LocalAgentProviderPlugin,
  RuntimeKindSelector,
  RuntimeKindSelectorInput,
  RuntimeLease,
  RuntimeProvider,
} from "../core/provider-plugin.js";
import type { DetectContext } from "../core/detection.js";
import type { AgentEvent } from "../core/events.js";
import type { AgentRunInput } from "../core/run-input.js";
import type { RawAgentEvent, Transport } from "../core/transport.js";
import type { LaunchPlan, TransportKind } from "../core/launch-plan.js";
import { createDetectionCache } from "./detection-cache.js";
import { runAcpTransport } from "../transports/acp/acp-client.js";
import { createJsonlParser } from "../transports/jsonl/jsonl-parser.js";
import { runPlainTransport } from "../transports/plain/plain-transport.js";
import { spawnSupervisedProcess } from "../process/supervisor.js";
import { createProviderRegistry } from "./provider-registry.js";
import {
  applyManagedAgentInvocationToLaunchPlan,
  applyManagedAgentInvocationToRunParams,
  hasManagedAgentInvocation,
  prepareManagedAgentInvocationDetectContext,
} from "../core/managed-invocation.js";

type ProviderDetectionResult<
  TKind extends string,
  TProvider extends string,
> = Awaited<ReturnType<LocalAgentProviderPlugin<TKind, TProvider>["detect"]>>;

export type LocalAgentRuntime<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  cancel(runId: string): Promise<void>;
  detect(context?: DetectContext): Promise<
    Array<{
      provider: TProvider;
      displayName: string;
      result: Awaited<ReturnType<LocalAgentProviderPlugin<TKind, TProvider>["detect"]>>;
    }>
  >;
  listProviders(): Array<{ id: TProvider; displayName: string; kind: TKind }>;
  run(input: AgentRunInput<TKind, TProvider>): AsyncGenerator<AgentEvent>;
};

function createRuntimeAbortSignal(
  inputSignal: AbortSignal | undefined,
  controller: AbortController,
) {
  if (!inputSignal) {
    return controller.signal;
  }

  if (inputSignal.aborted) {
    controller.abort(inputSignal.reason);
    return controller.signal;
  }

  const onAbort = () => controller.abort(inputSignal.reason);
  inputSignal.addEventListener("abort", onAbort, { once: true });
  controller.signal.addEventListener(
    "abort",
    () => inputSignal.removeEventListener("abort", onAbort),
    { once: true },
  );
  return controller.signal;
}

export function createLocalAgentRuntime<
  TKind extends string = string,
  TProvider extends string = string,
>(options: {
  providers: LocalAgentProviderPlugin<TKind, TProvider>[];
  transports?: Transport[];
}): LocalAgentRuntime<TKind, TProvider> {
  const providers = new Map<TProvider, LocalAgentProviderPlugin<TKind, TProvider>>(
    options.providers.map((provider) => [provider.id, provider]),
  );
  const activeRuns = new Map<
    string,
    {
      controller: AbortController;
      provider: LocalAgentProviderPlugin<TKind, TProvider>;
      transportCancel?: () => Promise<void> | void;
    }
  >();
  const detectionCache = createDetectionCache<ProviderDetectionResult<TKind, TProvider>>();

  const transports = new Map<TransportKind, Transport>(
    [
      createBuiltInJsonlTransport(),
      createBuiltInPlainTransport(),
      createBuiltInAcpTransport(),
      ...(options.transports ?? []),
    ].map((transport) => [transport.kind, transport]),
  );

  function resolveTransport(plan: LaunchPlan): Transport {
    const transportKind = plan.transport ?? "jsonl";
    const transport = transports.get(transportKind);
    if (!transport) {
      throw new Error(`No local agent transport registered for ${transportKind}`);
    }
    return transport;
  }

  return {
    async cancel(runId) {
      const activeRun = activeRuns.get(runId);
      if (!activeRun) {
        return;
      }
      activeRun.controller.abort();
      await activeRun.transportCancel?.();
      await activeRun.provider.cancel?.(runId);
    },

    async detect(context) {
      return Promise.all(
        options.providers.map(async (provider) => {
          const cacheKey = `${String(provider.kind)}:${String(provider.id)}`;
          const cacheable = !context;
          const cached = cacheable ? detectionCache.get(cacheKey) : undefined;
          if (cacheable && cached !== undefined) {
            return {
              provider: provider.id,
              displayName: provider.displayName,
              result: cached,
            };
          }

          const providerContext = prepareManagedAgentInvocationDetectContext(
            String(provider.id),
            context,
          );
          let result: ProviderDetectionResult<TKind, TProvider>;
          try {
            result = await provider.detect(providerContext);
          } catch {
            result = null as ProviderDetectionResult<TKind, TProvider>;
          }
          if (cacheable) {
            detectionCache.set(cacheKey, result);
          }
          return {
            provider: provider.id,
            displayName: provider.displayName,
            result,
          };
        }),
      );
    },

    listProviders() {
      return options.providers.map((provider) => ({
        id: provider.id,
        displayName: provider.displayName,
        kind: provider.kind,
      }));
    },

    async *run(input) {
      const provider = providers.get(input.provider);
      if (!provider) {
        throw new Error(`No local agent provider registered for ${input.provider}`);
      }

      const controller = new AbortController();
      const signal = createRuntimeAbortSignal(input.signal, controller);
      activeRuns.set(input.runId, { controller, provider });

      try {
        const params: AgentRunParams<TKind, TProvider> =
          applyManagedAgentInvocationToRunParams(String(provider.id), {
            ...input,
            runtimeKind: input.runtimeKind ?? provider.kind,
            runtimeProvider: input.runtimeProvider ?? provider.id,
            signal,
          });
        const adapter = provider.createAdapter?.();
        if (!adapter) {
          yield* normalizeAgentEvents(provider.run(params));
          return;
        }

        const plan = applyManagedAgentInvocationToLaunchPlan(
          String(provider.id),
          await adapter.buildLaunchPlan(params),
          hasManagedAgentInvocation(params)
            ? params.managedAgentInvocation
            : undefined,
        );
        const rawStream = resolveTransport(plan).run(plan, signal);
        activeRuns.set(input.runId, {
          controller,
          provider,
          ...(rawStream.cancel ? { transportCancel: rawStream.cancel } : {}),
        });
        yield* normalizeAgentEvents(adapter.parseEvents(rawStream));
      } finally {
        activeRuns.delete(input.runId);
      }
    },
  };
}

function normalizeAgentEvent(event: AgentEvent): AgentEvent {
  if (event.type === "thinking") {
    return { type: "thinking_delta", text: event.text };
  }
  if (event.type === "tool_result") {
    const status =
      event.status ??
      (event.isError || event.error ? "failed" : "completed");
    return {
      ...event,
      status,
      isError: status === "failed",
    };
  }
  if (event.type === "done") {
    const status =
      event.status ??
      (event.reason === "cancelled"
        ? "canceled"
        : event.reason === "error"
          ? "failed"
          : "completed");
    return {
      ...event,
      status,
      reason:
        event.reason ??
        (status === "canceled"
          ? "cancelled"
          : status === "failed"
            ? "error"
            : "completed"),
    };
  }
  if (event.type === "status" && !event.status && event.stage) {
    return { ...event, status: event.stage };
  }
  return event;
}

async function* normalizeAgentEvents(
  stream: AsyncIterable<AgentEvent>,
): AsyncGenerator<AgentEvent> {
  for await (const event of stream) {
    yield normalizeAgentEvent(event);
  }
}

function createBuiltInJsonlTransport(): Transport {
  function isRecord(value: unknown): value is Record<string, unknown> {
    return Boolean(value && typeof value === "object" && !Array.isArray(value));
  }

  function hasThreadStarted(events: RawAgentEvent[]) {
    return events.some((event) => isRecord(event) && event.type === "thread.started");
  }

  function shouldRunFallback(events: RawAgentEvent[]) {
    return (
      !hasThreadStarted(events) &&
      events.some(
        (event) =>
          isRecord(event) &&
          event.type === "error" &&
          event.code === "process_exit_nonzero",
      )
    );
  }

  async function* runOnce(plan: LaunchPlan, signal?: AbortSignal): AsyncGenerator<RawAgentEvent> {
    const processHandle = spawnSupervisedProcess({
      ...plan,
      ...(signal ? { signal } : {}),
    });
    const queue: RawAgentEvent[] = [];
    let done = false;
    let transportError: unknown;

    const parser = createJsonlParser<RawAgentEvent>((item) => {
      queue.push(item);
    });

    processHandle.child.stdout.on("data", (chunk: string) => {
      try {
        parser.feed(chunk);
      } catch (error) {
        transportError = error;
      }
    });

    void processHandle.waitForExit().then(({ code, signal, timedOut }) => {
      try {
        parser.flush();
      } catch (error) {
        transportError = error;
      }
      const canceled = signal != null;
      if (timedOut) {
        queue.push({
          type: "error",
          code: "process_timeout",
          message: `Process timed out after ${plan.timeoutMs}ms.`,
        });
        queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
      } else if (canceled) {
        queue.push({ type: "done", status: "canceled", reason: "cancelled", exitCode: code });
      } else if (transportError) {
        queue.push({
          type: "error",
          code: "jsonl_parse_failed",
          message:
            transportError instanceof Error
              ? transportError.message
              : String(transportError),
        });
        queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
      } else if (code && code !== 0) {
        const stderrTail = processHandle.stderr.tail().trim();
        queue.push({
          type: "error",
          code: "process_exit_nonzero",
          message:
            stderrTail.length > 0
              ? stderrTail
              : `Process exited with code ${code}.`,
        });
        queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
      } else {
        queue.push({
          type: "done",
          status: "completed",
          reason: "completed",
          exitCode: code,
        });
      }
      done = true;
    });

    while (!done || queue.length > 0) {
      const next = queue.shift();
      if (next) {
        yield next;
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  return {
    kind: "jsonl",
    async *run(plan, signal) {
      if (plan.fallbackPlan) {
        const firstAttempt: RawAgentEvent[] = [];
        for await (const event of runOnce(plan, signal)) {
          firstAttempt.push(event);
        }
        if (shouldRunFallback(firstAttempt)) {
          yield* runOnce(plan.fallbackPlan, signal);
          return;
        }
        yield* firstAttempt;
        return;
      }
      yield* runOnce(plan, signal);
    },
  };
}

function createBuiltInPlainTransport(): Transport {
  return {
    kind: "plain",
    run(plan, signal) {
      return runPlainTransport(plan, signal);
    },
  };
}

function createBuiltInAcpTransport(): Transport {
  return {
    kind: "acp-json-rpc",
    run(plan, signal) {
      return runAcpTransport(plan, {
        runId: plan.runId ?? "acp-run",
        cwd: plan.cwd,
        prompt: plan.prompt,
        ...(plan.model ? { model: plan.model } : {}),
        ...(plan.mcpServers ? { mcpServers: plan.mcpServers } : {}),
        ...(plan.resume ? { resume: plan.resume } : {}),
        ...(plan.timeoutMs ? { timeoutMs: plan.timeoutMs } : {}),
        signal,
      } as AgentRunParams);
    },
  };
}

export function inferRuntimeKind<
  TKind extends string = string,
  TProvider extends string = string,
>(
  input: RuntimeKindSelectorInput<TKind, TProvider>,
): RuntimeTarget<TKind, TProvider> {
  if (input.requestedRuntimeKind) {
    return {
      kind: input.requestedRuntimeKind,
      ...(input.requestedRuntimeProvider
        ? { provider: input.requestedRuntimeProvider }
        : {}),
    };
  }

  if (input.availableRuntimeTargets.length === 1) {
    return input.availableRuntimeTargets[0]!;
  }

  throw new Error(
    "No runtime kind requested and no selector configured for multiple runtime providers",
  );
}

export function createRuntimeControlPlane<
  TContext,
  TEvent,
  TKind extends string = string,
  TProvider extends string = string,
>(
  providers: RuntimeProvider<TContext, TEvent, TKind, TProvider>[],
  options?: {
    selectRuntimeKind?: RuntimeKindSelector<TKind, TProvider>;
    now?: () => string;
  },
) {
  const now = options?.now ?? (() => new Date().toISOString());
  const providerRegistry = createProviderRegistry(providers);
  const providerMap = new Map<
    string,
    RuntimeProvider<TContext, TEvent, TKind, TProvider>
  >(
    providers.map((provider) => [
      getRuntimeTargetKey(getRuntimeTarget(provider.runtime)),
      provider,
    ]),
  );
  const runtimeRecords = new Map<string, AgentRuntimeRecord<TKind, TProvider>>(
    providers.map((provider) => [
      provider.runtime.id,
      {
        ...provider.runtime,
        lastSeenAt: provider.runtime.lastSeenAt ?? now(),
      },
    ]),
  );
  const runtimeTargetIndex = new Map<string, string>(
    providers.map((provider) => [
      getRuntimeTargetKey(getRuntimeTarget(provider.runtime)),
      provider.runtime.id,
    ]),
  );
  const activeRunCounts = new Map<string, number>();
  const activeRunLeases = new Map<string, string>();

  function getRuntimeRecordByTarget(
    target: RuntimeTarget<TKind, TProvider>,
  ): AgentRuntimeRecord<TKind, TProvider> {
    const runtimeId = runtimeTargetIndex.get(getRuntimeTargetKey(target));
    if (!runtimeId) {
      const providerSuffix = target.provider ? ` (${target.provider})` : "";
      throw new Error(
        `No runtime provider registered for ${target.kind}${providerSuffix}`,
      );
    }
    const runtime = runtimeRecords.get(runtimeId);
    if (!runtime) {
      throw new Error(`Runtime registry missing record ${runtimeId}`);
    }
    return runtime;
  }

  function listSchedulableRuntimeTargets(): RuntimeTarget<TKind, TProvider>[] {
    return Array.from(runtimeRecords.values())
      .filter((runtime) => runtime.status !== "offline")
      .map((runtime) => getRuntimeTarget(runtime));
  }

  function releaseRuntimeLease(runId: string) {
    const runtimeId = activeRunLeases.get(runId);
    if (!runtimeId) {
      return;
    }

    activeRunLeases.delete(runId);
    const nextCount = Math.max(0, (activeRunCounts.get(runtimeId) ?? 0) - 1);
    if (nextCount === 0) {
      activeRunCounts.delete(runtimeId);
      return;
    }
    activeRunCounts.set(runtimeId, nextCount);
  }

  return {
    listRuntimeRecords(): AgentRuntimeRecord<TKind, TProvider>[] {
      return Array.from(runtimeRecords.values()).map((runtime) => ({
        ...runtime,
      }));
    },

    getProviderCount(): number {
      return providerRegistry.getProviderCount();
    },

    listRuntimeTargets(): RuntimeTarget<TKind, TProvider>[] {
      return listSchedulableRuntimeTargets();
    },

    getRuntimeRecord(
      target: RuntimeTarget<TKind, TProvider>,
    ): AgentRuntimeRecord<TKind, TProvider> {
      return {
        ...getRuntimeRecordByTarget(target),
      };
    },

    touchRuntime(
      target: RuntimeTarget<TKind, TProvider>,
      status?: AgentRuntimeStatus,
    ): AgentRuntimeRecord<TKind, TProvider> {
      const runtime = getRuntimeRecordByTarget(target);
      const updatedRuntime = {
        ...runtime,
        ...(status ? { status } : {}),
        lastSeenAt: now(),
      };
      runtimeRecords.set(updatedRuntime.id, updatedRuntime);
      return { ...updatedRuntime };
    },

    updateRuntimeStatus(
      target: RuntimeTarget<TKind, TProvider>,
      status: AgentRuntimeStatus,
    ): AgentRuntimeRecord<TKind, TProvider> {
      return this.touchRuntime(target, status);
    },

    resolveRuntimeTarget(input: {
      model: unknown;
      requestedRuntimeKind: TKind | undefined;
      requestedRuntimeProvider?: TProvider | undefined;
    }): RuntimeTarget<TKind, TProvider> {
      if (input.requestedRuntimeKind) {
        const requestedTarget = {
          kind: input.requestedRuntimeKind,
          ...(input.requestedRuntimeProvider
            ? { provider: input.requestedRuntimeProvider }
            : {}),
        };
        if (!providerMap.has(getRuntimeTargetKey(requestedTarget))) {
          const providerSuffix = input.requestedRuntimeProvider
            ? ` (${input.requestedRuntimeProvider})`
            : "";
          throw new Error(
            `No runtime provider registered for ${input.requestedRuntimeKind}${providerSuffix}`,
          );
        }
        const runtime = getRuntimeRecordByTarget(requestedTarget);
        if (runtime.status === "offline") {
          const providerSuffix = runtime.provider ? ` (${runtime.provider})` : "";
          throw new Error(
            `Runtime ${runtime.kind}${providerSuffix} is offline`,
          );
        }
      }

      const selectRuntimeKind = options?.selectRuntimeKind ?? inferRuntimeKind;
      const availableRuntimeTargets = listSchedulableRuntimeTargets();
      if (availableRuntimeTargets.length === 0) {
        throw new Error("No schedulable runtime providers are currently online");
      }
      const target = selectRuntimeKind({
        availableRuntimeTargets,
        model: input.model,
        requestedRuntimeKind: input.requestedRuntimeKind,
        ...(input.requestedRuntimeProvider
          ? { requestedRuntimeProvider: input.requestedRuntimeProvider }
          : {}),
      });
      if (!providerMap.has(getRuntimeTargetKey(target))) {
        const providerSuffix = target.provider ? ` (${target.provider})` : "";
        throw new Error(
          `No runtime provider registered for ${target.kind}${providerSuffix}`,
        );
      }
      return target;
    },

    acquireRuntimeLease(
      target: RuntimeTarget<TKind, TProvider>,
      runId: string,
    ): RuntimeLease<TKind, TProvider> {
      const runtime = getRuntimeRecordByTarget(target);
      if (runtime.status === "offline") {
        const providerSuffix = runtime.provider ? ` (${runtime.provider})` : "";
        throw new Error(
          `Runtime ${runtime.kind}${providerSuffix} is offline`,
        );
      }
      if (activeRunLeases.has(runId)) {
        throw new Error(`Run ${runId} already holds a runtime lease`);
      }

      const activeRuns = activeRunCounts.get(runtime.id) ?? 0;
      if (activeRuns >= runtime.capabilities.maxConcurrentRuns) {
        const providerSuffix = runtime.provider ? ` (${runtime.provider})` : "";
        throw new Error(
          `Runtime ${runtime.kind}${providerSuffix} is at capacity`,
        );
      }

      activeRunCounts.set(runtime.id, activeRuns + 1);
      activeRunLeases.set(runId, runtime.id);
      runtimeRecords.set(runtime.id, {
        ...runtime,
        lastSeenAt: now(),
      });

      let released = false;
      return {
        runId,
        runtimeId: runtime.id,
        target,
        release: () => {
          if (released) {
            return;
          }
          released = true;
          releaseRuntimeLease(runId);
        },
      };
    },

    releaseRuntimeLease,

    streamRun(
      target: RuntimeTarget<TKind, TProvider>,
      context: TContext,
    ): AsyncGenerator<TEvent> {
      const provider = providerMap.get(getRuntimeTargetKey(target));
      if (!provider) {
        const providerSuffix = target.provider ? ` (${target.provider})` : "";
        throw new Error(
          `No runtime provider registered for ${target.kind}${providerSuffix}`,
        );
      }
      this.touchRuntime(target);
      return provider.streamRun(context);
    },
  };
}
