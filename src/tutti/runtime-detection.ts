import type { DetectContext } from "../core/detection.js";
import type { AgentModelOption, DetectedProvider } from "../core/provider-plugin.js";
import { isManagedAgentInvocationProviderId } from "../core/managed-invocation.js";
import {
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRunner,
} from "./cli-json-runner.js";
import { parseTuttiAgentComposerOptions } from "./composer-options.js";
import {
  isMissingAgentIdContract,
  parseTuttiAgentCatalog,
  parseTuttiLegacyAgentProviderCatalog,
} from "./agent-catalog.js";
import type { TuttiAgentCatalog } from "./contracts.js";

const MANAGED_COMPOSER_TIMEOUT_MS = 45_000;
const DEFAULT_MODEL: AgentModelOption = { id: "default", label: "Default" };

type Descriptor<TProvider extends string> = {
  id: TProvider;
  displayName: string;
  requiresKnownAuth: boolean;
};

export async function detectTuttiManagedProviders<TProvider extends string>(input: {
  context: DetectContext;
  descriptors: Descriptor<TProvider>[];
  runTuttiCli?: TuttiCliJsonRunner;
}): Promise<Array<DetectedProvider<TProvider>>> {
  const runtime = {
    listProviders: () =>
      input.descriptors.map((descriptor) => ({
        ...descriptor,
        kind: "local-agent",
      })),
  };
  let catalog: TuttiAgentCatalog;
  try {
    const payload = await runTuttiCliJson({
      args: ["--json", "agent", "list"],
      cwd: input.context.cwd,
      detectContext: input.context,
      env: input.context.env,
      runTuttiCli: input.runTuttiCli,
      timeoutMs: MANAGED_COMPOSER_TIMEOUT_MS,
    });
    catalog = parseTuttiAgentCatalog(payload, runtime);
  } catch (error) {
    if (!isMissingAgentIdContract(error)) {
      return unavailableManagedCatalog(input.descriptors, error);
    }
    try {
      const payload = await runTuttiCliJson({
        args: ["--json", "agent", "providers"],
        cwd: input.context.cwd,
        detectContext: input.context,
        env: input.context.env,
        runTuttiCli: input.runTuttiCli,
        timeoutMs: MANAGED_COMPOSER_TIMEOUT_MS,
      });
      catalog = parseTuttiLegacyAgentProviderCatalog(payload, runtime);
    } catch (legacyError) {
      return unavailableManagedCatalog(input.descriptors, legacyError);
    }
  }

  const detections = projectManagedCatalog(catalog, input.descriptors);
  const eligible = detections.filter((entry) => entry.supported);
  const composerResults = await Promise.allSettled(
    eligible.map(async (entry) => {
      const agent = catalog.agents.find(
        (candidate) =>
          candidate.agentTargetId === entry.agentTargetId &&
          candidate.providerId === entry.provider,
      )!;
      const composerPayload = await runTuttiCliJson({
        args: [
          "--json",
          "agent",
          "composer-options",
          catalog.cliContract === "agent-id" ? "--agent-id" : "--provider",
          catalog.cliContract === "agent-id" ? agent.agentTargetId : agent.providerId,
        ],
        cwd: input.context.cwd,
        detectContext: input.context,
        env: input.context.env,
        runTuttiCli: input.runTuttiCli,
        timeoutMs: MANAGED_COMPOSER_TIMEOUT_MS,
      });
      const composer = parseTuttiAgentComposerOptions(composerPayload, agent);
      const models = composer.modelConfig.options.map((model) => ({
        id: model.value,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
      }));
      const defaultModelId =
        composer.modelConfig.currentValue || composer.modelConfig.defaultValue || undefined;
      if (models.length === 0) {
        throw new Error("empty_model_catalog");
      }
      return {
        models,
        ...(defaultModelId ? { defaultModelId } : {}),
      };
    }),
  );
  let eligibleIndex = 0;
  return detections.map((entry) => {
    if (!entry.supported) return entry;
    const composer = composerResults[eligibleIndex++]!;
    if (composer.status === "fulfilled") {
      return { ...entry, ...composer.value };
    }
    return {
      ...entry,
      models: [DEFAULT_MODEL],
      defaultModelId: DEFAULT_MODEL.id,
      reason:
        composer.reason instanceof TuttiIntegrationError && composer.reason.code === "cli_timeout"
          ? "Model discovery timed out; using the configured default."
          : "Model discovery failed; using the configured default.",
    };
  });
}

function projectManagedCatalog<TProvider extends string>(
  catalog: TuttiAgentCatalog,
  descriptors: Descriptor<TProvider>[],
): Array<DetectedProvider<TProvider> & { agentTargetId?: string }> {
  const defaultAgent = catalog.agents.find(
    (agent) => agent.agentTargetId === catalog.defaultAgentTargetId,
  );
  const result: Array<DetectedProvider<TProvider> & { agentTargetId?: string }> = [];
  for (const descriptor of descriptors) {
    const id = String(descriptor.id);
    const matches = catalog.agents.filter((agent) => agent.providerId === id);
    if (matches.length !== 1) {
      result.push({
        provider: descriptor.id,
        displayName: descriptor.displayName,
        supported: false,
        authState: "unknown",
        reason:
          matches.length === 0
            ? "Agent runtime is not present in the current agent catalog."
            : "Multiple agents share this runtime; select an exact agent target.",
        models: [],
      });
      continue;
    }
    const agent = matches[0]!;
    const reasonCode = agent.availability.reasonCode;
    const supported =
      agent.availability.status === "available" && isManagedAgentInvocationProviderId(id);
    result.push({
      provider: descriptor.id,
      displayName: agent.displayName || descriptor.displayName,
      supported,
      authState: authStateFromReason(reasonCode),
      models: [],
      agentTargetId: agent.agentTargetId,
      ...(agent.agentTargetId === defaultAgent?.agentTargetId ? { isDefault: true as const } : {}),
      ...(!supported
        ? {
            reason: agent.availability.detail || "Agent runtime is unavailable.",
          }
        : {}),
    });
  }
  return result;
}

function unavailableManagedCatalog<TProvider extends string>(
  descriptors: Descriptor<TProvider>[],
  error: unknown,
): Array<DetectedProvider<TProvider>> {
  const integrationError = error instanceof TuttiIntegrationError ? error : undefined;
  console.warn(
    JSON.stringify({
      event: "agent_acp_kit.managed_agent_catalog_unavailable",
      command: "tutti --json agent list",
      errorCode: integrationError?.code ?? "unknown",
      descriptorCount: descriptors.length,
      ...(integrationError && Object.keys(integrationError.details).length > 0
        ? { errorDetails: integrationError.details }
        : {}),
    }),
  );
  return descriptors.map((descriptor) => ({
    provider: descriptor.id,
    displayName: descriptor.displayName,
    supported: false,
    authState: "unknown",
    reason: "Managed agent catalog is unavailable.",
    models: [],
  }));
}

function authStateFromReason(reasonCode: string): DetectedProvider["authState"] {
  if (reasonCode === "auth_required") return "missing";
  if (reasonCode === "auth_expired" || reasonCode === "session_expired") return "expired";
  return reasonCode ? "unknown" : "ok";
}
