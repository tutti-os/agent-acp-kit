import { execFile } from "node:child_process";

import type {
  SkillMaterializationFile,
  SkillMaterializationRecord,
} from "../core/skills.js";

export {
  createTuttiAgentAppRuntime,
  TuttiAgentAppRuntimeError,
} from "./app-runtime.js";
export type {
  CreateTuttiAgentAppRuntimeOptions,
  PrepareTuttiAgentRunInput,
  PreparedTuttiAgentRun,
  TuttiAgentAppRunInput,
  TuttiAgentAppRuntime,
  TuttiAgentAppRuntimeErrorCode,
  TuttiAgentAppRuntimeMode,
  TuttiAgentProviderAuthState,
  TuttiAgentProviderCatalog,
  TuttiAgentProviderCatalogEntry,
  TuttiAgentProviderCatalogInput,
  TuttiAgentProviderCatalogModel,
  TuttiAgentRunExecutionInput,
} from "./app-runtime.js";
export type {
  TuttiAgentComposerConfig,
  TuttiAgentComposerOptions,
} from "./workspace-app-client.js";

const DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER = 1024 * 1024;

export type TuttiCliJsonRunner = (
  args: string[],
  options: {
    cwd?: string;
    maxBuffer: number;
    timeoutMs: number;
  },
) => Promise<unknown>;

export interface TuttiRecommendedSystemPrompt {
  content: string;
  format?: string;
}

export interface TuttiAgentSkillBundle {
  agentSessionId?: string;
  cliCommand?: string;
  provider?: string;
  recommendedSystemPrompt?: TuttiRecommendedSystemPrompt;
  schemaVersion?: number;
  skills: SkillMaterializationRecord[];
}

export interface TuttiAgentSkillContext extends TuttiAgentSkillBundle {
  skillManifest: SkillMaterializationRecord[];
}

export interface ResolveTuttiCliCommandInput {
  env?: Record<string, string | undefined>;
  envNames?: string[];
}

export interface LoadTuttiAgentSkillBundleInput {
  agentSessionId?: string | null;
  command?: string | null;
  commandEnvNames?: string[];
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  provider: string;
  runTuttiCli?: TuttiCliJsonRunner;
  timeoutMs?: number;
}

export type LoadTuttiAgentSkillContextInput = LoadTuttiAgentSkillBundleInput;

export function resolveTuttiCliCommand(
  input: ResolveTuttiCliCommandInput = {},
): string {
  const env = input.env ?? process.env;
  for (const name of [...(input.envNames ?? []), "TUTTI_CLI"]) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return "";
}

export async function loadTuttiAgentSkillBundle(
  input: LoadTuttiAgentSkillBundleInput,
): Promise<TuttiAgentSkillBundle> {
  const args = createTuttiAgentSkillBundleArgs(input);
  const maxBuffer = input.maxBuffer ?? DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS;
  const cwd = normalizeOptionalString(input.cwd);

  const payload =
    input.runTuttiCli ?
      await input.runTuttiCli(args, {
        ...(cwd ? { cwd } : {}),
        maxBuffer,
        timeoutMs,
      })
    : await runTuttiCliCommand({
        args,
        command: normalizeOptionalString(input.command) ??
          resolveTuttiCliCommand({
            env: input.env,
            envNames: input.commandEnvNames,
          }),
        ...(cwd ? { cwd } : {}),
        env: input.env ?? process.env,
        maxBuffer,
        timeoutMs,
      });

  if (payload === undefined) return { skills: [] };

  const bundle = parseTuttiAgentSkillBundle(payload);
  assertTuttiAgentSkillBundleMatchesInput(bundle, input);
  return bundle;
}

export async function loadTuttiAgentSkillContext(
  input: LoadTuttiAgentSkillContextInput,
): Promise<TuttiAgentSkillContext> {
  const bundle = await loadTuttiAgentSkillBundle(input);

  return {
    ...bundle,
    skillManifest: bundle.skills,
  };
}

