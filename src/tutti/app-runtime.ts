import type { AgentEvent } from "../core/events.js";
import {
  createManagedAgentRunContextFromHeaders,
  getManagedAgentInvocationCredentialFromHeaders,
  isManagedAgentInvocationProviderId,
  type ManagedAgentInvocationCredentialHeaders,
} from "../core/managed-invocation.js";
import type { AgentRunInput } from "../core/run-input.js";
import { createDefaultLocalAgentRuntime } from "../runtime/create-default-runtime.js";
import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import { TuttiAgentAppRuntimeError } from "./errors.js";
import {
  displayNameForTuttiAgentProvider,
  normalizeAgentProviderId,
  toTuttiCatalogProviderId,
  toTuttiRuntimeProviderId,
} from "./provider-id.js";
import {
  createTuttiWorkspaceAppAgentClient,
  type TuttiAgentComposerOptions,
  type TuttiWorkspaceAppAgentClient,
  type TuttiWorkspaceAppAgentEnvironment,
} from "./workspace-app-client.js";

export type TuttiAgentAppRuntimeMode = "auto" | "tutti" | "standalone";
export type TuttiAgentProviderCatalogSource = "tutti" | "standalone";
export type TuttiAgentProviderCatalogStatus = "ready" | "unavailable";
export type TuttiAgentProviderAuthState =
  | "authenticated"
  | "required"
  | "expired"
  | "unknown";

export interface TuttiAgentProviderCatalogModel {
  id: string;
  label: string;
  description?: string;
}

export interface TuttiAgentProviderCatalogEntry {
  id: string;
  displayName: string;
  available: boolean;
  reasonCode?: string;
  authState: TuttiAgentProviderAuthState;
  models: TuttiAgentProviderCatalogModel[];
  defaultModelId?: string;
  composerOptions?: TuttiAgentComposerOptions;
  composerStatus?: "ready" | "unavailable";
}

export interface TuttiAgentProviderCatalog {
  source: TuttiAgentProviderCatalogSource;
  status: TuttiAgentProviderCatalogStatus;
  capturedAt: string | null;
  defaultProviderId: string | null;
  selectedProviderId: string | null;
  providers: TuttiAgentProviderCatalogEntry[];
  errorCode?: string;
}

export interface TuttiAgentProviderCatalogInput {
  preferredProviderId?: string | null;
  refresh?: boolean;
  composer?: {
    cwd?: string;
    locale?: string;
    settings?: Record<string, unknown>;
  };
  includeComposerOptions?: boolean;
}

export interface PrepareTuttiAgentRunInput {
  headers?: ManagedAgentInvocationCredentialHeaders;
  providerId: string;
  runId: string;
  localCwd: string;
}

type PlatformOwnedAgentRunInputKeys =
  | "runId"
  | "provider"
  | "cwd"
  | "runtimeKind"
  | "runtimeProvider"
  | "managedAgentInvocation";

export type TuttiAgentRunExecutionInput = Omit<
  AgentRunInput<string, string>,
  PlatformOwnedAgentRunInputKeys
>;

export type TuttiAgentAppRunInput = TuttiAgentRunExecutionInput &
  PrepareTuttiAgentRunInput;

export interface PreparedTuttiAgentRun {
  providerId: string;
  cwd: string;
  execute(input: TuttiAgentRunExecutionInput): AsyncGenerator<AgentEvent>;
}

export interface TuttiAgentAppRuntime {
  getProviderCatalog(
    input?: TuttiAgentProviderCatalogInput,
  ): Promise<TuttiAgentProviderCatalog>;
  prepareRun(input: PrepareTuttiAgentRunInput): Promise<PreparedTuttiAgentRun>;
  run(input: TuttiAgentAppRunInput): AsyncGenerator<AgentEvent>;
  cancel(runId: string): Promise<void>;
}

export interface CreateTuttiAgentAppRuntimeOptions {
  runtime?: LocalAgentRuntime<string, string>;
  mode?: TuttiAgentAppRuntimeMode;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
  client?: TuttiWorkspaceAppAgentClient;
}

