import { execFile, spawn } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import readline from "node:readline";
import { promisify } from "node:util";

import type { AgentModelOption } from "../../core/provider-plugin.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";

const execFileAsync = promisify(execFile);
const CODEX_MODEL_DISCOVERY_TIMEOUT_MS = 5_000;
const CODEX_MODEL_DISCOVERY_MAX_BUFFER = 8 * 1024 * 1024;
const CODEX_DEFAULT_MODELS: AgentModelOption[] = [
  { id: "default", label: "Default (CLI config)" },
];

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

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getString(record: Record<string, unknown>, key: string) {
  const value = record[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isLegacyConcreteDefaultModel(record: Record<string, unknown>) {
  return record.isDefault === true && Boolean(getString(record, "upgrade"));
}

function normalizeCodexCatalog(payload: unknown): AgentModelOption[] {
  const payloadRecord = toRecord(payload);
  const rawModels = Array.isArray(payloadRecord?.data)
    ? payloadRecord.data
    : Array.isArray(payloadRecord?.models)
      ? payloadRecord.models
      : [];
  const seen = new Set<string>();
  const models: AgentModelOption[] = [
    { id: "default", label: "Default (CLI config)" },
  ];
  seen.add("default");
  const upgradeModels: AgentModelOption[] = [];

  function appendModel(id: string, label: string, description?: string) {
    if (!id || seen.has(id)) return;
    seen.add(id);
    models.push({
      id,
      label: label || id,
      ...(description ? { description } : {}),
    });
  }

  for (const entry of rawModels) {
    const record = toRecord(entry);
    if (!record) continue;
    if (record.hidden === true || record.visibility === "hide") continue;
    if (isLegacyConcreteDefaultModel(record)) continue;

    const id = getString(record, "id") ?? getString(record, "model") ?? getString(record, "slug");
    if (!id) continue;
    const label = getString(record, "displayName") ?? getString(record, "display_name") ?? id;
    appendModel(id, label, getString(record, "description"));

    const upgrade = getString(record, "upgrade");
    const upgradeInfo = toRecord(record.upgradeInfo);
    const upgradeLabel =
      (upgradeInfo ? getString(upgradeInfo, "model") : undefined) ?? upgrade;
    if (upgrade && upgradeLabel) {
      upgradeModels.push({ id: upgrade, label: upgradeLabel });
    }
  }

  for (const upgradeModel of upgradeModels) {
    appendModel(upgradeModel.id, upgradeModel.label);
  }

  return models;
}

async function loadCodexAppServerModelCatalog(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined,
) {
  const child = spawn(executablePath, ["app-server"], {
    ...(env ? { env } : {}),
    stdio: ["pipe", "pipe", "pipe"],
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<
    number,
    {
      reject(error: Error): void;
      resolve(value: unknown): void;
      timer: NodeJS.Timeout;
    }
  >();
  let nextId = 1;

  function rejectPending(error: Error) {
    for (const [id, waiter] of pending) {
      pending.delete(id);
      clearTimeout(waiter.timer);
      waiter.reject(error);
    }
  }

  function request(method: string, params: unknown) {
    const id = nextId;
    nextId += 1;
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Codex app-server ${method} timed out.`));
      }, CODEX_MODEL_DISCOVERY_TIMEOUT_MS);
      pending.set(id, { reject, resolve, timer });
    });
  }

  rl.on("line", (line) => {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      return;
    }
    const id = typeof message.id === "number" ? message.id : undefined;
    if (id === undefined) return;
    const waiter = pending.get(id);
    if (!waiter) return;
    pending.delete(id);
    clearTimeout(waiter.timer);
    const error = toRecord(message.error);
    if (error) {
      waiter.reject(
        new Error(
          getString(error, "message") ?? `Codex app-server request ${id} failed.`,
        ),
      );
      return;
    }
    waiter.resolve(message.result);
  });
  child.on("error", (error) => {
    rejectPending(error);
  });
  child.on("close", (code, signal) => {
    rejectPending(
      new Error(
        `Codex app-server exited before model discovery completed: ${
          signal ? `signal ${signal}` : `code ${code ?? 1}`
        }.`,
      ),
    );
  });

  try {
    await request("initialize", {
      clientInfo: {
        name: "agent_acp_kit",
        title: "Agent ACP Kit",
        version: "0",
      },
      capabilities: { experimentalApi: true },
    });
    child.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);
    return normalizeCodexCatalog(
      await request("model/list", { includeHidden: false }),
    );
  } finally {
    for (const waiter of pending.values()) {
      clearTimeout(waiter.timer);
    }
    pending.clear();
    rl.close();
    if (!child.killed) {
      child.kill();
    }
  }
}

async function loadCodexDebugModelCatalog(
  executablePath: string,
  env: NodeJS.ProcessEnv | undefined,
) {
  const { stdout } = await execFileAsync(executablePath, ["debug", "models"], {
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
    return await loadCodexAppServerModelCatalog(
      options.executablePath,
      options.env,
    );
  } catch {
    try {
      return await loadCodexDebugModelCatalog(
        options.executablePath,
        options.env,
      );
    } catch {
      return CODEX_DEFAULT_MODELS;
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
      models: CODEX_DEFAULT_MODELS,
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
      models: CODEX_DEFAULT_MODELS,
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
