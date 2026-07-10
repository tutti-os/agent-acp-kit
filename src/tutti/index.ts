import type {
  SkillMaterializationFile,
  SkillMaterializationRecord,
} from "../core/skills.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRunner,
} from "./cli-json-runner.js";
import type { TuttiAgentIntegrationSource } from "./contracts.js";

export {
  TuttiIntegrationError,
  resolveTuttiCliCommand,
} from "./cli-json-runner.js";
export type {
  ResolveTuttiCliCommandInput,
  TuttiCliJsonRunner,
  TuttiIntegrationErrorCode,
} from "./cli-json-runner.js";
export {
  loadTuttiAgentProviderCatalog,
  parseTuttiAgentProviderCatalog,
} from "./provider-catalog.js";
export type { LoadTuttiAgentProviderCatalogInput } from "./provider-catalog.js";
export {
  loadTuttiAgentComposerOptions,
  parseTuttiAgentComposerOptions,
} from "./composer-options.js";
export type { LoadTuttiAgentComposerOptionsInput } from "./composer-options.js";
export {
  displayNameForAgentProvider,
  findTuttiAgentCatalogProvider,
  resolveTuttiAgentProviderCatalog,
} from "./runtime-provider-catalog.js";
export type {
  ResolveTuttiAgentProviderCatalogInput,
  TuttiAgentProviderCatalogEntry,
  TuttiAgentProviderCatalogModel,
  TuttiAgentProviderCatalogResult,
} from "./runtime-provider-catalog.js";
export * from "./contracts.js";

const DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS = 10_000;
const DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER = 1024 * 1024;

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
  source: TuttiAgentIntegrationSource;
  skills: SkillMaterializationRecord[];
}

export interface TuttiAgentSkillContext extends TuttiAgentSkillBundle {
  skillManifest: SkillMaterializationRecord[];
}

export interface LoadTuttiAgentSkillBundleInput {
  agentSessionId?: string | null;
  command?: string | null;
  commandEnvNames?: string[];
  cwd?: string | null;
  env?: NodeJS.ProcessEnv;
  maxBuffer?: number;
  provider: string;
  browserUse?: boolean;
  computerUse?: boolean;
  runTuttiCli?: TuttiCliJsonRunner;
  signal?: AbortSignal;
  timeoutMs?: number;
}

export type LoadTuttiAgentSkillContextInput = LoadTuttiAgentSkillBundleInput;

export async function loadTuttiAgentSkillBundle(
  input: LoadTuttiAgentSkillBundleInput,
): Promise<TuttiAgentSkillBundle> {
  if (!hasConfiguredTuttiCli(input)) {
    return { source: "standalone", skills: [] };
  }
  const args = createTuttiAgentSkillBundleArgs(input);
  const maxBuffer = input.maxBuffer ?? DEFAULT_TUTTI_SKILL_BUNDLE_MAX_BUFFER;
  const timeoutMs = input.timeoutMs ?? DEFAULT_TUTTI_SKILL_BUNDLE_TIMEOUT_MS;
  const cwd = normalizeOptionalString(input.cwd);

  const payload = await runTuttiCliJson({
    args,
    command: input.command,
    commandEnvNames: input.commandEnvNames,
    ...(cwd ? { cwd } : {}),
    env: input.env,
    maxBuffer,
    runTuttiCli: input.runTuttiCli,
    signal: input.signal,
    timeoutMs,
  });

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
    throw invalidSkillBundle("Tutti skill bundle response is not an object");
  }
  if (!Array.isArray(payload.skills)) {
    throw invalidSkillBundle("Tutti skill bundle response does not contain a skills array");
  }

  const recommendedSystemPrompt = parseRecommendedSystemPrompt(
    payload.recommendedSystemPrompt,
  );

  return {
    source: "tutti-cli",
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
        throw invalidSkillBundle(
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
    "--json",
    "agent",
    "tutti-cli-skill-bundle",
    "--provider",
    input.provider,
    ...(agentSessionId ? ["--agent-session-id", agentSessionId] : []),
    ...(input.browserUse ? ["--browser-use"] : []),
    ...(input.computerUse ? ["--computer-use"] : []),
  ];
}

function assertTuttiAgentSkillBundleMatchesInput(
  bundle: TuttiAgentSkillBundle,
  input: LoadTuttiAgentSkillBundleInput,
) {
  if (bundle.provider && bundle.provider !== input.provider) {
    throw invalidSkillBundle(
      `Tutti skill bundle provider mismatch: expected ${input.provider}, got ${bundle.provider}`,
    );
  }

  const expectedAgentSessionId = normalizeOptionalString(input.agentSessionId);
  if (
    expectedAgentSessionId &&
    bundle.agentSessionId &&
    bundle.agentSessionId !== expectedAgentSessionId
  ) {
    throw invalidSkillBundle(
      `Tutti skill bundle session mismatch: expected ${expectedAgentSessionId}, got ${bundle.agentSessionId}`,
    );
  }
}

function parseJsonRecord(value: string, label: string): unknown {
  try {
    return JSON.parse(value || "{}");
  } catch (error) {
    throw new TuttiIntegrationError(
      "invalid_response",
      `${label} is not valid JSON.`,
      {},
      { cause: error },
    );
  }
}

function parseRecommendedSystemPrompt(
  value: unknown,
): TuttiRecommendedSystemPrompt | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) {
    throw invalidSkillBundle("Tutti skill bundle recommendedSystemPrompt is not an object");
  }
  if (typeof value.content !== "string") {
    throw invalidSkillBundle(
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

function invalidSkillBundle(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}
