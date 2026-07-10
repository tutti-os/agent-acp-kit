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
    return parseCliProviderCatalog(payload, input.runtime);
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
  const seen = new Set<string>();
  const providers = payload.providers.map((value, index) => {
    if (!isRecord(value)) {
      throw invalidCatalog(`Tutti provider catalog entry ${index} is invalid.`);
    }
    const providerId = requiredString(value.providerId, `providers[${index}].providerId`);
    if (seen.has(providerId)) {
      throw invalidCatalog(`Tutti provider catalog contains duplicate provider ${providerId}.`);
    }
    seen.add(providerId);
    const runtimeSupported = runtimeProviderIds.has(providerId);
    const platformAvailability = parseAvailability(value.availability, index);
    const availability =
      !runtimeSupported && platformAvailability.status === "available"
        ? {
            status: "unavailable" as const,
            reasonCode: "kit_runtime_unavailable",
            detail: "The installed agent-acp-kit cannot execute this provider.",
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

  const defaultProviderId = payload.defaultProviderId.trim();
  return {
    schemaVersion: 2,
    source: "tutti-cli",
    defaultProviderId:
      defaultProviderId && seen.has(defaultProviderId)
        ? defaultProviderId
        : providers[0]?.providerId ?? "",
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
  const providers = descriptors.map((descriptor) => ({
    providerId: String(descriptor.id),
    displayName: descriptor.displayName,
    availability: standaloneAvailability(byProvider.get(String(descriptor.id))),
    runtimeSupported: true,
  } satisfies TuttiAgentProviderCatalogEntry));
  return {
    schemaVersion: 2,
    source: "standalone",
    defaultProviderId:
      providers.find((provider) => provider.availability.status === "available")
        ?.providerId ?? providers[0]?.providerId ?? "",
    providers,
  };
}

function standaloneAvailability(
  detection: Awaited<ReturnType<LocalAgentRuntime<string, string>["detect"]>>[number]["result"] | undefined,
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
  if (detection.authState === "missing") {
    return { status: "unavailable", reasonCode: "auth_required", detail: "Authentication is required." };
  }
  if (detection.authState === "expired") {
    return { status: "unavailable", reasonCode: "auth_expired", detail: "Authentication has expired." };
  }
  if (detection.authState === "unknown") {
    return { status: "unknown", reasonCode: "auth_unknown", detail: "Authentication status is unknown." };
  }
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

function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
