import type { AgentEvent } from "../../core/events.js";
import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { RawAgentStream } from "../../core/transport.js";

async function* parseFakeRawEvents(stream: RawAgentStream): AsyncGenerator<AgentEvent> {
  let terminalSeen = false;
  for await (const item of stream) {
    const event = item as AgentEvent;
    if (event.type === "done") {
      if (terminalSeen) {
        continue;
      }
      terminalSeen = true;
    }
    yield event;
  }
}

export function createFakeProvider(input?: {
  events?: AgentEvent[];
  providerId?: string;
}): LocalAgentProviderPlugin<"local-agent", "fake"> {
  const events = input?.events ?? [
    { type: "status", status: "running", stage: "running" },
    { type: "text_delta", text: "fake local-agent response" },
    { type: "done", status: "completed", reason: "completed" },
  ];
  const buildFakeLaunchPlan: LocalAgentProviderPlugin<
    "local-agent",
    "fake"
  >["buildLaunchPlan"] = async (params) => {
    const script = `
const events = ${JSON.stringify(events)};
for (const event of events) {
  process.stdout.write(JSON.stringify(event) + "\\n");
}
`;
    return {
      args: ["-e", script],
      command: process.execPath,
      cwd: params.cwd,
      prompt: params.prompt,
      promptInput: "stdin",
      runId: params.runId,
      transport: "jsonl",
    };
  };
  const capabilities: LocalAgentProviderPlugin<
    "local-agent",
    "fake"
  >["capabilities"] = () => ({
    cancel: true,
    nativeResume: true,
    streaming: true,
    toolGateway: true,
    maxConcurrentRuns: 99,
  });

  return {
    id: "fake",
    displayName: "Fake Local Agent",
    kind: "local-agent",
    async detect() {
      return {
        authState: "ok",
        executablePath: input?.providerId ?? "fake",
        supported: true,
        version: "0.0.0",
      };
    },
    capabilities,
    buildLaunchPlan: buildFakeLaunchPlan,
    createAdapter() {
      return {
        buildLaunchPlan: buildFakeLaunchPlan,
        capabilities,
        parseEvents: parseFakeRawEvents,
      };
    },
    async *run() {
      for (const event of events) {
        yield event;
      }
    },
  };
}

export const fakeProvider = createFakeProvider();
