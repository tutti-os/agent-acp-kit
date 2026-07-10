export type TuttiAgentIntegrationSource = "tutti-cli" | "standalone";

export type TuttiAgentAvailabilityStatus =
  | "available"
  | "unavailable"
  | "unknown";

export interface TuttiAgentProviderAvailability {
  status: TuttiAgentAvailabilityStatus;
  reasonCode: string;
  detail: string;
}

export interface TuttiAgentProviderCatalogEntry {
  providerId: string;
  displayName: string;
  agentTargetId?: string;
  availability: TuttiAgentProviderAvailability;
  runtimeSupported: boolean;
}

export interface TuttiAgentProviderCatalog {
  schemaVersion: 2;
  source: TuttiAgentIntegrationSource;
  defaultProviderId: string;
  providers: TuttiAgentProviderCatalogEntry[];
}

export interface TuttiAgentComposerOption {
  id: string;
  value: string;
  label: string;
  description?: string;
  supportsImageInput?: boolean;
}

export interface TuttiAgentComposerConfig {
  configurable: boolean;
  currentValue: string;
  defaultValue: string;
  options: TuttiAgentComposerOption[];
}

export interface TuttiAgentPermissionMode {
  id: string;
  label: string;
  description?: string;
  semantic?: string;
}

export interface TuttiAgentPermissionConfig {
  configurable: boolean;
  defaultValue: string;
  modes: TuttiAgentPermissionMode[];
}

export interface TuttiAgentComposerOptions {
  schemaVersion: 1;
  source: TuttiAgentIntegrationSource;
  providerId: string;
  effectiveSettings: Record<string, unknown>;
  modelConfig: TuttiAgentComposerConfig;
  permissionConfig: TuttiAgentPermissionConfig;
  reasoningConfig: TuttiAgentComposerConfig;
  speedConfig: TuttiAgentComposerConfig;
}

export function isTuttiAgentProviderCatalog(
  value: unknown,
): value is TuttiAgentProviderCatalog {
  if (!isRecord(value) || value.schemaVersion !== 2) return false;
  if (value.source !== "tutti-cli" && value.source !== "standalone") return false;
  if (typeof value.defaultProviderId !== "string" || !Array.isArray(value.providers)) {
    return false;
  }
  if (!value.providers.every(isProviderCatalogEntry)) return false;
  const providerIds = value.providers.map((provider) => provider.providerId);
  if (new Set(providerIds).size !== providerIds.length) return false;
  return providerIds.length === 0
    ? value.defaultProviderId === ""
    : providerIds.includes(value.defaultProviderId);
}

export function isTuttiAgentComposerOptions(
  value: unknown,
): value is TuttiAgentComposerOptions {
  return isRecord(value) &&
    value.schemaVersion === 1 &&
    (value.source === "tutti-cli" || value.source === "standalone") &&
    typeof value.providerId === "string" &&
    isRecord(value.effectiveSettings) &&
    isComposerConfig(value.modelConfig) &&
    isPermissionConfig(value.permissionConfig) &&
    isComposerConfig(value.reasoningConfig) &&
    isComposerConfig(value.speedConfig);
}

function isProviderCatalogEntry(value: unknown) {
  return isRecord(value) &&
    isNonEmptyString(value.providerId) &&
    isNonEmptyString(value.displayName) &&
    (value.agentTargetId === undefined || isNonEmptyString(value.agentTargetId)) &&
    typeof value.runtimeSupported === "boolean" &&
    isAvailability(value.availability);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isAvailability(value: unknown) {
  return isRecord(value) &&
    (value.status === "available" || value.status === "unavailable" || value.status === "unknown") &&
    typeof value.reasonCode === "string" &&
    typeof value.detail === "string";
}

function isComposerConfig(value: unknown) {
  return isRecord(value) &&
    typeof value.configurable === "boolean" &&
    typeof value.currentValue === "string" &&
    typeof value.defaultValue === "string" &&
    Array.isArray(value.options) &&
    value.options.every(
      (option) =>
        isRecord(option) &&
        typeof option.id === "string" &&
        typeof option.value === "string" &&
        typeof option.label === "string" &&
        (option.description === undefined || typeof option.description === "string") &&
        (option.supportsImageInput === undefined ||
          typeof option.supportsImageInput === "boolean"),
    );
}

function isPermissionConfig(value: unknown) {
  return isRecord(value) &&
    typeof value.configurable === "boolean" &&
    typeof value.defaultValue === "string" &&
    Array.isArray(value.modes) &&
    value.modes.every(
      (mode) =>
        isRecord(mode) &&
        typeof mode.id === "string" &&
        typeof mode.label === "string" &&
        (mode.description === undefined || typeof mode.description === "string") &&
        (mode.semantic === undefined || typeof mode.semantic === "string"),
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
