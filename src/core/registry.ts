import type { AgentRuntimeRecord, RuntimeTarget } from "./capabilities.js";

export function getRuntimeTargetKey<
  TKind extends string = string,
  TProvider extends string = string,
>(target: RuntimeTarget<TKind, TProvider>): string {
  return `${target.kind}::${target.provider ?? ""}`;
}

export function getRuntimeTarget<
  TKind extends string = string,
  TProvider extends string = string,
>(runtime: AgentRuntimeRecord<TKind, TProvider>): RuntimeTarget<TKind, TProvider> {
  return {
    kind: runtime.kind,
    ...(runtime.provider ? { provider: runtime.provider } : {}),
  };
}
