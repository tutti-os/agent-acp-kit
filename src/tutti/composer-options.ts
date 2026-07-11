import type { LocalAgentRuntime } from "../runtime/create-runtime.js";
import type { DetectContext } from "../core/detection.js";
import { isAgentPermissionSemantic } from "../core/permissions.js";
import type {
  TuttiAgentComposerConfig,
  TuttiAgentComposerOption,
  TuttiAgentComposerOptions,
  TuttiAgentPermissionConfig,
  TuttiAgentProviderCatalog,
} from "./contracts.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import { loadTuttiAgentProviderCatalog } from "./provider-catalog.js";
import {
  canonicalTuttiProviderId,
  isRecord,
  optionalString,
} from "./internal.js";

export interface LoadTuttiAgentComposerOptionsInput
  extends Omit<TuttiCliJsonRequest, "args"> {
  providerId: string;
  runtime: LocalAgentRuntime<string, string>;
  locale?: string;
  model?: string;
  permissionMode?: string;
  reasoningEffort?: string;
}

export async function loadTuttiAgentComposerOptions(
  input: LoadTuttiAgentComposerOptionsInput,
): Promise<TuttiAgentComposerOptions> {
  const catalog = await loadTuttiAgentProviderCatalog(input);
  return loadTuttiAgentComposerOptionsWithCatalog(input, catalog);
}

/** Internal facade hook for callers that already loaded the visibility catalog. */
export async function loadTuttiAgentComposerOptionsWithCatalog(
  input: LoadTuttiAgentComposerOptionsInput,
  catalog: TuttiAgentProviderCatalog,
): Promise<TuttiAgentComposerOptions> {
  const providerId = canonicalTuttiProviderId(input.providerId.trim());
  const provider = catalog.providers.find((entry) => entry.providerId === providerId);
  if (!provider) {
    throw new TuttiIntegrationError(
      "provider_not_found",
      "Agent provider is not present in the provider catalog.",
      { providerId },
    );
  }
  if (!provider.runtimeSupported) {
    throw new TuttiIntegrationError(
      "provider_runtime_unavailable",
      "The installed agent-acp-kit cannot execute this provider.",
      { providerId },
    );
  }

  if (hasConfiguredTuttiCli(input)) {
    const payload = await runTuttiCliJson({
      ...input,
      args: createComposerArgs(input, providerId),
    });
    return parseTuttiAgentComposerOptions(payload, providerId, "tutti-cli");
  }
  return await standaloneComposerOptions(
    input.runtime,
    providerId,
    input.model,
    input.detectContext,
  );
}

export function parseTuttiAgentComposerOptions(
  payload: unknown,
  expectedProviderId: string,
  source: "tutti-cli" | "standalone" = "tutti-cli",
): TuttiAgentComposerOptions {
  if (!isRecord(payload)) throw invalidComposer("Tutti composer response is not an object.");
  if (payload.schemaVersion !== 1) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti composer options schema is unsupported.",
      { schemaVersion: typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1 },
    );
  }
  const providerId = optionalString(payload.providerId) ?? optionalString(payload.provider);
  if (!providerId || providerId !== expectedProviderId) {
    throw invalidComposer("Tutti composer response provider does not match the request.");
  }
  return {
    schemaVersion: 1,
    source,
    providerId,
    effectiveSettings: isRecord(payload.effectiveSettings) ? payload.effectiveSettings : {},
    modelConfig: parseComposerConfig(payload.modelConfig, "modelConfig"),
    permissionConfig: parsePermissionConfig(payload.permissionConfig),
    reasoningConfig: parseComposerConfig(payload.reasoningConfig, "reasoningConfig"),
    speedConfig: parseComposerConfig(payload.speedConfig, "speedConfig"),
  };
}

