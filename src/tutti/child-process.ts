import type { DetectContext } from "../core/detection.js";
import { MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV } from "../core/managed-invocation.js";
import { redactSecrets } from "../core/redaction.js";

const REVERSE_CAPABILITY_INVOCATION_CREDENTIAL_ENV =
  "TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL";

export interface ProjectTuttiCliChildProcessInput {
  baseEnv?: Readonly<NodeJS.ProcessEnv>;
  detectContext?: DetectContext;
}

export interface TuttiCliChildProcessProjection {
  env: Readonly<NodeJS.ProcessEnv>;
  redactionSecrets: readonly string[];
}

/**
 * Projects request-scoped managed invocation authority at the immediate Tutti
 * child boundary. Intermediate Tutti facades should forward DetectContext
 * unchanged and must not extract or persist its credential.
 */
export function projectTuttiCliChildProcess(
  input: ProjectTuttiCliChildProcessInput,
): TuttiCliChildProcessProjection {
  const env: NodeJS.ProcessEnv = { ...(input.baseEnv ?? process.env) };
  delete env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV];
  delete env[REVERSE_CAPABILITY_INVOCATION_CREDENTIAL_ENV];

  const credential = input.detectContext?.managedAgentInvocation?.credential;
  if (credential) {
    env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV] = credential;
  }

  const redactionSecrets = Array.from(
    new Set(
      [...(input.detectContext?.redactionSecrets ?? []), credential].filter(
        (secret): secret is string => Boolean(secret),
      ),
    ),
  );

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
