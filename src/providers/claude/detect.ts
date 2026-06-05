import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentModelOption } from "../../core/provider-plugin.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { CLAUDE_FALLBACK_MODELS } from "./fallback-models.js";

const execFileAsync = promisify(execFile);

const CLAUDE_CONFIG_MODEL_ENV_KEYS = [
  "ANTHROPIC_MODEL",
  "ANTHROPIC_DEFAULT_SONNET_MODEL",
  "ANTHROPIC_DEFAULT_OPUS_MODEL",
  "ANTHROPIC_DEFAULT_HAIKU_MODEL",
] as const;

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeConfiguredModel(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function resolveClaudeConfigDir(env?: NodeJS.ProcessEnv) {
  const configured = env?.CLAUDE_CONFIG_DIR?.trim();
  return configured || path.join(homedir(), ".claude");
}

async function readClaudeConfiguredModels(configDir: string) {
  try {
    const payload = JSON.parse(
      await readFile(path.join(configDir, "settings.json"), "utf8"),
    ) as unknown;
    const settings = toRecord(payload);
    const models = [
      normalizeConfiguredModel(settings?.model),
      ...CLAUDE_CONFIG_MODEL_ENV_KEYS.map((key) =>
        normalizeConfiguredModel(toRecord(settings?.env)?.[key]),
      ),
    ];
    return models.filter((model): model is string => Boolean(model));
  } catch {
    return [];
  }
}

function withConfiguredClaudeModels(configuredModels: string[]) {
  const existingModels = CLAUDE_FALLBACK_MODELS;
  const seen = new Set(existingModels.map((model) => model.id));
  const appendedModels: AgentModelOption[] = [];

  for (const modelId of configuredModels) {
    if (seen.has(modelId)) continue;
    seen.add(modelId);
    appendedModels.push({ id: modelId, label: modelId });
  }

  if (appendedModels.length === 0) return existingModels;

  const defaultIndex = existingModels.findIndex(
    (model) => model.id === "default",
  );
  return defaultIndex >= 0
    ? [
        ...existingModels.slice(0, defaultIndex + 1),
        ...appendedModels,
        ...existingModels.slice(defaultIndex + 1),
      ]
    : [...appendedModels, ...existingModels];
}

export async function detectClaude(options?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  overridePath?: string;
}) {
  const command = options?.command ?? "claude";
  const configDir = resolveClaudeConfigDir(options?.env);
  const models = withConfiguredClaudeModels(
    await readClaudeConfiguredModels(configDir),
  );
  let executablePath: string;
  try {
    executablePath = await resolveCommandExecutable({
      command,
      ...(options?.env ? { env: options.env } : {}),
      fallbackCommands: ["openclaude"],
      ...(options?.overridePath ? { overridePath: options.overridePath } : {}),
    });
  } catch (error) {
    return {
      authState: "missing" as const,
      configDir,
      executablePath: command,
      models,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? error.message
          : "Executable not found on PATH: claude, openclaude",
      version: "not-installed",
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executablePath, ["--version"], {
      env: options?.env,
    }));
  } catch (error) {
    return {
      authState: "unknown" as const,
      configDir,
      executablePath,
      models,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? `Unable to run ${command} --version: ${error.message}`
          : `Unable to run ${command} --version`,
      version: "unknown",
    };
  }

  return {
    authState: "unknown" as const,
    configDir,
    executablePath,
    models,
    skillsDir: path.join(configDir, "skills"),
    supported: true,
    version: stdout.trim() || "unknown",
  };
}
