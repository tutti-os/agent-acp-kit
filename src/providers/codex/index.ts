import { copyFile, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";

import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { AgentEvent } from "../../core/events.js";
import type { RawAgentStream } from "../../core/transport.js";
import { normalizeMcpServerConfigs } from "../../core/mcp.js";
import { materializeSkills } from "../../skills/materialize.js";
import { cleanupPaths } from "../../skills/cleanup.js";
import { runJsonlTransport } from "../../transports/jsonl/jsonl-transport.js";
import { detectCodex } from "./detect.js";
import { buildCodexLaunchPlan } from "./launch-plan.js";
import { parseCodexItem } from "./parser.js";

function escapeTomlString(value: string) {
  return value.replaceAll("\\", "\\\\").replaceAll('"', '\\"');
}

function normalizeCodexModel(model: string | undefined) {
  if (model === "codex:gpt-5") return "gpt-5.4";
  if (model === "codex:gpt-5-mini") return "gpt-5.4-mini";
  if (model?.startsWith("codex:")) return model.slice("codex:".length);
  return model;
}

async function* parseCodexRawEvents(stream: RawAgentStream): AsyncGenerator<AgentEvent> {
  let sessionId: string | undefined;
  for await (const item of stream) {
    const record =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : undefined;
    if (record?.type === "thread.started") {
      const thread =
        record.thread && typeof record.thread === "object" && !Array.isArray(record.thread)
          ? (record.thread as Record<string, unknown>)
          : undefined;
      const candidate =
        record.threadId ??
        record.thread_id ??
        record.sessionId ??
        record.session_id ??
        thread?.id;
      if (typeof candidate === "string" && candidate.trim()) {
        sessionId = candidate;
      }
    }
    if (item && typeof item === "object" && "type" in item) {
      const candidate = item as AgentEvent;
      if (candidate.type === "done" && sessionId && !candidate.sessionId) {
        yield { ...candidate, sessionId };
        continue;
      }
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
    yield* parseCodexItem(item as Parameters<typeof parseCodexItem>[0]);
  }
}

function buildCodexPrompt(input: {
  prompt: string;
  history?: Array<{ role: "user" | "assistant" | "system"; content: string }>;
  skills: Array<{ slug: string; deliveryMode: string; materializedPath?: string; content?: string }>;
  systemPrompt?: string;
}) {
  const materializedSkills = input.skills.filter(
    (skill) => skill.deliveryMode === "materialized-files" && skill.materializedPath,
  );
  const injectedSkills = input.skills.filter(
    (skill) =>
      skill.deliveryMode === "prompt-injection" ||
      skill.deliveryMode === "project-instructions",
  );
  const historyTranscript = (input.history ?? [])
    .filter((message) => message.role === "user" || message.role === "assistant")
    .map((message) => `${message.role === "user" ? "User" : "Assistant"}:\n${message.content}`)
    .join("\n\n");

  const materializedSkillSection =
    materializedSkills.length > 0
      ? `Workspace skills are materialized under the current run directory. Read the referenced SKILL.md before following a skill.\n${materializedSkills
          .map((skill) => `- ${skill.slug}: ${skill.materializedPath}/SKILL.md`)
          .join("\n")}`
      : "";
  const injectedSkillSection =
    injectedSkills.length > 0
      ? `Injected skills:\n${injectedSkills
          .map((skill) => {
            const base = `- ${skill.slug}`;
            if (skill.content?.trim()) {
              return `${base}\n${skill.content.trim()}`;
            }
            return base;
          })
          .join("\n")}`
      : "";
  const historySection = historyTranscript
    ? `Conversation history:\n${historyTranscript}`
    : "";

  return [
    input.systemPrompt?.trim(),
    "You are a local Codex runtime.",
    "Prefer available MCP tools instead of faking external side effects.",
    "Do not claim a tool action happened unless the tool actually succeeded.",
    materializedSkillSection,
    injectedSkillSection,
    historySection,
    "Current request:",
    input.prompt,
  ]
    .filter(Boolean)
    .join("\n\n");
}

async function ensureParentDirectory(path: string) {
  await mkdir(dirname(path), { recursive: true });
}

async function copyOptionalFile(source: string, target: string) {
  try {
    await ensureParentDirectory(target);
    await copyFile(source, target);
    return true;
  } catch {
    return false;
  }
}

function buildMcpConfigBlock(servers: ReturnType<typeof normalizeMcpServerConfigs>) {
  const lines: string[] = [];

  for (const server of servers) {
    lines.push("", `[mcp_servers.${server.name}]`);
    if (server.type === "http") {
      lines.push('type = "http"');
      lines.push(`url = "${escapeTomlString(server.url)}"`);
      if (server.headers && Object.keys(server.headers).length > 0) {
        lines.push("", `[mcp_servers.${server.name}.headers]`);
        for (const [key, value] of Object.entries(server.headers)) {
          lines.push(`${key} = "${escapeTomlString(value)}"`);
        }
      }
    } else {
      lines.push('type = "stdio"');
      lines.push(`command = "${escapeTomlString(server.command)}"`);
      if (server.args && server.args.length > 0) {
        lines.push(
          `args = [${server.args.map((arg) => `"${escapeTomlString(arg)}"`).join(", ")}]`,
        );
      }
    }

    if (server.env.length > 0) {
      lines.push("", `[mcp_servers.${server.name}.env]`);
      for (const entry of server.env) {
        lines.push(`${entry.key} = "${escapeTomlString(entry.value)}"`);
      }
    }
  }

  return lines.join("\n");
}

function collectMcpRedactionSecrets(
  servers: ReturnType<typeof normalizeMcpServerConfigs>,
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

function extractCodexModelProviderLine(config: string) {
  const match = config.match(
    /^model_provider\s*=\s*("[^"\r\n]*"|'[^'\r\n]*'|[^\r\n#]+)/m,
  );
  return match?.[0]?.trim();
}

function extractCodexModelProviderTables(config: string) {
  const blocks: string[] = [];
  let currentBlock: string[] | null = null;

  for (const line of config.split(/\r?\n/)) {
    if (line.startsWith("[")) {
      if (currentBlock) {
        blocks.push(currentBlock.join("\n").trim());
      }
      currentBlock = line.startsWith("[model_providers.") ? [line] : null;
      continue;
    }

    if (currentBlock) {
      currentBlock.push(line);
    }
  }

  if (currentBlock) {
    blocks.push(currentBlock.join("\n").trim());
  }

  return blocks.filter(Boolean);
}

function splitTomlRoot(config: string) {
  const firstTableIndex = config.search(/^\[/m);
  if (firstTableIndex < 0) {
    return { root: config.trim(), tables: "" };
  }

  return {
    root: config.slice(0, firstTableIndex).trim(),
    tables: config.slice(firstTableIndex).trim(),
  };
}

function mergeCodexConfigToml(sourceConfig: string, generatedConfig: string) {
  const modelProviderLine = extractCodexModelProviderLine(sourceConfig);
  const providerTables = extractCodexModelProviderTables(sourceConfig);
  if (!modelProviderLine && providerTables.length === 0) {
    return generatedConfig;
  }

  const generated = splitTomlRoot(generatedConfig);
  const sections = [
    modelProviderLine,
    generated.root,
    providerTables.join("\n\n"),
    generated.tables,
  ].filter((section) => section?.trim());

  return `${sections.join("\n\n")}\n`;
}

async function readOptionalFile(path: string) {
  try {
    return await readFile(path, "utf8");
  } catch {
    return undefined;
  }
}

async function materializeCodexHome(params: {
  mcpServers?: Parameters<typeof normalizeMcpServerConfigs>[0];
  env?: Record<string, string>;
  model?: string;
}) {
  const normalizedServers = normalizeMcpServerConfigs(params.mcpServers ?? []);
  if (normalizedServers.length === 0) {
    return null;
  }

  const sourceHome =
    params.env?.CODEX_HOME ??
    process.env.CODEX_HOME ??
    join(homedir(), ".codex");
  const runHome = await mkdtemp(join(tmpdir(), "agent-acp-kit-codex-home-"));

  const authCopied = await copyOptionalFile(
    join(sourceHome, "auth.json"),
    join(runHome, "auth.json"),
  );
  if (!authCopied) {
    throw new Error(
      `Codex auth is unavailable for local-agent runs. Expected auth.json under ${sourceHome}.`,
    );
  }

  const configLines: string[] = [];
  if (params.model && params.model !== "default") {
    configLines.push(`model = "${escapeTomlString(params.model)}"`);
  }

  const mcpConfigBlock = buildMcpConfigBlock(normalizedServers);
  if (mcpConfigBlock) {
    configLines.push(mcpConfigBlock);
  }

  const generatedConfig = `${configLines.filter(Boolean).join("\n\n")}\n`;
  const sourceConfig = await readOptionalFile(join(sourceHome, "config.toml"));
  await writeFile(
    join(runHome, "config.toml"),
    sourceConfig
      ? mergeCodexConfigToml(sourceConfig, generatedConfig)
      : generatedConfig,
    "utf8",
  );

  return runHome;
}

export function createCodexProvider(): LocalAgentProviderPlugin<
  "local-agent",
  "codex"
> {
  const cleanupByRunId = new Map<string, string[]>();

  async function prepareLaunchPlan(
    params: Parameters<LocalAgentProviderPlugin<"local-agent", "codex">["buildLaunchPlan"]>[0],
  ) {
    const materialized = await materializeSkills(
      params.cwd,
      params.skillManifest ?? [],
    );
    const prompt = buildCodexPrompt({
      prompt: params.prompt,
      ...(params.history ? { history: params.history } : {}),
      skills: materialized,
      ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
    });
    const normalizedModel = normalizeCodexModel(params.model);
    const redactionSecrets = collectMcpRedactionSecrets(
      normalizeMcpServerConfigs(params.mcpServers ?? []),
    );
    const codexHome = await materializeCodexHome({
      ...(params.env ? { env: params.env } : {}),
      ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
      ...(normalizedModel ? { model: normalizedModel } : {}),
    });
    const cleanupTargets = [
      ...materialized
        .map((skill) => skill.materializedPath)
        .filter((path): path is string => Boolean(path)),
      ...(codexHome ? [codexHome] : []),
    ];
    if (cleanupTargets.length > 0) {
      cleanupByRunId.set(params.runId, cleanupTargets);
    }

    return {
      ...buildCodexLaunchPlan({
        ...params,
        ...(codexHome
          ? {
              env: {
                ...(params.env ?? {}),
                CODEX_HOME: codexHome,
              },
            }
          : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
        prompt,
      }),
      ...(redactionSecrets.length > 0 ? { redactionSecrets } : {}),
    };
  }

  async function cleanupRun(runId: string) {
    const cleanupTargets = cleanupByRunId.get(runId) ?? [];
    cleanupByRunId.delete(runId);
    await cleanupPaths(cleanupTargets);
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", "codex"> = {
    id: "codex",
    displayName: "Codex CLI",
    kind: "local-agent",
    async detect() {
      return detectCodex();
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: true,
        streaming: true,
        toolGateway: true,
        maxConcurrentRuns: 1,
      };
    },
    async buildLaunchPlan(params) {
      return {
        ...(await prepareLaunchPlan(params)),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
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
            ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
            runId: params.runId,
            transport: "jsonl",
          };
        },
        capabilities: () => plugin.capabilities(),
        parseEvents: async function* (stream) {
          try {
            for await (const event of parseCodexRawEvents(stream)) {
              yield event;
            }
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
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        runId: params.runId,
        transport: "jsonl" as const,
      };
      try {
        yield* runJsonlTransport(plan, parseCodexItem, params.signal);
      } finally {
        await cleanupRun(params.runId);
      }
    },
  };

  return plugin;
}

export const codexProvider = createCodexProvider();
