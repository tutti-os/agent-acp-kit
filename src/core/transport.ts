import type { AgentEvent } from "./events.js";
import type { LaunchPlan, TransportKind } from "./launch-plan.js";

export type RawAgentEvent = unknown;

export type RawAgentStream = AsyncIterable<RawAgentEvent>;

export type TransportRunResult = AsyncIterable<RawAgentEvent> & {
  cancel?: () => Promise<void> | void;
};

export type Transport = {
  kind: TransportKind;
  run(plan: LaunchPlan, signal?: AbortSignal): TransportRunResult;
};

export type ProviderAdapter = {
  buildLaunchPlan(input: unknown): Promise<LaunchPlan>;
  parseEvents(stream: RawAgentStream): AsyncIterable<AgentEvent>;
  capabilities(): unknown;
};
