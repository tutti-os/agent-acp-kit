import path from "node:path";

import { normalizeMcpServerConfigs, type LocalAgentMcpServerConfig } from "../../core/mcp.js";
import type { AcpSessionNewParams } from "./acp-types.js";

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
            env: server.env.map((entry) => ({
              name: entry.key,
              value: entry.value,
            })),
          };
        }
        return {
          type: "stdio" as const,
          name: server.name,
          command: server.command,
          args: server.args ?? [],
          env: server.env.map((entry) => ({
            name: entry.key,
            value: entry.value,
          })),
        };
      },
    ),
    ...(options?.resume ? { resume: options.resume } : {}),
  };
}
