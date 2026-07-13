import type { DetectContext } from "../core/detection.js";
import type { AgentModelOption, DetectedProvider } from "../core/provider-plugin.js";
import { isManagedAgentInvocationProviderId } from "../core/managed-invocation.js";
import {
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRunner,
} from "./cli-json-runner.js";
import { parseTuttiAgentComposerOptions } from "./composer-options.js";
import { canonicalTuttiProviderId, isRecord, optionalString } from "./internal.js";

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
  let payload: unknown;
  try {
    payload = await runTuttiCliJson({
      args: ["--json", "agent", "providers"],
      cwd: input.context.cwd,
      detectContext: input.context,
      env: input.context.env,
      runTuttiCli: input.runTuttiCli,
      timeoutMs: MANAGED_COMPOSER_TIMEOUT_MS,
    });
  } catch {
    return input.descriptors.map((descriptor) => ({
      provider: descriptor.id,
      displayName: descriptor.displayName,
      supported: false,
      authState: "unknown",
      reason: "Managed provider catalog is unavailable.",
      models: [],
    }));
  }

  const catalog = parseManagedCatalog(payload, input.descriptors);
  const eligible = catalog.filter((entry) => entry.supported);
  const composerResults = await Promise.allSettled(
    eligible.map(async (entry) => {
      const composerPayload = await runTuttiCliJson({
        args: ["--json", "agent", "composer-options", "--provider", entry.provider],
        cwd: input.context.cwd,
        detectContext: input.context,
        env: input.context.env,
        runTuttiCli: input.runTuttiCli,
        timeoutMs: MANAGED_COMPOSER_TIMEOUT_MS,
      });
      const composer = parseTuttiAgentComposerOptions(composerPayload, entry.provider);
      const models = composer.modelConfig.options.map((model) => ({
        id: model.value,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
      }));
      const defaultModelId = composer.modelConfig.currentValue ||
        composer.modelConfig.defaultValue || undefined;
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
  return catalog.map((entry) => {
    if (!entry.supported) return entry;
    const composer = composerResults[eligibleIndex++]!;
    if (composer.status === "fulfilled") {
      return { ...entry, ...composer.value };
    }
    return {
      ...entry,
      models: [DEFAULT_MODEL],
      defaultModelId: DEFAULT_MODEL.id,
      reason: composer.reason instanceof TuttiIntegrationError && composer.reason.code === "cli_timeout"
        ? "Model discovery timed out; using the configured default."
        : "Model discovery failed; using the configured default.",
    };
  });
}

function parseManagedCatalog<TProvider extends string>(
  payload: unknown,
  descriptors: Descriptor<TProvider>[],
): Array<DetectedProvider<TProvider>> {
  if (!isRecord(payload) || payload.schemaVersion !== 2 || !Array.isArray(payload.providers)) {
    return descriptors.map((descriptor) => unavailableDescriptor(descriptor));
  }
  const descriptorById = new Map(
    descriptors.map((descriptor) => [canonicalTuttiProviderId(String(descriptor.id)), descriptor]),
  );
  const seen = new Set<string>();
  const result: Array<DetectedProvider<TProvider>> = [];
  for (const value of payload.providers) {
    if (!isRecord(value) || !isRecord(value.availability)) continue;
    const id = canonicalTuttiProviderId(optionalString(value.providerId) ?? "");
    const descriptor = descriptorById.get(id);
    if (!descriptor || seen.has(id)) continue;
    seen.add(id);
    const status = value.availability.status;
    const reasonCode = optionalString(value.availability.reasonCode) ?? "";
    const supported = status === "available" && isManagedAgentInvocationProviderId(id);
    result.push({
      provider: descriptor.id,
      displayName: optionalString(value.displayName) ?? descriptor.displayName,
      supported,
      authState: authStateFromReason(reasonCode),
      models: [],
      ...(!supported
        ? { reason: optionalString(value.availability.detail) ?? "Provider is unavailable." }
        : {}),
    });
  }
  return result;
}

function unavailableDescriptor<TProvider extends string>(
  descriptor: Descriptor<TProvider>,
): DetectedProvider<TProvider> {
  return {
    provider: descriptor.id,
    displayName: descriptor.displayName,
    supported: false,
    authState: "unknown",
    reason: "Managed provider catalog is unavailable.",
    models: [],
  };
}

function authStateFromReason(reasonCode: string): DetectedProvider["authState"] {
  if (reasonCode === "auth_required") return "missing";
  if (reasonCode === "auth_expired" || reasonCode === "session_expired") return "expired";
  return reasonCode ? "unknown" : "ok";
}
