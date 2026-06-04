import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { AgentEvent } from "../../core/events.js";
import type { RawAgentStream } from "../../core/transport.js";
import {
  normalizeMcpServerConfigs,
  type NormalizedLocalAgentMcpServerConfig,
} from "../../core/mcp.js";
import { materializeSkills } from "../../skills/materialize.js";
import { cleanupPaths } from "../../skills/cleanup.js";
import { composePromptWithSkills } from "../../skills/prompt-injection.js";
import { runJsonlTransport } from "../../transports/jsonl/jsonl-transport.js";
import { detectClaude } from "./detect.js";
import { buildClaudeLaunchPlan } from "./launch-plan.js";
import { parseClaudeStreamEvent } from "./parser.js";

async function* parseClaudeRawEvents(stream: RawAgentStream): AsyncGenerator<AgentEvent> {
  for await (const item of stream) {
    if (item && typeof item === "object" && "type" in item) {
      const candidate = item as AgentEvent;
      if (
        candidate.type === "done" ||
        candidate.type === "error" ||
        candidate.type === "status" ||
        candidate.type === "text_delta" ||
        candidate.type === "thinking_delta" ||
        candidate.type === "tool_call" ||
        candidate.type === "tool_result"
      ) {
        yield candidate;
        continue;
      }
    }
    yield* parseClaudeStreamEvent(item as Record<string, unknown>);
  }
}

function envEntriesToObject(
  env: NormalizedLocalAgentMcpServerConfig["env"],
) {
  return Object.fromEntries(env.map((entry) => [entry.key, entry.value]));
}

function buildClaudeMcpConfig(
  servers: NormalizedLocalAgentMcpServerConfig[],
) {
  const mcpServers: Record<string, Record<string, unknown>> = {};
  for (const server of servers) {
    if (server.type === "http") {
      mcpServers[server.name] = {
        type: "http",
        url: server.url,
        ...(server.headers ? { headers: server.headers } : {}),
        ...(server.env.length > 0 ? { env: envEntriesToObject(server.env) } : {}),
      };
      continue;
    }

    mcpServers[server.name] = {
      type: "stdio",
      command: server.command,
      ...(server.args ? { args: server.args } : {}),
      ...(server.env.length > 0 ? { env: envEntriesToObject(server.env) } : {}),
    };
  }
  return { mcpServers };
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

async function materializeClaudeMcpConfig(params: {
  cwd: string;
  mcpServers?: Parameters<typeof normalizeMcpServerConfigs>[0];
  runId: string;
}) {
  const normalizedServers = normalizeMcpServerConfigs(params.mcpServers ?? []);
  if (normalizedServers.length === 0) {
    return {
      cleanupTargets: [] as string[],
      redactionSecrets: [] as string[],
    };
  }

  const configDir = join(params.cwd, ".local-agent", "claude");
  await mkdir(configDir, { recursive: true });
  const configPath = join(configDir, `${params.runId}-mcp.json`);
  await writeFile(
    configPath,
    JSON.stringify(buildClaudeMcpConfig(normalizedServers)),
    "utf8",
  );

  return {
    cleanupTargets: [configPath],
    mcpConfigPath: configPath,
    redactionSecrets: collectMcpRedactionSecrets(normalizedServers),
  };
}

export function createClaudeProvider(): LocalAgentProviderPlugin<
  "local-agent",
  "claude"
> {
  const cleanupByRunId = new Map<string, string[]>();

  async function prepareLaunchPlan(
    params: Parameters<LocalAgentProviderPlugin<"local-agent", "claude">["buildLaunchPlan"]>[0],
  ) {
    const materialized = await materializeSkills(
      params.cwd,
      params.skillManifest ?? [],
    );
    const prompt = composePromptWithSkills({
      prompt: params.prompt,
      ...(params.history ? { history: params.history } : {}),
      skills: materialized,
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    });
    const cleanupTargets = materialized
      .map((skill) => skill.materializedPath)
      .filter((path): path is string => Boolean(path));
    const mcpConfig = await materializeClaudeMcpConfig({
      cwd: params.cwd,
      ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      runId: params.runId,
    });
    const allCleanupTargets = [
      ...cleanupTargets,
      ...mcpConfig.cleanupTargets,
    ];
    if (allCleanupTargets.length > 0) {
      cleanupByRunId.set(params.runId, allCleanupTargets);
    }
    return {
      ...buildClaudeLaunchPlan(
        {
          ...params,
          prompt,
        },
        "claude",
        mcpConfig.mcpConfigPath
          ? { mcpConfigPath: mcpConfig.mcpConfigPath }
          : undefined,
      ),
      ...(mcpConfig.redactionSecrets.length > 0
        ? { redactionSecrets: mcpConfig.redactionSecrets }
        : {}),
    };
  }

  async function cleanupRun(runId: string) {
    const cleanupTargets = cleanupByRunId.get(runId) ?? [];
    cleanupByRunId.delete(runId);
    await cleanupPaths(cleanupTargets);
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", "claude"> = {
    id: "claude",
    displayName: "Claude Code",
    kind: "local-agent",
    async detect() {
      return detectClaude();
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: false,
        streaming: true,
        toolGateway: true,
        maxConcurrentRuns: 1,
      };
    },
    async buildLaunchPlan(params) {
      return {
        ...(await prepareLaunchPlan(params)),
        ...(params.model ? { model: params.model } : {}),
        runId: params.runId,
        transport: "jsonl",
      };
    },
    createAdapter() {
      let adapterRunId: string | undefined;
      return {
        buildLaunchPlan: async (params) => {
          adapterRunId = params.runId;
          return {
            ...(await prepareLaunchPlan(params)),
            ...(params.model ? { model: params.model } : {}),
            runId: params.runId,
            transport: "jsonl",
          };
        },
        capabilities: () => plugin.capabilities(),
        parseEvents: async function* (stream) {
          try {
            yield* parseClaudeRawEvents(stream);
          } finally {
            if (adapterRunId) {
              await cleanupRun(adapterRunId);
            }
          }
        },
      };
    },
    async *run(params) {
      const plan = {
        ...(await prepareLaunchPlan(params)),
        ...(params.model ? { model: params.model } : {}),
        runId: params.runId,
        transport: "jsonl" as const,
      };
      try {
        yield* runJsonlTransport(plan, parseClaudeStreamEvent, params.signal);
      } finally {
        await cleanupRun(params.runId);
      }
    },
  };

  return plugin;
}

export const claudeProvider = createClaudeProvider();
