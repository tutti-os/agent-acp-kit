export type AgentRuntimeMode = "server" | "local";
export type AgentRuntimeStatus = "online" | "offline" | "degraded";

export type AgentRuntimeCapabilities = {
  cancel: boolean;
  nativeResume: boolean;
  streaming: boolean;
  toolGateway: boolean;
  maxConcurrentRuns: number;
};

export type AgentRuntimeRecord<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  id: string;
  kind: TKind;
  provider?: TProvider;
  mode: AgentRuntimeMode;
  status: AgentRuntimeStatus;
  capabilities: AgentRuntimeCapabilities;
  lastSeenAt?: string;
};

export type RuntimeTarget<
  TKind extends string = string,
  TProvider extends string = string,
> = {
  kind: TKind;
  provider?: TProvider;
};
