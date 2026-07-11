import type { DetectContext } from "../core/detection.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import type {
  TuttiAgentProviderAvailability,
  TuttiAgentProviderCatalog,
  TuttiAgentProviderCatalogEntry,
} from "./contracts.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import { isManagedAgentInvocationProviderId } from "../core/managed-invocation.js";
import {
  canonicalTuttiProviderId,
  isRecord,
  optionalString,
} from "./internal.js";
import { providerAuthAvailability } from "./provider-readiness.js";

export interface LoadTuttiAgentProviderCatalogInput
  extends Omit<TuttiCliJsonRequest, "args"> {
  runtime: LocalAgentRuntime<string, string>;
  detectContext?: DetectContext;
}

export async function loadTuttiAgentProviderCatalog(
  input: LoadTuttiAgentProviderCatalogInput,
): Promise<TuttiAgentProviderCatalog> {
  if (hasConfiguredTuttiCli(input)) {
    const payload = await runTuttiCliJson({
      ...input,
      args: ["--json", "agent", "providers"],
    });
    return parseCliProviderCatalog(payload, input.runtime, input.detectContext);
  }
  return await loadStandaloneProviderCatalog(input.runtime, input.detectContext);
}

export function parseTuttiAgentProviderCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
): TuttiAgentProviderCatalog {
  return parseCliProviderCatalog(payload, runtime);
}

function parseCliProviderCatalog(
  payload: unknown,
  runtime: Pick<LocalAgentRuntime<string, string>, "listProviders">,
  detectContext?: DetectContext,
): TuttiAgentProviderCatalog {
  if (!isRecord(payload)) {
    throw invalidCatalog("Tutti provider catalog is not an object.");
  }
  if (payload.schemaVersion !== 2) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti provider catalog schema is unsupported.",
      { schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1 },
    );
  }
  if (typeof payload.defaultProviderId !== "string" || !Array.isArray(payload.providers)) {
    throw invalidCatalog("Tutti provider catalog fields are invalid.");
  }

  const runtimeProviderIds = new Set(
    runtime.listProviders().map((provider) => String(provider.id)),
  );
  const managedInvocation = Boolean(detectContext?.managedAgentInvocation);
  const seen = new Set<string>();
  const providers = payload.providers.map((value, index) => {
    if (!isRecord(value)) {
      throw invalidCatalog(`Tutti provider catalog entry ${index} is invalid.`);
    }
    const providerId = canonicalTuttiProviderId(
      requiredString(value.providerId, `providers[${index}].providerId`),
    );
    if (seen.has(providerId)) {
      throw invalidCatalog(`Tutti provider catalog contains duplicate provider ${providerId}.`);
    }
    seen.add(providerId);
    const runtimeRegistered = runtimeProviderIds.has(providerId);
    const managedSupported =
      !managedInvocation || isManagedAgentInvocationProviderId(providerId);
    const runtimeSupported = runtimeRegistered && managedSupported;
    const platformAvailability = parseAvailability(value.availability, index);
    const availability =
      !runtimeSupported
        ? {
            status: "unavailable" as const,
            reasonCode: runtimeRegistered
              ? "managed_provider_unsupported"
              : "kit_runtime_unavailable",
            detail: runtimeRegistered
              ? "Managed execution does not support this provider."
              : "The installed agent-acp-kit cannot execute this provider.",
          }
        : platformAvailability;
    return {
      providerId,
      displayName: requiredString(value.displayName, `providers[${index}].displayName`),
      ...(optionalString(value.agentTargetId)
        ? { agentTargetId: optionalString(value.agentTargetId) }
        : {}),
      availability,
      runtimeSupported,
    } satisfies TuttiAgentProviderCatalogEntry;
  });

  const defaultProviderId = canonicalTuttiProviderId(payload.defaultProviderId.trim());
  const configuredDefault = providers.find(
    (provider) => provider.providerId === defaultProviderId,
  );
  const usableDefault =
    configuredDefault?.runtimeSupported &&
    configuredDefault.availability.status === "available"
      ? configuredDefault
      : providers.find(
          (provider) =>
            provider.runtimeSupported &&
            provider.availability.status === "available",
        ) ?? providers.find((provider) => provider.runtimeSupported);
  return {
    schemaVersion: 2,
    source: "tutti-cli",
    defaultProviderId: usableDefault?.providerId ?? providers[0]?.providerId ?? "",
    providers,
  };
}

async function loadStandaloneProviderCatalog(
  runtime: LocalAgentRuntime<string, string>,
  detectContext?: DetectContext,
): Promise<TuttiAgentProviderCatalog> {
  const descriptors = runtime.listProviders();
  const detections = await runtime.detect(detectContext);
  const byProvider = new Map(
    detections.map((detection) => [String(detection.provider), detection.result]),
  );
  const providers = descriptors.map((descriptor) => {
    const providerId = String(descriptor.id);
    const runtimeSupported =
      !detectContext?.managedAgentInvocation ||
      isManagedAgentInvocationProviderId(providerId);
    return {
      providerId,
      displayName: descriptor.displayName,
      availability: runtimeSupported
          ? standaloneAvailability(
              byProvider.get(providerId),
              descriptor.requiresKnownAuth === true,
            )
        : {
            status: "unavailable",
            reasonCode: "managed_provider_unsupported",
            detail: "Managed execution does not support this provider.",
          },
      runtimeSupported,
    } satisfies TuttiAgentProviderCatalogEntry;
  });
  return {
    schemaVersion: 2,
    source: "standalone",
    defaultProviderId:
      providers.find(
        (provider) =>
          provider.runtimeSupported &&
          provider.availability.status === "available",
      )?.providerId ??
      providers.find((provider) => provider.runtimeSupported)?.providerId ??
      providers[0]?.providerId ??
      "",
    providers,
  };
}

function standaloneAvailability(
  detection: Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>[number]["result"] | undefined,
  requiresKnownAuth: boolean,
): TuttiAgentProviderAvailability {
  if (!detection) {
    return {
      status: "unavailable",
      reasonCode: "runtime_not_detected",
      detail: "Provider runtime was not detected.",
    };
  }
  if (detection.supported === false) {
    return {
      status: "unavailable",
      reasonCode: "provider_unsupported",
      detail: detection.unsupportedReason ?? "Provider runtime is unsupported.",
    };
  }
  const authAvailability = providerAuthAvailability(
    detection.authState,
    requiresKnownAuth,
  );
  if (authAvailability) return authAvailability;
  return { status: "available", reasonCode: "", detail: "" };
}

function parseAvailability(value: unknown, index: number): TuttiAgentProviderAvailability {
  if (!isRecord(value)) {
    throw invalidCatalog(`Tutti provider catalog availability ${index} is invalid.`);
  }
  if (value.status !== "available" && value.status !== "unavailable" && value.status !== "unknown") {
    throw invalidCatalog(`Tutti provider catalog availability status ${index} is invalid.`);
  }
  return {
    status: value.status,
    reasonCode: optionalString(value.reasonCode) ?? "",
    detail: optionalString(value.detail) ?? "",
  };
}

function invalidCatalog(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}

function requiredString(value: unknown, field: string) {
  const normalized = optionalString(value);
  if (!normalized) throw invalidCatalog(`Tutti provider catalog ${field} is invalid.`);
  return normalized;
}
