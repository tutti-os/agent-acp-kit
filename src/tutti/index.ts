import type {
  SkillMaterializationFile,
  SkillMaterializationRecord,
} from "../core/skills.js";
import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
  TuttiIntegrationError,
  type TuttiCliJsonRequest,
} from "./cli-json-runner.js";
import type { TuttiAgentIntegrationSource } from "./contracts.js";
import { canonicalTuttiProviderId } from "./internal.js";

export {
  TuttiIntegrationError,
  resolveTuttiCliCommand,
} from "./cli-json-runner.js";
export {
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "./child-process.js";
export type {
  ResolveTuttiCliCommandInput,
  TuttiCliJsonRunner,
  TuttiIntegrationErrorCode,
} from "./cli-json-runner.js";
export type {
  ProjectTuttiCliChildProcessInput,
  TuttiCliChildProcessProjection,
} from "./child-process.js";
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
  TuttiResolvedAgentProviderCatalog,
  TuttiResolvedAgentProviderCatalogEntry,
  TuttiResolvedAgentProviderCatalogModel,
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

export interface LoadTuttiAgentSkillBundleInput
  extends Omit<TuttiCliJsonRequest, "args"> {
  agentSessionId?: string | null;
  provider: string;
  browserUse?: boolean;
  computerUse?: boolean;
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
    detectContext: input.detectContext,
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
  if (payload.schemaVersion !== 1) {
    throw new TuttiIntegrationError(
      "unsupported_schema",
      "Tutti skill bundle schema is unsupported.",
      {
        schemaVersion:
          typeof payload.schemaVersion === "number" ? payload.schemaVersion : -1,
      },
    );
  }
  const rawProvider = normalizeUnknownString(payload.provider);
  if (!rawProvider) {
    throw invalidSkillBundle(
      "Tutti skill bundle response does not contain a valid provider",
    );
  }
  const provider = canonicalTuttiProviderId(rawProvider);
  if (
    payload.agentSessionId !== undefined &&
    !normalizeUnknownString(payload.agentSessionId)
  ) {
    throw invalidSkillBundle(
      "Tutti skill bundle response contains an invalid agentSessionId",
    );
  }
  if (!Array.isArray(payload.skills)) {
    throw invalidSkillBundle("Tutti skill bundle response does not contain a skills array");
  }

  const recommendedSystemPrompt = parseRecommendedSystemPrompt(
    payload.recommendedSystemPrompt,
  );

  return {
    source: "tutti-cli",
    schemaVersion: 1,
    provider,
    ...(normalizeUnknownString(payload.agentSessionId) ?
      { agentSessionId: normalizeUnknownString(payload.agentSessionId) }
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
    canonicalTuttiProviderId(input.provider),
    ...(agentSessionId ? ["--agent-session-id", agentSessionId] : []),
    ...(input.browserUse ? ["--browser-use"] : []),
    ...(input.computerUse ? ["--computer-use"] : []),
  ];
}

function assertTuttiAgentSkillBundleMatchesInput(
  bundle: TuttiAgentSkillBundle,
  input: LoadTuttiAgentSkillBundleInput,
) {
  const expectedProvider = canonicalTuttiProviderId(input.provider);
  if (bundle.provider !== expectedProvider) {
    throw invalidSkillBundle(
      `Tutti skill bundle provider mismatch: expected ${expectedProvider}, got ${bundle.provider}`,
    );
  }

  const expectedAgentSessionId = normalizeOptionalString(input.agentSessionId);
  if (
    expectedAgentSessionId &&
    bundle.agentSessionId !== expectedAgentSessionId
  ) {
    throw invalidSkillBundle(
      bundle.agentSessionId
        ? `Tutti skill bundle session mismatch: expected ${expectedAgentSessionId}, got ${bundle.agentSessionId}`
        : `Tutti skill bundle response does not contain agentSessionId ${expectedAgentSessionId}`,
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

function normalizeUnknownString(value: unknown) {
  return typeof value === "string" ? normalizeOptionalString(value) : undefined;
}

function invalidSkillBundle(message: string) {
  return new TuttiIntegrationError("invalid_response", message);
}
