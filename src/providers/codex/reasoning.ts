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