async function standaloneComposerOptions(
  runtime: LocalAgentRuntime<string, string>,
  providerId: string,
  selectedModel?: string,
  detectContext?: DetectContext,
): Promise<TuttiAgentComposerOptions> {
  const detection = (await runtime.detect(detectContext)).find(
    (entry) => String(entry.provider) === providerId,
  )?.result;
  const options = (detection?.models ?? []).map((model) => ({
    id: model.id,
    value: model.id,
    label: model.label,
    ...(model.description ? { description: model.description } : {}),
  }));
  const defaultValue = options[0]?.value ?? "";
  const currentValue = optionalString(selectedModel) ?? defaultValue;
  const unavailableConfig = emptyComposerConfig();
  return {
    schemaVersion: 1,
    source: "standalone",
    providerId,
    effectiveSettings: currentValue ? { model: currentValue } : {},
    modelConfig: {
      configurable: options.length > 0,
      currentValue,
      defaultValue,
      options,
    },
    permissionConfig: { configurable: false, defaultValue: "", modes: [] },
    reasoningConfig: unavailableConfig,
    speedConfig: emptyComposerConfig(),
  };
}

function createComposerArgs(input: LoadTuttiAgentComposerOptionsInput, providerId: string) {
  return [
    "--json",
    "agent",
    "composer-options",
    "--provider",
    providerId,
    ...(optionalString(input.cwd) ? ["--cwd", optionalString(input.cwd)!] : []),
    ...(optionalString(input.locale) ? ["--locale", optionalString(input.locale)!] : []),
    ...(optionalString(input.model) ? ["--model", optionalString(input.model)!] : []),
    ...(optionalString(input.permissionMode)
      ? ["--permission-mode", optionalString(input.permissionMode)!]
      : []),
    ...(optionalString(input.reasoningEffort)
      ? ["--reasoning-effort", optionalString(input.reasoningEffort)!]
      : []),
  ];
}

function parseComposerConfig(value: unknown, label: string): TuttiAgentComposerConfig {
  if (!isRecord(value) || !Array.isArray(value.options)) {
    throw invalidComposer(`Tutti composer ${label} is invalid.`);
  }
  return {
    configurable: value.configurable === true,
    currentValue: optionalString(value.currentValue) ?? "",
    defaultValue: optionalString(value.defaultValue) ?? "",
    options: value.options.map((option, index) => parseComposerOption(option, `${label}.options[${index}]`)),
  };
}

function parseComposerOption(value: unknown, label: string): TuttiAgentComposerOption {
  if (!isRecord(value)) throw invalidComposer(`Tutti composer ${label} is invalid.`);
  const id = optionalString(value.id);
  const optionValue = optionalString(value.value);
  const optionLabel = optionalString(value.label);
  if (!id || !optionValue || !optionLabel) {
    throw invalidComposer(`Tutti composer ${label} fields are invalid.`);
  }
  return {
    id,
    value: optionValue,
    label: optionLabel,
    ...(optionalString(value.description) ? { description: optionalString(value.description) } : {}),
    ...(typeof value.supportsImageInput === "boolean"
      ? { supportsImageInput: value.supportsImageInput }
      : {}),
  };
}

function parsePermissionConfig(value: unknown): TuttiAgentPermissionConfig {
  if (!isRecord(value) || !Array.isArray(value.modes)) {
    throw invalidComposer("Tutti composer permissionConfig is invalid.");
  }
  return {
    configurable: value.configurable === true,
    defaultValue: optionalString(value.defaultValue) ?? "",
    modes: value.modes.map((mode, index) => {
      if (!isRecord(mode)) throw invalidComposer(`Tutti composer permission mode ${index} is invalid.`);
      const id = optionalString(mode.id);
      const label = optionalString(mode.label);
      const semantic = optionalString(mode.semantic);
      if (!id || !label || !isAgentPermissionSemantic(semantic)) {
        throw invalidComposer(`Tutti composer permission mode ${index} fields are invalid.`);
      }
      return {
        id,
        label,
        semantic,
        ...(optionalString(mode.description) ? { description: optionalString(mode.description) } : {}),
      };
    }),
  };
}

function emptyComposerConfig(): TuttiAgentComposerConfig {
  return { configurable: false, currentValue: "", defaultValue: "", options: [] };
}

function invalidComposer(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}
