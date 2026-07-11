import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
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
export const MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER =
  "X-TSH-Managed-Agent-Credential";
export const MANAGED_AGENT_MCP_ATTACHMENT_ENV =
  "TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64";
export const DEFAULT_MANAGED_AGENT_RUNS_DIR_NAME = ".agent-runs";
export const TUTTI_APP_DATA_DIR_ENV = "TUTTI_APP_DATA_DIR";

export const MANAGED_AGENT_INVOCATION_PROVIDER_IDS = [
  "codex",
  "claude-code",
  "tutti-agent",
] as const;

export type ManagedAgentInvocationProviderId =
  (typeof MANAGED_AGENT_INVOCATION_PROVIDER_IDS)[number];

export type ManagedAgentInvocation = {
  credential: string;
  cwd: string;
};

export type ManagedAgentContextOptions = {
  appDataDir?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
};

export type ManagedAgentRunContextOptions = ManagedAgentContextOptions & {
  providerId: string;
  runId: string;
  runsDirName?: string;
};

export type ManagedAgentRunContext = {
  cwd: string;
  managedAgentInvocation: ManagedAgentInvocation;
};

export type ManagedAgentInvocationCredentialHeaderValue =
  | string
  | readonly string[]
  | null
  | undefined;

export type ManagedAgentInvocationCredentialHeaders =
  | Record<string, ManagedAgentInvocationCredentialHeaderValue>
  | Iterable<readonly [string, ManagedAgentInvocationCredentialHeaderValue]>
  | {
      get(
        name: string,
      ): ManagedAgentInvocationCredentialHeaderValue;
    };

export type ManagedAgentMcpStdioAttachment = {
  type: "stdio";
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
): boolean {
  const canonicalProviderId = canonicalManagedAgentInvocationProviderId(providerId);
  return MANAGED_AGENT_INVOCATION_PROVIDER_IDS.includes(
    canonicalProviderId as ManagedAgentInvocationProviderId,
  );
}

function canonicalManagedAgentInvocationProviderId(providerId: string) {
  const normalized = providerId.trim();
  return normalized === "claude" ? "claude-code" : normalized;
}

export function isManagedAgentInvocationCwd(cwd: string) {
  return normalizeManagedAgentInvocationCwd(cwd) !== undefined;
}

function normalizeManagedAgentInvocationCwd(cwd: string | undefined) {
  if (typeof cwd !== "string") {
    return undefined;
  }

  const trimmed = cwd.trim();
  if (
    !trimmed ||
    trimmed.includes("\0") ||
    !path.isAbsolute(trimmed)
  ) {
    return undefined;
  }

  return path.normalize(trimmed);
}

function normalizeCredentialValue(
  value: ManagedAgentInvocationCredentialHeaderValue,
): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const credential: string | undefined = normalizeCredentialValue(item);
      if (credential) {
        return credential;
      }
    }
    return undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function firstCredential(
  ...values: ManagedAgentInvocationCredentialHeaderValue[]
) {
  for (const value of values) {
    const credential = normalizeCredentialValue(value);
    if (credential) {
      return credential;
    }
  }
  return undefined;
}

function hasHeaderGetter(
  headers: ManagedAgentInvocationCredentialHeaders,
): headers is {
  get(name: string): ManagedAgentInvocationCredentialHeaderValue;
} {
  return typeof (headers as { get?: unknown }).get === "function";
}

function isIterableHeaders(
  headers: ManagedAgentInvocationCredentialHeaders,
): headers is Iterable<readonly [string, ManagedAgentInvocationCredentialHeaderValue]> {
  return typeof (headers as { [Symbol.iterator]?: unknown })[Symbol.iterator] ===
    "function";
}

export function getManagedAgentInvocationCredentialFromHeaders(
  headers: ManagedAgentInvocationCredentialHeaders | undefined,
) {
  if (!headers) {
    return undefined;
  }

  const targetHeader = MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER.toLowerCase();

  if (hasHeaderGetter(headers)) {
    const credential = firstCredential(
      headers.get(MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER),
      headers.get(targetHeader),
    );
    if (credential) {
      return credential;
    }
  }

  if (isIterableHeaders(headers)) {
    for (const [key, value] of headers) {
      if (key.toLowerCase() === targetHeader) {
        const credential = normalizeCredentialValue(value);
        if (credential) {
          return credential;
        }
      }
    }
    return undefined;
  }

  const headerRecord =
    headers as Record<string, ManagedAgentInvocationCredentialHeaderValue>;
  return firstCredential(
    headerRecord[MANAGED_AGENT_INVOCATION_CREDENTIAL_HEADER],
    ...Object.entries(headerRecord)
      .filter(([key]) => key.toLowerCase() === targetHeader)
      .map(([, value]) => value),
  );
}

