const TUTTI_TO_RUNTIME_PROVIDER_IDS: Readonly<Record<string, string>> = {
  "claude-code": "claude",
  "tutti-agent": "nexight",
};

const RUNTIME_TO_TUTTI_PROVIDER_IDS: Readonly<Record<string, string>> = {
  claude: "claude-code",
  nexight: "tutti-agent",
};

export function normalizeAgentProviderId(providerId: string) {
  return providerId.trim().toLowerCase().replace(/[^a-z0-9_.-]/g, "");
}

export function toTuttiRuntimeProviderId(providerId: string) {
  const normalized = normalizeAgentProviderId(providerId);
  return TUTTI_TO_RUNTIME_PROVIDER_IDS[normalized] ?? normalized;
}

export function toTuttiCatalogProviderId(providerId: string) {
  const normalized = normalizeAgentProviderId(providerId);
  return RUNTIME_TO_TUTTI_PROVIDER_IDS[normalized] ?? normalized;
}

export function displayNameForTuttiAgentProvider(
  providerId: string,
  runtimeDisplayName?: string | null,
) {
  const displayName = runtimeDisplayName?.trim();
  if (displayName) return displayName;

  const normalized = toTuttiCatalogProviderId(providerId);
  const knownNames: Readonly<Record<string, string>> = {
    "claude-code": "Claude Code",
    codex: "Codex",
    cursor: "Cursor Agent",
    opencode: "OpenCode",
    "tutti-agent": "Tutti Agent",
    hermes: "Hermes",
    openclaw: "OpenClaw",
  };
  if (knownNames[normalized]) return knownNames[normalized];

  return normalized
    .split(/[-_.]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}