export function createTuttiAgentAppRuntime(
  options: CreateTuttiAgentAppRuntimeOptions = {},
): TuttiAgentAppRuntime {
  const runtime = options.runtime ?? createDefaultLocalAgentRuntime();
  const runtimeEnv = options.env ?? process.env;
  const resolvedMode = resolveTuttiAgentAppRuntimeMode(
    options.mode ?? "auto",
    runtimeEnv,
  );
  const client =
    resolvedMode.mode === "tutti"
      ? (options.client ??
        createTuttiWorkspaceAppAgentClient({
          environment: resolvedMode.environment,
          ...(options.fetch ? { fetch: options.fetch } : {}),
          ...(options.requestTimeoutMs
            ? { requestTimeoutMs: options.requestTimeoutMs }
            : {}),
        }))
      : undefined;

  return {
    async getProviderCatalog(input = {}) {
      if (resolvedMode.mode === "standalone") {
        return await resolveStandaloneProviderCatalog(runtime, input);
      }
      return await resolveManagedProviderCatalog(runtime, client!, input);
    },

    async prepareRun(input) {
      const providerId = toTuttiCatalogProviderId(input.providerId);
      const runtimeProviderId = toTuttiRuntimeProviderId(providerId);
      const registered = runtime
        .listProviders()
        .some((provider) => provider.id === runtimeProviderId);
      if (!registered) {
        throw new TuttiAgentAppRuntimeError(
          "provider_runtime_unavailable",
          `No local agent runtime is registered for ${providerId}.`,
        );
      }

      const localCwd = input.localCwd.trim();
      if (!localCwd) {
        throw new TuttiAgentAppRuntimeError(
          "local_cwd_required",
          "A local cwd is required for standalone agent execution.",
        );
      }

      const credential = getManagedAgentInvocationCredentialFromHeaders(
        input.headers,
      );
      if (
        credential &&
        !isManagedAgentInvocationProviderId(runtimeProviderId)
      ) {
        throw new TuttiAgentAppRuntimeError(
          "managed_provider_unsupported",
          `Managed execution does not support ${providerId}.`,
        );
      }

      let runContext;
      try {
        runContext = await createManagedAgentRunContextFromHeaders(
          input.headers,
          {
            providerId: runtimeProviderId,
            runId: input.runId,
            env: runtimeEnv,
          },
        );
      } catch (error) {
        throw new TuttiAgentAppRuntimeError(
          "tutti_run_context_failed",
          "Unable to create the Tutti agent run context.",
          { cause: error },
        );
      }

      const cwd = runContext?.cwd ?? localCwd;
      let started = false;
      return {
        providerId,
        cwd,
        execute(executionInput) {
          if (started) {
            throw new TuttiAgentAppRuntimeError(
              "prepared_run_already_started",
              "A prepared Tutti agent run can only be executed once.",
            );
          }
          started = true;
          return runtime.run({
            ...executionInput,
            runId: input.runId,
            provider: runtimeProviderId,
            runtimeKind: "local-agent",
            runtimeProvider: runtimeProviderId,
            cwd,
            ...(runContext
              ? { managedAgentInvocation: runContext.managedAgentInvocation }
              : {}),
          });
        },
      };
    },

    async *run(input) {
      const { headers, providerId, runId, localCwd, ...executionInput } = input;
      const prepared = await this.prepareRun({
        headers,
        providerId,
        runId,
        localCwd,
      });
      yield* prepared.execute(executionInput);
    },

    async cancel(runId) {
      await runtime.cancel(runId);
    },
  };
}

async function resolveManagedProviderCatalog(
  runtime: LocalAgentRuntime<string, string>,
  client: TuttiWorkspaceAppAgentClient,
  input: TuttiAgentProviderCatalogInput,
): Promise<TuttiAgentProviderCatalog> {
  let snapshot;
  try {
    snapshot = await client.getProviderStatuses();
  } catch (error) {
    return {
      source: "tutti",
      status: "unavailable",
      capturedAt: null,
      defaultProviderId: null,
      selectedProviderId: null,
      providers: [],
      errorCode:
        error instanceof TuttiAgentAppRuntimeError
          ? error.code
          : "tutti_catalog_request_failed",
    };
  }

  const registeredProviders = new Map(
    runtime
      .listProviders()
      .map((provider) => [provider.id, provider.displayName]),
  );
  const includeComposerOptions = input.includeComposerOptions !== false;
  const providers = await Promise.all(
    snapshot.providers.map(async (status) => {
      const id = toTuttiCatalogProviderId(status.provider);
      const runtimeProviderId = toTuttiRuntimeProviderId(id);
      const runtimeDisplayName = registeredProviders.get(runtimeProviderId);
      const runtimeSupported = registeredProviders.has(runtimeProviderId);
      const daemonReady = status.availability.status === "ready";
      const available = daemonReady && runtimeSupported;
      const reasonCode =
        !daemonReady
          ? (status.availability.reasonCode ?? status.availability.status)
          : !runtimeSupported
            ? "kit_runtime_unavailable"
            : undefined;

      let composerOptions: TuttiAgentComposerOptions | undefined;
      let composerStatus: "ready" | "unavailable" | undefined;
      if (available && includeComposerOptions) {
        try {
          composerOptions = await client.getProviderComposerOptions(
            status.provider,
            input.composer,
          );
          composerStatus = "ready";
        } catch {
          composerStatus = "unavailable";
        }
      }
      const models = composerOptions
        ? modelsFromComposerOptions(composerOptions)
        : [];
      const defaultModelId = composerOptions
        ? defaultModelFromComposerOptions(composerOptions)
        : undefined;

      return {
        id,
        displayName: displayNameForTuttiAgentProvider(
          id,
          runtimeDisplayName,
        ),
        available,
        ...(reasonCode ? { reasonCode } : {}),
        authState: mapDaemonAuthState(status.auth?.status),
        models,
        ...(defaultModelId ? { defaultModelId } : {}),
        ...(composerOptions ? { composerOptions } : {}),
        ...(composerStatus ? { composerStatus } : {}),
      } satisfies TuttiAgentProviderCatalogEntry;
    }),
  );

  const defaultProviderId = snapshot.defaultProvider
    ? toTuttiCatalogProviderId(snapshot.defaultProvider)
    : null;
  return {
    source: "tutti",
    status: "ready",
    capturedAt: snapshot.capturedAt,
    defaultProviderId,
    selectedProviderId: selectProviderId(
      providers,
      defaultProviderId,
      input.preferredProviderId,
    ),
    providers,
  };
}

