import type { DetectContext } from "../core/detection.js";
import type { DetectedProvider } from "../core/provider-plugin.js";
import type { AgentRunInput } from "../core/run-input.js";
import type {
  RuntimeAgentDescriptor,
  TuttiRuntimeDetector,
  TuttiRuntimeRunPreparer,
} from "../runtime/create-runtime.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import { loadTuttiAgentCatalog } from "./agent-catalog.js";
import {
  loadTuttiAgentComposerOptions,
  loadTuttiAgentComposerOptionsWithCatalog,
} from "./composer-options.js";
import type { TuttiAgentCatalogEntry, TuttiAgentComposerOptions } from "./contracts.js";
import { hasConfiguredTuttiCli, type TuttiCliJsonRunner } from "./cli-json-runner.js";

type IntegrationOptions = {
  runTuttiCli?: TuttiCliJsonRunner;
};

export function createTuttiRuntimeIntegration<
  TKind extends string,
  TProvider extends string,
>(options: IntegrationOptions = {}): {
  detect: TuttiRuntimeDetector<TKind, TProvider>;
  prepareRun: TuttiRuntimeRunPreparer<TKind, TProvider>;
} {
  const cache = new Map<string, Promise<Array<DetectedProvider<TProvider>>>>();

  const detect: TuttiRuntimeDetector<TKind, TProvider> = async ({ context, descriptors }) => {
    const env = effectiveEnv(context);
    const cliInput = { env, ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}) };
    if (!hasConfiguredTuttiCli(cliInput)) return undefined;

    const key = `${env.TUTTI_CLI ?? "custom-runner"}\u0000${context?.cwd ?? ""}`;
    if (context?.refresh) cache.delete(key);
    const existing = cache.get(key);
    if (existing) return await existing;

    const request = detectTuttiTargets({
      context,
      descriptors,
      env,
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    }).catch(() => {
      cache.delete(key);
      return [];
    });
    cache.set(key, request);
    return await request;
  };

  const prepareRun: TuttiRuntimeRunPreparer<TKind, TProvider> = async ({
    run,
    env,
    descriptors,
  }) => {
    const cliInput = { env, ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}) };
    if (!hasConfiguredTuttiCli(cliInput)) return run;
    if (!run.agentTargetId) {
      throw new Error("Tutti runtime runs require an exact agentTargetId.");
    }

    const runtime = descriptorRuntime(descriptors);
    const composer = await loadTuttiAgentComposerOptions({
      runtime,
      agentTargetId: run.agentTargetId,
      cwd: run.cwd,
      env,
      detectContext: { cwd: run.cwd, env },
      ...(run.model ? { model: run.model } : {}),
      ...(run.reasoning ? { reasoningEffort: run.reasoning } : {}),
      ...(run.signal ? { signal: run.signal } : {}),
      ...(options.runTuttiCli ? { runTuttiCli: options.runTuttiCli } : {}),
    });
    if (composer.providerId !== String(run.provider)) {
      throw new Error(
        `Agent Target provider mismatch: ${run.agentTargetId} resolves to ${composer.providerId}, got ${String(run.provider)}.`,
      );
    }
    return applyComposerToRun(run, composer);
  };

  return { detect, prepareRun };
}

async function detectTuttiTargets<TKind extends string, TProvider extends string>(input: {
  context?: DetectContext;
  descriptors: RuntimeAgentDescriptor<TKind, TProvider>[];
  env: NodeJS.ProcessEnv;
  runTuttiCli?: TuttiCliJsonRunner;
}): Promise<Array<DetectedProvider<TProvider>>> {
  const runtime = descriptorRuntime(input.descriptors);
  const catalog = await loadTuttiAgentCatalog({
    runtime,
    cwd: input.context?.cwd,
    detectContext: input.context,
    env: input.env,
    ...(input.runTuttiCli ? { runTuttiCli: input.runTuttiCli } : {}),
  });
  const descriptorByProvider = new Map(
    input.descriptors.map((descriptor) => [String(descriptor.id), descriptor]),
  );
  return await Promise.all(
    catalog.agents.map(async (agent): Promise<DetectedProvider<TProvider>> => {
      const descriptor = descriptorByProvider.get(agent.providerId);
      if (!descriptor || !agent.runtimeSupported) {
        return projectUnavailableTarget<TKind, TProvider>(
          agent,
          undefined,
          catalog.defaultAgentTargetId,
        );
      }
      if (agent.availability.status !== "available") {
        return projectUnavailableTarget<TKind, TProvider>(
          agent,
          descriptor,
          catalog.defaultAgentTargetId,
        );
      }
      try {
        const composer = await loadTuttiAgentComposerOptionsWithCatalog(
          {
            runtime,
            agentTargetId: agent.agentTargetId,
            cwd: input.context?.cwd,
            detectContext: input.context,
            env: input.env,
            ...(input.runTuttiCli ? { runTuttiCli: input.runTuttiCli } : {}),
          },
          catalog,
        );
        return projectAvailableTarget<TKind, TProvider>(
          agent,
          descriptor,
          composer,
          catalog.defaultAgentTargetId,
        );
      } catch (error) {
        return {
          ...projectUnavailableTarget<TKind, TProvider>(
            agent,
            descriptor,
            catalog.defaultAgentTargetId,
          ),
          reason: `Agent composer options could not be loaded: ${safeErrorMessage(error)}`,
        };
      }
    }),
  );
}

