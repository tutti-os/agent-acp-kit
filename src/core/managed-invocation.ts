import path from "node:path";

import type { DetectContext } from "./detection.js";
import type { LaunchPlan } from "./launch-plan.js";
import { redactSecrets } from "./redaction.js";

export const MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV =
  "TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL";

export const MANAGED_AGENT_INVOCATION_PROVIDER_IDS = [
  "codex",
  "claude",
  "nexight",
] as const;

export type ManagedAgentInvocationProviderId =
  (typeof MANAGED_AGENT_INVOCATION_PROVIDER_IDS)[number];

export type ManagedAgentInvocation = {
  credential: string;
  cwd: string;
};

export function isManagedAgentInvocationProviderId(
  providerId: string,
): providerId is ManagedAgentInvocationProviderId {
  return MANAGED_AGENT_INVOCATION_PROVIDER_IDS.includes(
    providerId as ManagedAgentInvocationProviderId,
  );
}

export function isManagedAgentInvocationCwd(cwd: string) {
  const normalized = path.posix.normalize(cwd);
  return normalized === "/workspace" || normalized.startsWith("/workspace/");
}

function normalizeManagedAgentInvocation(
  invocation: ManagedAgentInvocation,
): ManagedAgentInvocation {
  if (!invocation.credential || !invocation.credential.trim()) {
    throw new Error("Managed agent invocation credential is required.");
  }

  const cwd = path.posix.normalize(invocation.cwd);
  if (!isManagedAgentInvocationCwd(cwd)) {
    throw new Error(
      "Managed agent invocation cwd must be /workspace or a path under /workspace.",
    );
  }

  return {
    credential: invocation.credential,
    cwd,
  };
}

export function assertManagedAgentInvocationProviderId(providerId: string) {
  if (isManagedAgentInvocationProviderId(providerId)) {
    return;
  }

  throw new Error(
    `Managed agent invocation supports only ${MANAGED_AGENT_INVOCATION_PROVIDER_IDS.join(
      ", ",
    )} providers.`,
  );
}

function mergeEnv<TValue extends string | undefined>(
  baseEnv: Record<string, TValue> | undefined,
  invocation: ManagedAgentInvocation,
) {
  return {
    ...(baseEnv ?? {}),
    [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: invocation.credential,
  };
}

function mergeDetectEnv(
  baseEnv: Record<string, string | undefined> | undefined,
  invocation: ManagedAgentInvocation,
) {
  return mergeEnv(
    {
      ...process.env,
      ...(baseEnv ?? {}),
    },
    invocation,
  );
}

function mergeRedactionSecrets(
  redactionSecrets: string[] | undefined,
  credential: string,
) {
  return Array.from(new Set([...(redactionSecrets ?? []), credential]));
}

export function hasManagedAgentInvocation(
  input: { managedAgentInvocation?: ManagedAgentInvocation } | undefined,
) {
  return Boolean(input?.managedAgentInvocation);
}

export function prepareManagedAgentInvocationDetectContext(
  providerId: string,
  context?: DetectContext,
): DetectContext | undefined {
  const invocation = context?.managedAgentInvocation;
  if (!invocation) {
    return context;
  }

  const normalized = normalizeManagedAgentInvocation(invocation);

  if (!isManagedAgentInvocationProviderId(providerId)) {
    const {
      managedAgentInvocation: _managedAgentInvocation,
      env,
      ...rest
    } = context;
    const sanitizedEnv = env ? { ...env } : undefined;
    if (sanitizedEnv) {
      delete sanitizedEnv[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV];
    }
    if (sanitizedEnv && Object.keys(sanitizedEnv).length > 0) {
      return {
        ...rest,
        env: sanitizedEnv,
      };
    }
    return Object.keys(rest).length > 0 ? rest : undefined;
  }

  return {
    ...context,
    cwd: normalized.cwd,
    env: mergeDetectEnv(context.env, normalized),
    managedAgentInvocation: normalized,
    redactionSecrets: mergeRedactionSecrets(
      context.redactionSecrets,
      normalized.credential,
    ),
  };
}

export function applyManagedAgentInvocationToRunParams<
  TParams extends {
    cwd: string;
    env?: Record<string, string>;
    managedAgentInvocation?: ManagedAgentInvocation;
  },
>(providerId: string, params: TParams): TParams {
  if (!params.managedAgentInvocation) {
    return params;
  }

  assertManagedAgentInvocationProviderId(providerId);
  const normalized = normalizeManagedAgentInvocation(params.managedAgentInvocation);
  return {
    ...params,
    cwd: normalized.cwd,
    env: mergeEnv(params.env, normalized),
    managedAgentInvocation: normalized,
  };
}

export function applyManagedAgentInvocationToLaunchPlan(
  providerId: string,
  plan: LaunchPlan,
  invocation?: ManagedAgentInvocation,
): LaunchPlan {
  if (!invocation) {
    return plan;
  }

  assertManagedAgentInvocationProviderId(providerId);
  const normalized = normalizeManagedAgentInvocation(invocation);
  return {
    ...plan,
    cwd: normalized.cwd,
    env: mergeEnv(plan.env, normalized),
    fallbackPlan: plan.fallbackPlan
      ? applyManagedAgentInvocationToLaunchPlan(
          providerId,
          plan.fallbackPlan,
          normalized,
        )
      : undefined,
    redactionSecrets: mergeRedactionSecrets(
      plan.redactionSecrets,
      normalized.credential,
    ),
  };
}

export function redactManagedAgentInvocationSecrets(
  input: string,
  env?: Record<string, string | undefined>,
) {
  return redactSecrets(
    input,
    [env?.[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]].filter(
      (secret): secret is string => Boolean(secret),
    ),
  );
}