function resolveManagedAgentBaseCwd(options?: ManagedAgentContextOptions) {
  return normalizeManagedAgentInvocationCwd(
    options?.cwd ??
      options?.appDataDir ??
      options?.env?.[TUTTI_APP_DATA_DIR_ENV] ??
      process.env[TUTTI_APP_DATA_DIR_ENV],
  );
}

function createManagedAgentInvocationFromHeaders(
  headers: ManagedAgentInvocationCredentialHeaders | undefined,
  options?: ManagedAgentContextOptions,
) {
  const credential = getManagedAgentInvocationCredentialFromHeaders(headers);
  if (!credential) {
    return undefined;
  }

  const cwd = resolveManagedAgentBaseCwd(options);
  if (!cwd) {
    throw new Error(
      `${TUTTI_APP_DATA_DIR_ENV} is required to create managed agent invocation context.`,
    );
  }

  return normalizeManagedAgentInvocation({
    credential,
    cwd,
  });
}

export function createManagedAgentDetectContextFromHeaders(
  headers: ManagedAgentInvocationCredentialHeaders | undefined,
  options?: ManagedAgentContextOptions,
): DetectContext | undefined {
  const managedAgentInvocation = createManagedAgentInvocationFromHeaders(
    headers,
    options,
  );
  if (!managedAgentInvocation) {
    return undefined;
  }

  return {
    cwd: managedAgentInvocation.cwd,
    env: {
      ...(options?.env ?? {}),
      [TUTTI_APP_DATA_DIR_ENV]: managedAgentInvocation.cwd,
    },
    managedAgentInvocation,
    redactionSecrets: [managedAgentInvocation.credential],
  };
}

function managedRunPathSegment(value: string, label: string) {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Managed agent ${label} is required.`);
  }

  const readable = trimmed
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^[-_.]+|[-_.]+$/g, "")
    .slice(0, 48);
  const hash = createHash("sha256")
    .update(trimmed)
    .digest("base64url")
    .slice(0, 16);
  return readable ? `${readable}-${hash}` : hash;
}

export async function createManagedAgentRunContextFromHeaders(
  headers: ManagedAgentInvocationCredentialHeaders | undefined,
  options: ManagedAgentRunContextOptions,
): Promise<ManagedAgentRunContext | undefined> {
  const credential = getManagedAgentInvocationCredentialFromHeaders(headers);
  if (!credential) {
    return undefined;
  }

  const canonicalProviderId = assertManagedAgentInvocationProviderId(options.providerId);
  const appDataDir = resolveManagedAgentBaseCwd(options);
  if (!appDataDir) {
    throw new Error(
      `${TUTTI_APP_DATA_DIR_ENV} is required to create managed agent run context.`,
    );
  }

  const cwd = path.join(
    appDataDir,
    options.runsDirName ?? DEFAULT_MANAGED_AGENT_RUNS_DIR_NAME,
    `${managedRunPathSegment(
      canonicalProviderId,
      "provider id",
    )}-${managedRunPathSegment(options.runId, "run id")}`,
  );
  await mkdir(cwd, { recursive: true });

  return {
    cwd,
    managedAgentInvocation: normalizeManagedAgentInvocation({
      credential,
      cwd,
    }),
  };
}

function normalizeManagedAgentInvocation(
  invocation: ManagedAgentInvocation,
): ManagedAgentInvocation {
  if (!invocation.credential || !invocation.credential.trim()) {
    throw new Error("Managed agent invocation credential is required.");
  }

  const cwd = normalizeManagedAgentInvocationCwd(invocation.cwd);
  if (!cwd) {
    throw new Error("Managed agent invocation cwd is required.");
  }

  return {
    credential: invocation.credential,
    cwd,
  };
}

export function assertManagedAgentInvocationProviderId(providerId: string) {
  const canonicalProviderId = canonicalManagedAgentInvocationProviderId(providerId);
  if (isManagedAgentInvocationProviderId(canonicalProviderId)) {
    return canonicalProviderId as ManagedAgentInvocationProviderId;
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
  const timeouts = {
    ...(server.startupTimeoutMs
      ? { startupTimeoutMs: server.startupTimeoutMs }
      : {}),
    ...(server.toolTimeoutMs ? { toolTimeoutMs: server.toolTimeoutMs } : {}),
  };

  return {
    type: "stdio",
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
            `Managed MCP handoff v1 supports only VM-local stdio MCP servers; "${server.name}" is ${server.type}.`,
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
      cwd: _managedCwd,
      managedAgentInvocation: _managedAgentInvocation,
      redactionSecrets: _managedRedactionSecrets,
      env,
      ...rest
    } = context;
    const sanitizedEnv = env ? { ...env } : undefined;
    if (sanitizedEnv) {
      delete sanitizedEnv[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV];
      delete sanitizedEnv[TUTTI_APP_DATA_DIR_ENV];
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

  const canonicalProviderId = assertManagedAgentInvocationProviderId(providerId);
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
          canonicalProviderId,
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
