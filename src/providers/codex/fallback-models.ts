export const CODEX_FALLBACK_MODELS = [
  { id: "default", label: "Default (CLI config)" },
  { id: "gpt-5.5", label: "gpt-5.5" },
  { id: "gpt-5.4", label: "gpt-5.4" },
  { id: "gpt-5.4-mini", label: "gpt-5.4-mini" },
  { id: "gpt-5.3-codex", label: "gpt-5.3-codex" },
  { id: "gpt-5-codex", label: "gpt-5-codex" },
];

export function clampCodexReasoning(
  modelId: string | undefined,
  effort: string | undefined,
) {
  if (!effort) return effort;
  if (!modelId || modelId === "default") {
    return effort === "minimal" ? "low" : effort;
  }
  if (modelId.startsWith("gpt-5.4") || modelId.startsWith("gpt-5.5")) {
    return effort === "minimal" ? "low" : effort;
  }
  return effort;
}
