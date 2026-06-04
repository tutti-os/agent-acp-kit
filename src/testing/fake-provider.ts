import type { AgentRuntimeRecord } from "../core/capabilities.js";
import type { RuntimeProvider } from "../core/provider-plugin.js";

export function createFakeRuntimeProvider<
  TContext,
  TEvent,
  TKind extends string = string,
  TProvider extends string = string,
>(input: {
  runtime: AgentRuntimeRecord<TKind, TProvider>;
  events?: TEvent[];
  streamRun?: (context: TContext) => AsyncGenerator<TEvent>;
}): RuntimeProvider<TContext, TEvent, TKind, TProvider> {
  return {
    runtime: input.runtime,
    streamRun:
      input.streamRun ??
      (async function* () {
        for (const event of input.events ?? []) {
          yield event;
        }
      }),
  };
}
