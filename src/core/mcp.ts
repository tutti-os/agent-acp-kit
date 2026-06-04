export type LocalAgentMcpEnvEntry = {
  key: string;
  value: string;
};

export type LocalAgentMcpStdioServerConfig = {
  type?: "stdio";
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string> | LocalAgentMcpEnvEntry[];
};

export type LocalAgentMcpHttpServerConfig = {
  type: "http";
  name: string;
  url: string;
  headers?: Record<string, string>;
  env?: Record<string, string> | LocalAgentMcpEnvEntry[];
};

export type LocalAgentMcpServerConfig =
  | LocalAgentMcpStdioServerConfig
  | LocalAgentMcpHttpServerConfig;

export type NormalizedLocalAgentMcpStdioServerConfig = Omit<
  LocalAgentMcpStdioServerConfig,
  "env" | "type"
> & {
  env: LocalAgentMcpEnvEntry[];
  type: "stdio";
};

export type NormalizedLocalAgentMcpHttpServerConfig = Omit<
  LocalAgentMcpHttpServerConfig,
  "env"
> & {
  env: LocalAgentMcpEnvEntry[];
};

export type NormalizedLocalAgentMcpServerConfig =
  | NormalizedLocalAgentMcpStdioServerConfig
  | NormalizedLocalAgentMcpHttpServerConfig;

export function normalizeMcpEnvEntries(
  env?: Record<string, string> | LocalAgentMcpEnvEntry[],
): LocalAgentMcpEnvEntry[] {
  if (!env) {
    return [];
  }
  if (Array.isArray(env)) {
    return env
      .filter(
        (entry): entry is LocalAgentMcpEnvEntry =>
          typeof entry?.key === "string" &&
          entry.key.length > 0 &&
          typeof entry?.value === "string",
      )
      .map((entry) => ({ key: entry.key, value: entry.value }));
  }
  return Object.entries(env)
    .filter(([, value]) => typeof value === "string")
    .map(([key, value]) => ({ key, value }));
}

export function normalizeMcpServerConfig(
  server: LocalAgentMcpServerConfig,
): NormalizedLocalAgentMcpServerConfig {
  if (server.type === "http") {
    return {
      type: "http",
      name: server.name,
      url: server.url,
      ...(server.headers ? { headers: { ...server.headers } } : {}),
      env: normalizeMcpEnvEntries(server.env),
    };
  }

  return {
    type: "stdio",
    name: server.name,
    command: server.command,
    ...(server.args ? { args: server.args.slice() } : {}),
    env: normalizeMcpEnvEntries(server.env),
  };
}

export function normalizeMcpServerConfigs(
  servers: LocalAgentMcpServerConfig[] = [],
): NormalizedLocalAgentMcpServerConfig[] {
  return servers.map((server) => normalizeMcpServerConfig(server));
}
