import type { AgentRuntimeRecord, RuntimeTarget } from "./capabilities.js";
import type { DetectContext } from "./detection.js";
import type { AgentEvent } from "./events.js";
import type { LaunchPlan, TransportKind } from "./launch-plan.js";
import type { ManagedAgentInvocation } from "./managed-invocation.js";
import type { LocalAgentMcpServerConfig } from "./mcp.js";
import type { AgentPermissionSelection } from "./permissions.js";
import type { SkillMaterializationRecord } from "./skills.js";
import type { RawAgentStream } from "./transport.js";

export type RuntimeProvider<
  TContext,
  TEvent,
  TKind extends string = string,
  TProvider extends string = string,
> = {
  /** Legacy provider ids accepted at runtime boundaries. Targets always resolve to runtime.provider. */
  aliases?: readonly string[];
  runtime: AgentRuntimeRecord<TKind, TProvider>;
  streamRun(context: TContext): AsyncGenerator<TEvent>;
};

export type RuntimeKindSelectorInput<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  availableRuntimeTargets: RuntimeTarget<TKind, TProvider>[];
  model: unknown;
  requestedRuntimeKind: TKind | undefined;
  requestedRuntimeProvider?: TProvider | undefined;
};

export type RuntimeKindSelector<
  TKind extends string = string,
  TProvider extends string = string,
> = (
  input: RuntimeKindSelectorInput<TKind, TProvider>,
) => RuntimeTarget<TKind, TProvider>;

export type RuntimeLease<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  runId: string;
  runtimeId: string;
  target: RuntimeTarget<TKind, TProvider>;
  release(): void;
};

export type AgentModelOption = {
  id: string;
  label: string;
  description?: string;
};

export type AgentDetectionDiagnostic = {
  message: string;
  source?: string;
};

export type AgentDetection<TModel extends AgentModelOption = AgentModelOption> = {
  authState: "ok" | "missing" | "expired" | "unknown";
  executablePath: string;
  configDir?: string;
  diagnostics?: AgentDetectionDiagnostic[];
  minimumVersion?: string;
  models?: TModel[];
  skillsDir?: string;
  supported?: boolean;
  unsupportedReason?: string;
  version: string;
};

export type AgentRunMessage = {
  role: "user" | "assistant" | "system";
  content: string;
};

export type AgentRunParams<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  runId: string;
  cwd: string;
  prompt: string;
  systemPrompt?: string;
  history?: AgentRunMessage[];
  model?: string;
  reasoning?: string;
  permission?: AgentPermissionSelection;
  runtimeKind?: TKind;
  runtimeProvider?: TProvider;
  extraAllowedDirs?: string[];
  mcpServers?: LocalAgentMcpServerConfig[];
  signal?: AbortSignal;
  skillManifest?: SkillMaterializationRecord[];
  env?: Record<string, string>;
  managedAgentInvocation?: ManagedAgentInvocation;
  timeoutMs?: number;
  metadata?: Record<string, unknown>;
  resume?: {
    mode: "native" | "provider" | "fresh";
    providerSessionId?: string;
    resumeToken?: string;
  };
};

export type ProviderLaunchPlan = LaunchPlan;

export type LocalAgentProviderAdapter<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  buildLaunchPlan(params: AgentRunParams<TKind, TProvider>): Promise<ProviderLaunchPlan>;
  parseEvents(stream: RawAgentStream): AsyncIterable<AgentEvent>;
  capabilities(): AgentRuntimeRecord<TKind, TProvider>["capabilities"];
};

export type LocalAgentProviderPlugin<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  id: TProvider;
  /** Legacy input ids accepted by the runtime. Catalogs always expose `id`. */
  aliases?: readonly string[];
  /** Require a positive auth probe before catalogs advertise this provider. */
  requiresKnownAuth?: boolean;
  displayName: string;
  kind: TKind;
  detect(context?: DetectContext): Promise<AgentDetection | null>;
  capabilities(): AgentRuntimeRecord<TKind, TProvider>["capabilities"];
  createAdapter?(): LocalAgentProviderAdapter<TKind, TProvider>;
  buildLaunchPlan(params: AgentRunParams<TKind, TProvider>): Promise<ProviderLaunchPlan>;
  run(params: AgentRunParams<TKind, TProvider>): AsyncGenerator<AgentEvent>;
  cancel?(runId: string): Promise<void>;
};