export function parseTuttiAgentSkillBundle(
  value: unknown,
): TuttiAgentSkillBundle {
  const payload =
    typeof value === "string" ?
      parseJsonRecord(value, "Tutti skill bundle response")
    : value;
  if (!isRecord(payload)) {
    throw new Error("Tutti skill bundle response is not an object");
  }
  if (!Array.isArray(payload.skills)) {
    throw new Error("Tutti skill bundle response does not contain a skills array");
  }

  const recommendedSystemPrompt = parseRecommendedSystemPrompt(
    payload.recommendedSystemPrompt,
  );

  return {
    ...(typeof payload.schemaVersion === "number" ?
      { schemaVersion: payload.schemaVersion }
    : {}),
    ...(typeof payload.provider === "string" ?
      { provider: payload.provider }
    : {}),
    ...(typeof payload.agentSessionId === "string" ?
      { agentSessionId: payload.agentSessionId }
    : {}),
    ...(typeof payload.cliCommand === "string" ?
      { cliCommand: payload.cliCommand }
    : {}),
    ...(recommendedSystemPrompt ? { recommendedSystemPrompt } : {}),
    skills: payload.skills.map((item, index) => {
      if (!isSkillMaterializationRecord(item)) {
        throw new Error(
          `Tutti skill bundle contains an invalid skill record at index ${index}`,
        );
      }
      return item;
    }),
  };
}

function createTuttiAgentSkillBundleArgs(
  input: LoadTuttiAgentSkillBundleInput,
): string[] {
  const agentSessionId = normalizeOptionalString(input.agentSessionId);
  return [
    "agent",
    "tutti-cli-skill-bundle",
    "--provider",
    input.provider,
    ...(agentSessionId ? ["--agent-session-id", agentSessionId] : []),
    "--json",
  ];
}

async function runTuttiCliCommand(input: {
  args: string[];
  command: string;
  cwd?: string;
  env: NodeJS.ProcessEnv;
  maxBuffer: number;
  timeoutMs: number;
}): Promise<unknown> {
  if (!input.command.trim()) return undefined;

  return await new Promise<unknown>((resolve, reject) => {
    execFile(
      input.command,
      input.args,
      {
        ...(input.cwd ? { cwd: input.cwd } : {}),
        encoding: "utf8",
        env: input.env,
        maxBuffer: input.maxBuffer,
        timeout: input.timeoutMs,
      },
      (error, stdout, stderr) => {
        if (error) {
          const message = (stderr || stdout).trim() || error.message;
          reject(new Error(message));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

function assertTuttiAgentSkillBundleMatchesInput(
  bundle: TuttiAgentSkillBundle,
  input: LoadTuttiAgentSkillBundleInput,
) {
  if (bundle.provider && bundle.provider !== input.provider) {
    throw new Error(
      `Tutti skill bundle provider mismatch: expected ${input.provider}, got ${bundle.provider}`,
    );
  }

  const expectedAgentSessionId = normalizeOptionalString(input.agentSessionId);
  if (
    expectedAgentSessionId &&
    bundle.agentSessionId &&
    bundle.agentSessionId !== expectedAgentSessionId
  ) {
    throw new Error(
      `Tutti skill bundle session mismatch: expected ${expectedAgentSessionId}, got ${bundle.agentSessionId}`,
    );
  }
}

function parseJsonRecord(value: string, label: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new Error(
      `${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function parseRecommendedSystemPrompt(
  value: unknown,
): TuttiRecommendedSystemPrompt | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw new Error("Tutti skill bundle recommendedSystemPrompt is not an object");
  }
  if (typeof value.content !== "string") {
    throw new Error(
      "Tutti skill bundle recommendedSystemPrompt.content is not a string",
    );
  }

  return {
    ...(typeof value.format === "string" ? { format: value.format } : {}),
    content: value.content,
  };
}

function isSkillMaterializationRecord(
  value: unknown,
): value is SkillMaterializationRecord {
  if (!isRecord(value)) return false;
  if (typeof value.skillId !== "string" || !value.skillId) return false;
  if (typeof value.slug !== "string" || !value.slug) return false;
  if (
    value.deliveryMode !== "materialized-files" &&
    value.deliveryMode !== "prompt-injection" &&
    value.deliveryMode !== "project-instructions"
  ) {
    return false;
  }
  if (value.content !== undefined && typeof value.content !== "string") {
    return false;
  }
  if (
    value.materializedPath !== undefined &&
    typeof value.materializedPath !== "string"
  ) {
    return false;
  }
  if (value.files !== undefined) {
    if (!Array.isArray(value.files)) return false;
    return value.files.every(isSkillMaterializationFile);
  }
  return true;
}

function isSkillMaterializationFile(
  value: unknown,
): value is SkillMaterializationFile {
  return isRecord(value) &&
    typeof value.path === "string" &&
    typeof value.content === "string";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function normalizeOptionalString(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}
