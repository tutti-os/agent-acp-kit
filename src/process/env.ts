export function mergeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(overrides ?? {}),
  };
}
