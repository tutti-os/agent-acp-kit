import type { DetectContext } from "../core/detection.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import type { TuttiCliJsonRequest } from "./cli-json-runner.js";
import { loadTuttiAgentComposerOptions } from "./composer-options.js";
import { loadTuttiAgentProviderCatalog } from "./provider-catalog.js";

export interface TuttiResolvedAgentProviderCatalogModel {
  id: string;
  label: string;
  description?: string;
}

export interface TuttiResolvedAgentProviderCatalogEntry {
  provider: string;
  displayName: string;
  available: boolean;
  authState: "ok" | "missing" | "expired" | "unknown";
  executablePath: string;
  version: string;
  configDir?: string;
  models: TuttiResolvedAgentProviderCatalogModel[];
  defaultModelId?: string;
  reason?: string;
}

export interface TuttiResolvedAgentProviderCatalog {
  defaultProvider: string | null;
  providers: TuttiResolvedAgentProviderCatalogEntry[];
  source: "tutti-cli" | "standalone";
}

export interface ResolveTuttiAgentProviderCatalogInput
  extends Omit<TuttiCliJsonRequest, "args"> {
  runtime: Pick<LocalAgentRuntime<string, string>, "detect" | "listProviders">;
  detectContext?: DetectContext;
  includeComposerModels?: boolean;
}

/**
 * Resolves the app-facing provider view in one place: Tutti visibility,
 * installed runtime metadata, authentication readiness, and lazy composer
 * models. The same detection promise is reused by standalone catalog and
 * composer discovery so consumers never duplicate provider probes.
 */
export async function resolveTuttiAgentProviderCatalog(
  input: ResolveTuttiAgentProviderCatalogInput,
): Promise<TuttiResolvedAgentProviderCatalog> {
  const detectionsPromise = input.runtime.detect(input.detectContext);
  const runtime = {
    listProviders: () => input.runtime.listProviders(),
    detect: () => detectionsPromise,
  } as LocalAgentRuntime<string, string>;
  const integration = {
    runtime,
    ...(input.detectContext ? { detectContext: input.detectContext } : {}),
    ...(input.command ? { command: input.command } : {}),
    ...(input.commandEnvNames ? { commandEnvNames: input.commandEnvNames } : {}),
    ...(input.cwd ? { cwd: input.cwd } : {}),
    ...(input.env ? { env: input.env } : {}),
    ...(input.maxBuffer ? { maxBuffer: input.maxBuffer } : {}),
    ...(input.runTuttiCli ? { runTuttiCli: input.runTuttiCli } : {}),
    ...(input.signal ? { signal: input.signal } : {}),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  };
  const [catalog, detections] = await Promise.all([
    loadTuttiAgentProviderCatalog(integration),
    detectionsPromise,
  ]);
  const detected = new Map(
    detections.map((item) => [String(item.provider), item.result]),
  );
  const managedInvocation = Boolean(input.detectContext?.managedAgentInvocation);

  const providers = await Promise.all(catalog.providers.map(async (provider) => {
    const detection = detected.get(provider.providerId);
    const localReady = Boolean(detection) &&
      detection?.supported !== false &&
      detection?.authState !== "missing" &&
      detection?.authState !== "expired";
    const available = provider.runtimeSupported &&
      provider.availability.status === "available" &&
      (managedInvocation || localReady);
    let models = (detection?.models ?? []).map((model) => ({
      id: model.id,
      label: model.label,
      ...(model.description ? { description: model.description } : {}),
    }));
    let defaultModelId: string | undefined;

    if (available && input.includeComposerModels !== false) {
      const composer = await loadTuttiAgentComposerOptions({
        ...integration,
        providerId: provider.providerId,
      });
      const composerModels = composer.modelConfig.options.map((model) => ({
        id: model.value,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
      }));
      if (composerModels.length > 0) models = composerModels;
      defaultModelId = composer.modelConfig.currentValue ||
        composer.modelConfig.defaultValue || undefined;
    }

    return {
      provider: provider.providerId,
      displayName: provider.displayName,
      available,
      authState: resolveAuthState(provider.availability.reasonCode, detection?.authState),
      executablePath: detection?.executablePath ?? "",
      version: detection?.version ?? (available ? "" : "not-installed"),
      ...(detection?.configDir ? { configDir: detection.configDir } : {}),
      models,
      ...(defaultModelId ? { defaultModelId } : {}),
      ...(!available ? {
        reason: provider.availability.detail ||
          detection?.unsupportedReason ||
          localReadinessReason(detection),
      } : {}),
    } satisfies TuttiResolvedAgentProviderCatalogEntry;
  }));
  const preferred = providers.find(
    (provider) => provider.provider === catalog.defaultProviderId && provider.available,
  );

  return {
    defaultProvider: preferred?.provider ??
      providers.find((provider) => provider.available)?.provider ?? null,
    providers,
    source: catalog.source,
  };
}

export function findTuttiAgentCatalogProvider(
  providers: readonly TuttiResolvedAgentProviderCatalogEntry[],
  provider: string,
) {
  const normalized = provider.trim().toLowerCase();
  return providers.find((entry) => entry.provider === normalized);
}

export function displayNameForAgentProvider(
  provider: string,
  fallback?: string | null,
) {
  return fallback?.trim() || provider
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

function resolveAuthState(
  reasonCode: string,
  detected?: "ok" | "missing" | "expired" | "unknown",
) {
  if (reasonCode === "auth_required") return "missing" as const;
  if (reasonCode === "auth_expired") return "expired" as const;
  return detected ?? "unknown";
}

function localReadinessReason(
  detection: Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>[number]["result"] | undefined,
) {
  if (!detection) return "Provider runtime was not detected.";
  if (detection.authState === "missing") return "Authentication is required.";
  if (detection.authState === "expired") return "Authentication has expired.";
  return "Provider is not available.";
}