async function resolveStandaloneProviderCatalog(
  runtime: LocalAgentRuntime<string, string>,
  input: TuttiAgentProviderCatalogInput,
): Promise<TuttiAgentProviderCatalog> {
  let detections;
  try {
    detections = await runtime.detect(
      input.refresh ? { refresh: true } : undefined,
    );
  } catch {
    return {
      source: "standalone",
      status: "unavailable",
      capturedAt: null,
      defaultProviderId: null,
      selectedProviderId: null,
      providers: [],
      errorCode: "standalone_detection_failed",
    };
  }

  const providers = detections.map((detection) => {
    const result = detection.result;
    const available = Boolean(result && result.supported !== false);
    return {
      id: toTuttiCatalogProviderId(detection.provider),
      displayName: displayNameForTuttiAgentProvider(
        detection.provider,
        detection.displayName,
      ),
      available,
      ...(!available
        ? {
            reasonCode:
              result?.supported === false ? "unsupported" : "not_installed",
          }
        : {}),
      authState: mapRuntimeAuthState(result?.authState),
      models: (result?.models ?? []).map((model) => ({
        id: model.id,
        label: model.label,
        ...(model.description ? { description: model.description } : {}),
      })),
    } satisfies TuttiAgentProviderCatalogEntry;
  });

  return {
    source: "standalone",
    status: "ready",
    capturedAt: null,
    defaultProviderId: null,
    selectedProviderId: selectProviderId(
      providers,
      null,
      input.preferredProviderId,
    ),
    providers,
  };
}

function modelsFromComposerOptions(
  options: TuttiAgentComposerOptions,
): TuttiAgentProviderCatalogModel[] {
  return options.modelConfig.options.map((option) => ({
    id: option.value,
    label: option.label,
    ...(option.description ? { description: option.description } : {}),
  }));
}

function defaultModelFromComposerOptions(options: TuttiAgentComposerOptions) {
  return (
    options.modelConfig.currentValue ??
    options.modelConfig.defaultValue ??
    options.modelConfig.options[0]?.value
  );
}

function selectProviderId(
  providers: readonly TuttiAgentProviderCatalogEntry[],
  defaultProviderId: string | null,
  preferredProviderId: string | null | undefined,
) {
  const available = new Set(
    providers.filter((provider) => provider.available).map((provider) => provider.id),
  );
  if (defaultProviderId && available.has(defaultProviderId)) {
    return defaultProviderId;
  }
  const preferred = preferredProviderId
    ? toTuttiCatalogProviderId(preferredProviderId)
    : "";
  if (preferred && available.has(preferred)) return preferred;
  return providers.find((provider) => provider.available)?.id ?? null;
}

function mapDaemonAuthState(
  value: "authenticated" | "required" | "unknown" | undefined,
): TuttiAgentProviderAuthState {
  return value ?? "unknown";
}

function mapRuntimeAuthState(
  value: "ok" | "missing" | "expired" | "unknown" | undefined,
): TuttiAgentProviderAuthState {
  if (value === "ok") return "authenticated";
  if (value === "missing") return "required";
  return value ?? "unknown";
}

function resolveTuttiAgentAppRuntimeMode(
  mode: TuttiAgentAppRuntimeMode,
  env: Record<string, string | undefined>,
):
  | { mode: "standalone" }
  | { mode: "tutti"; environment: TuttiWorkspaceAppAgentEnvironment } {
  if (mode === "standalone") return { mode: "standalone" };

  const values = {
    apiBaseUrl: env.TUTTI_API_BASE_URL?.trim() ?? "",
    appId: env.TUTTI_APP_ID?.trim() ?? "",
    appServerToken: env.TUTTI_APP_SERVER_TOKEN?.trim() ?? "",
    workspaceId: env.TUTTI_WORKSPACE_ID?.trim() ?? "",
  };
  const present = Object.values(values).filter(Boolean).length;
  if (mode === "auto" && present === 0) return { mode: "standalone" };
  if (present !== Object.keys(values).length) {
    throw new TuttiAgentAppRuntimeError(
      "incomplete_tutti_app_environment",
      "Tutti agent integration requires TUTTI_API_BASE_URL, TUTTI_APP_ID, TUTTI_APP_SERVER_TOKEN, and TUTTI_WORKSPACE_ID together.",
    );
  }
  return { mode: "tutti", environment: values };
}

export { TuttiAgentAppRuntimeError } from "./errors.js";
export type { TuttiAgentAppRuntimeErrorCode } from "./errors.js";