function descriptorRuntime<TKind extends string, TProvider extends string>(
  descriptors: RuntimeAgentDescriptor<TKind, TProvider>[],
): LocalAgentRuntime<string, string> {
  return {
    async cancel() {},
    listProviders: () => descriptors.map((descriptor) => ({
      id: String(descriptor.id),
      displayName: descriptor.displayName,
      kind: String(descriptor.kind),
      ...(descriptor.requiresKnownAuth ? { requiresKnownAuth: true } : {}),
    })),
    detect: async () => {
      throw new Error("Tutti runtime integration must not fall back to standalone detection.");
    },
    run: (() => {
      throw new Error("not used");
    }) as LocalAgentRuntime<string, string>["run"],
  };
}

function projectAvailableTarget<TKind extends string, TProvider extends string>(
  agent: TuttiAgentCatalogEntry,
  descriptor: RuntimeAgentDescriptor<TKind, TProvider>,
  composer: TuttiAgentComposerOptions,
  defaultAgentTargetId: string,
): DetectedProvider<TProvider> {
  const models = composer.modelConfig.options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
  const defaultModelId = composer.modelConfig.currentValue || composer.modelConfig.defaultValue;
  return {
    agentTargetId: agent.agentTargetId,
    provider: descriptor.id,
    displayName: agent.displayName,
    supported: true,
    authState: "ok",
    models,
    ...(defaultModelId ? { defaultModelId } : {}),
    ...(agent.agentTargetId === defaultAgentTargetId ? { isDefault: true } : {}),
  };
}

function projectUnavailableTarget<TKind extends string, TProvider extends string>(
  agent: TuttiAgentCatalogEntry,
  descriptor: RuntimeAgentDescriptor<TKind, TProvider> | undefined,
  defaultAgentTargetId: string,
): DetectedProvider<TProvider> {
  return {
    agentTargetId: agent.agentTargetId,
    provider: (descriptor?.id ?? agent.providerId) as TProvider,
    displayName: agent.displayName,
    supported: false,
    authState: authStateFromReason(agent.availability.reasonCode),
    models: [],
    reason: agent.availability.detail || "Agent Target is unavailable.",
    ...(agent.agentTargetId === defaultAgentTargetId ? { isDefault: true } : {}),
  };
}

function applyComposerToRun<TKind extends string, TProvider extends string>(
  run: AgentRunInput<TKind, TProvider>,
  composer: TuttiAgentComposerOptions,
): AgentRunInput<TKind, TProvider> {
  const model = run.model || composer.modelConfig.currentValue || composer.modelConfig.defaultValue;
  const reasoning = run.reasoning || composer.reasoningConfig.currentValue || composer.reasoningConfig.defaultValue;
  const defaultPermission = composer.permissionConfig.modes.find(
    (mode) => mode.id === composer.permissionConfig.defaultValue,
  );
  return {
    ...run,
    ...(model ? { model } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(!run.permission && defaultPermission
      ? { permission: { semantic: defaultPermission.semantic, modeId: defaultPermission.id } }
      : {}),
  };
}

function effectiveEnv(context?: DetectContext): NodeJS.ProcessEnv {
  return { ...process.env, ...(context?.env ?? {}) };
}

function authStateFromReason(reasonCode: string): DetectedProvider["authState"] {
  if (reasonCode === "auth_required") return "missing";
  if (reasonCode === "auth_expired" || reasonCode === "session_expired") return "expired";
  return reasonCode ? "unknown" : "ok";
}

function safeErrorMessage(error: unknown) {
  return error instanceof Error && error.message.trim() ? error.message.trim() : "unknown error";
}
