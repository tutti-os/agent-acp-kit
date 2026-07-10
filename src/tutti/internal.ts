export function optionalString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export function canonicalTuttiProviderId(providerId: string) {
  return providerId === "claude" ? "claude-code" : providerId;
}
