import type {
  NormalizedLocalAgentMcpHttpServerConfig,
  NormalizedLocalAgentMcpStdioServerConfig,
} from "../../core/mcp.js";

type AcpMcpEnvEntry = {
  name: string;
  value: string;
};

export type AcpSessionNewParams = {
  cwd: string;
  mcpServers: Array<
    | (Omit<NormalizedLocalAgentMcpStdioServerConfig, "env"> & {
        type: "stdio";
        env: AcpMcpEnvEntry[];
      })
    | (Omit<NormalizedLocalAgentMcpHttpServerConfig, "env"> & {
        type: "http";
        env: AcpMcpEnvEntry[];
      })
  >;
  resume?: {
    mode: "native" | "provider" | "fresh";
    providerSessionId?: string;
    resumeToken?: string;
  };
};

export type JsonRpcEnvelope = {
  id?: number | string;
  jsonrpc: "2.0";
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code?: number; message?: string };
};
