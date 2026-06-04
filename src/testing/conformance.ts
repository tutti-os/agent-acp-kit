import { createLocalAgentRuntime } from "../runtime/create-runtime.js";
import type { AgentEvent } from "../core/events.js";
import type { AgentRunInput } from "../core/run-input.js";
import type { LocalAgentProviderPlugin } from "../core/provider-plugin.js";

export type ProviderConformanceResult = {
  providerId: string;
  checks: string[];
};

export async function assertProviderConformance<
  TKind extends string = string,
  TProvider extends string = string,
>(input: {
  provider: LocalAgentProviderPlugin<TKind, TProvider>;
  runInput: AgentRunInput<TKind, TProvider>;
  expectedTerminalStatus?: "completed" | "failed" | "canceled";
}): Promise<ProviderConformanceResult> {
  const checks: string[] = [];
  const provider = input.provider;

  const detection = await provider.detect();
  if (detection !== null && typeof detection.executablePath !== "string") {
    throw new Error(`Provider ${String(provider.id)} returned an invalid detection result.`);
  }
  checks.push("detect");

  const adapter = provider.createAdapter?.();
  if (!adapter) {
    throw new Error(`Provider ${String(provider.id)} must expose createAdapter().`);
  }

  const launchPlan = await adapter.buildLaunchPlan(input.runInput);
  if (!launchPlan.command || !launchPlan.cwd) {
    throw new Error(`Provider ${String(provider.id)} returned an invalid launch plan.`);
  }
  checks.push("launch-plan");

  const parsedEvents: AgentEvent[] = [];
  async function* rawEvents() {
    yield { type: "done", status: input.expectedTerminalStatus ?? "completed" };
  }
  for await (const event of adapter.parseEvents(rawEvents())) {
    parsedEvents.push(event);
  }
  if (!parsedEvents.some((event) => event.type === "done")) {
    throw new Error(`Provider ${String(provider.id)} parser did not emit a terminal event.`);
  }
  checks.push("parser");

  const runtime = createLocalAgentRuntime({
    providers: [provider],
    transports: [
      {
        kind: launchPlan.transport ?? "jsonl",
        async *run() {
          yield { type: "done", status: input.expectedTerminalStatus ?? "completed" };
        },
      },
    ],
  });
  const runtimeEvents: AgentEvent[] = [];
  for await (const event of runtime.run(input.runInput)) {
    runtimeEvents.push(event);
  }
  if (
    !runtimeEvents.some(
      (event) =>
        event.type === "done" &&
        event.status === (input.expectedTerminalStatus ?? "completed"),
    )
  ) {
    throw new Error(`Provider ${String(provider.id)} did not complete through runtime facade.`);
  }
  checks.push("runtime-facade");

  return {
    providerId: String(provider.id),
    checks,
  };
}
