import type { DetectContext } from "../core/detection.js";
import { redactSecrets } from "../core/redaction.js";

export interface ProjectTuttiCliChildProcessInput {
  baseEnv?: Readonly<NodeJS.ProcessEnv>;
  detectContext?: DetectContext;
}

export interface TuttiCliChildProcessProjection {
  env: Readonly<NodeJS.ProcessEnv>;
  redactionSecrets: readonly string[];
}

export function projectTuttiCliChildProcess(
  input: ProjectTuttiCliChildProcessInput,
): TuttiCliChildProcessProjection {
  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  const redactionSecrets = [...(input.detectContext?.redactionSecrets ?? [])];

  return Object.freeze({
    env: Object.freeze(env),
    redactionSecrets: Object.freeze(redactionSecrets),
  });
}

export function redactTuttiCliChildProcessText(
  text: string,
  redactionSecrets: readonly string[],
): string {
  return redactSecrets(
    text,
    [...redactionSecrets].sort((left, right) => right.length - left.length),
  );
}
