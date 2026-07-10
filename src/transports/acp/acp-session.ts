import path from "node:path";

import { normalizeMcpServerConfigs, type LocalAgentMcpServerConfig } from "../../core/mcp.js";
import type { AcpSessionNewParams } from "./acp-types.js";

function acpEnvEntries(entries: Array<{ key: string; value: string }>) {
  return entries.map((entry) => ({ name: entry.key, value: entry.value }));
}

export function buildAcpSessionNewParams(
  cwd: string,
  options?: {
    mcpServers?: LocalAgentMcpServerConfig[];
    resume?: AcpSessionNewParams["resume"];
  },
): AcpSessionNewParams {
  return {
    cwd: path.resolve(cwd),
    mcpServers: normalizeMcpServerConfigs(options?.mcpServers ?? []).map(
      (server) => {
        if (server.type === "http") {
          return {
            type: "http" as const,
            name: server.name,
            url: server.url,
            ...(server.headers ? { headers: server.headers } : {}),
            env: acpEnvEntries(server.env),
          };
        }
        return {
          type: "stdio" as const,
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: acpEnvEntries(server.env),
        };
      },
    ),
    ...(options?.resume ? { resume: options.resume } : {}),
  };
}
