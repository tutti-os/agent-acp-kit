import path from "node:path";

import type { DetectContext } from "./detection.js";
import type { LaunchPlan } from "./launch-plan.js";
import {
  normalizeMcpServerConfigs,
  type LocalAgentMcpEnvEntry,
  type LocalAgentMcpServerConfig,
  type NormalizedLocalAgentMcpServerConfig,
  type NormalizedLocalAgentMcpStdioServerConfig,
} from "./mcp.js";
import { redactSecrets } from "./redaction.js";

export const MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV =
  "TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL";
export const MANAGED_AGENT_MCP_ATTACHMENT_ENV =
  "TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64";

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

export type ManagedAgentMcpStdioAttachment = {
  type: "stdio";
  executionSide: "sandbox";
  command: string;
  args: string[];
  env: Record<string, string>;
  timeouts?: {
    startupTimeoutMs?: number;
    toolTimeoutMs?: number;
  };
};

export type ManagedAgentMcpAttachmentV1 = {
  mcpServers: Record<string, ManagedAgentMcpStdioAttachment>;
};

export type ManagedAgentMcpAttachmentEnv = {
  encoded: string;
  env: Record<typeof MANAGED_AGENT_MCP_ATTACHMENT_ENV, string>;
  payload: string;
  redactionSecrets: string[];
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
  mcpAttachment?: ManagedAgentMcpAttachmentEnv,
) {
  return {
    ...(baseEnv ?? {}),
    [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: invocation.credential,
    ...(mcpAttachment?.env ?? {}),
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
  ...secrets: Array<string | undefined>
) {
  return Array.from(
    new Set(
      [...(redactionSecrets ?? []), ...secrets].filter(
        (secret): secret is string => Boolean(secret),
      ),
    ),
  );
}

function collectMcpRedactionSecrets(
  servers: NormalizedLocalAgentMcpServerConfig[],
) {
  const secrets: string[] = [];
  for (const server of servers) {
    for (const entry of server.env) {
      secrets.push(entry.value);
    }
    if (server.type === "http" && server.headers) {
      secrets.push(...Object.values(server.headers));
    }
  }
  return secrets.filter((secret) => secret.length > 0);
}

const KNOWN_MANAGED_AGENT_MCP_ABSOLUTE_NODE_PATHS = new Set([
  "/opt/homebrew/bin/node",
  "/usr/bin/node",
  "/usr/local/bin/node",
]);

function isKnownAbsoluteNodeCommand(command: string) {
  const trimmed = command.trim();
  if (trimmed === process.execPath) {
    return true;
  }
  return KNOWN_MANAGED_AGENT_MCP_ABSOLUTE_NODE_PATHS.has(
    path.posix.normalize(trimmed),
  );
}

function isAbsoluteCommand(command: string) {
  return path.isAbsolute(command) || path.win32.isAbsolute(command);
}

function normalizeManagedMcpStdioCommand(serverName: string, command: string) {
  const trimmed = command.trim();
  if (!trimmed) {
    throw new Error(
      `Managed MCP handoff v1 requires stdio MCP server "${serverName}" command to be set.`,
    );
  }
  if (isKnownAbsoluteNodeCommand(trimmed)) {
    return "node";
  }
  if (isAbsoluteCommand(trimmed)) {
    throw new Error(
      `Managed MCP handoff v1 requires stdio MCP server "${serverName}" command to be a bare command name or a known absolute node path.`,
    );
  }
  return trimmed;
}

function envEntriesToObject(entries: LocalAgentMcpEnvEntry[]) {
  return Object.fromEntries(entries.map((entry) => [entry.key, entry.value]));
}

function buildManagedMcpStdioAttachment(
  server: NormalizedLocalAgentMcpStdioServerConfig,
): ManagedAgentMcpStdioAttachment {
  if (server.executionSide !== "sandbox") {
    throw new Error(
      `Managed MCP handoff v1 requires stdio MCP server "${server.name}" to set executionSide: "sandbox".`,
    );
  }

  const timeouts = {
    ...(server.startupTimeoutMs
      ? { startupTimeoutMs: server.startupTimeoutMs }
      : {}),
    ...(server.toolTimeoutMs ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
  };

  return {
    type: "stdio",
    executionSide: "sandbox",
    command: normalizeManagedMcpStdioCommand(server.name, server.command),
    args: server.args ?? [],
    env: envEntriesToObject(server.env),
    ...(Object.keys(timeouts).length > 0 ? { timeouts } : {}),
  };
}

export function buildManagedAgentMcpAttachmentEnv(
  mcpServers?: LocalAgentMcpServerConfig[],
): ManagedAgentMcpAttachmentEnv | undefined {
  const normalizedServers = normalizeMcpServerConfigs(mcpServers ?? []);
  if (normalizedServers.length === 0) {
    return undefined;
  }

  const attachment: ManagedAgentMcpAttachmentV1 = {
    mcpServers: Object.fromEntries(
      normalizedServers.map((server) => {
        if (server.type !== "stdio") {
          throw new Error(
            `Managed MCP handoff v1 supports only sandbox-side stdio MCP servers; "${server.name}" is ${server.type}.`,
          );
        }
        return [server.name, buildManagedMcpStdioAttachment(server)];
      }),
    ),
  };
  const payload = JSON.stringify(attachment);
  const encoded = Buffer.from(payload, "utf8").toString("base64");
  return {
    encoded,
    env: {
      [MANAGED_AGENT_MCP_ATTACHMENT_ENV]: encoded,
    },
    payload,
    redactionSecrets: mergeRedactionSecrets(
      collectMcpRedactionSecrets(normalizedServers),
      payload,
      encoded,
    ),
  };
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
  const mcpAttachment = buildManagedAgentMcpAttachmentEnv(plan.mcpServers);
  const planWithoutManagedMcpServers = mcpAttachment
    ? (() => {
        const { mcpServers: _managedMcpServers, ...rest } = plan;
        return rest;
      })()
    : plan;
  return {
    ...planWithoutManagedMcpServers,
    cwd: normalized.cwd,
    env: mergeEnv(plan.env, normalized, mcpAttachment),
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
      ...(mcpAttachment?.redactionSecrets ?? []),
    ),
  };
}

export function redactManagedAgentInvocationSecrets(
  input: string,
  env?: Record<string, string | undefined>,
) {
  return redactSecrets(
    input,
    [
      env?.[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV],
      env?.[MANAGED_AGENT_MCP_ATTACHMENT_ENV],
    ].filter(
      (secret): secret is string => Boolean(secret),
    ),
  );
}
