import { tmpdir } from "node:os";

export function mergeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
): NodeJS.ProcessEnv {
  return {
    ...baseEnv,
    ...(overrides ?? {}),
  };
}

export function resolveTempDir(env?: Record<string, string | undefined>) {
  return (
    env?.TMPDIR?.trim() ||
    env?.TEMP?.trim() ||
    env?.TMP?.trim() ||
    process.env.TMPDIR?.trim() ||
    process.env.TEMP?.trim() ||
    process.env.TMP?.trim() ||
    tmpdir()
  );
}
