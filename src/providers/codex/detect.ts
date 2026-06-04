import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import type { AgentModelOption } from "../../core/provider-plugin.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { CODEX_FALLBACK_MODELS } from "./fallback-models.js";

const execFileAsync = promisify(execFile);
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const CODEX_MODEL_DISCOVERY_MAX_BUFFER = 8 * 1024 * 1024;

function parseSemver(version: string) {
  const match = version.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!match) {
    return null;
  }
  return match.slice(1).map((part) => Number.parseInt(part, 10));
}

function isVersionAtLeast(version: string, minimumVersion?: string) {
  if (!minimumVersion) {
    return true;
  }
  const current = parseSemver(version);
  const minimum = parseSemver(minimumVersion);
  if (!current || !minimum) {
    return true;
  }
  for (let index = 0; index < minimum.length; index += 1) {
    const currentPart = current[index] ?? 0;
    const minimumPart = minimum[index] ?? 0;
    if (currentPart > minimumPart) return true;
    if (currentPart < minimumPart) return false;
  }
  return true;
}

function normalizeCodexCatalog(payload: unknown): AgentModelOption[] {
  const rawModels = Array.isArray(
    (payload as { models?: unknown[] } | null)?.models,
  )
    ? (payload as { models: unknown[] }).models
    : [];
  const seen = new Set<string>();
  const models: AgentModelOption[] = [
    { id: "default", label: "Default (CLI config)" },
  ];
  seen.add("default");

  for (const entry of rawModels) {
    if (!entry || typeof entry !== "object") continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.slug === "string" ? record.slug.trim() : "";
    if (!id || seen.has(id)) continue;
    if (record.visibility === "hide") continue;
    seen.add(id);
    models.push({
      id,
      label:
        typeof record.display_name === "string" && record.display_name.trim()
          ? record.display_name.trim()
          : id,
    });
  }

  return models.length > 1 ? models : CODEX_FALLBACK_MODELS;
}

async function loadCodexModelCatalog(
  executablePath: string,
  args: string[],
  env: NodeJS.ProcessEnv | undefined,
) {
  const { stdout } = await execFileAsync(executablePath, args, {
    ...(env ? { env } : {}),
    maxBuffer: CODEX_MODEL_DISCOVERY_MAX_BUFFER,
    timeout: CODEX_MODEL_DISCOVERY_TIMEOUT_MS,
  });
  return normalizeCodexCatalog(JSON.parse(stdout) as unknown);
}

export async function discoverCodexModels(options: {
  env?: NodeJS.ProcessEnv;
  executablePath: string;
}) {
  try {
    return await loadCodexModelCatalog(
      options.executablePath,
      ["debug", "models"],
      options.env,
    );
  } catch {
    try {
      return await loadCodexModelCatalog(
        options.executablePath,
        ["debug", "models", "--bundled"],
        options.env,
      );
    } catch {
      return CODEX_FALLBACK_MODELS;
    }
  }
}

export async function detectCodex(options?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  minimumVersion?: string;
  overridePath?: string;
}) {
  const command = options?.command ?? "codex";
  const configDir = (options?.env?.CODEX_HOME || process.env.CODEX_HOME || "").trim()
    || path.join(homedir(), ".codex");
  let executablePath: string;
  try {
    executablePath = await resolveCommandExecutable({
      command,
      ...(options?.env ? { env: options.env } : {}),
      ...(options?.overridePath ? { overridePath: options.overridePath } : {}),
    });
  } catch (error) {
    return {
      authState: "missing" as const,
      configDir,
      executablePath: command,
      models: CODEX_FALLBACK_MODELS,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error ? error.message : `Executable not found: ${command}`,
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
      models: CODEX_FALLBACK_MODELS,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? `Unable to run ${command} --version: ${error.message}`
          : `Unable to run ${command} --version`,
      version: "unknown",
    };
  }
  const version = stdout.trim() || "unknown";
  const supported = isVersionAtLeast(version, options?.minimumVersion);
  const models = await discoverCodexModels({
    ...(options?.env ? { env: options.env } : {}),
    executablePath,
  });
  return {
    authState: "unknown" as const,
    configDir,
    executablePath,
    models,
    skillsDir: path.join(configDir, "skills"),
    supported,
    ...(options?.minimumVersion
      ? { minimumVersion: options.minimumVersion }
      : {}),
    ...(supported
      ? {}
      : {
          unsupportedReason: `Codex ${version} is older than the required ${options?.minimumVersion}`,
        }),
    version,
  };
}
