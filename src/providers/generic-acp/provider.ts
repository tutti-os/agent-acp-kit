import type { AgentEvent } from "../../core/events.js";
import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { RawAgentStream } from "../../core/transport.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { composePromptWithSystem } from "../../skills/prompt-injection.js";
import { runAcpTransport } from "../../transports/acp/acp-client.js";
import { detectAcpModels } from "../../transports/acp/acp-models.js";

export function createGenericAcpProvider(input: {
  command: string;
  displayName: string;
  providerId: string;
  args: string[];
}) {
  async function* parseAcpEvents(
    stream: RawAgentStream,
  ): AsyncGenerator<AgentEvent> {
    for await (const item of stream) {
      yield item as AgentEvent;
    }
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", string> = {
    id: input.providerId,
    displayName: input.displayName,
    kind: "local-agent",
    async detect() {
      let executablePath: string;
      try {
        executablePath = await resolveCommandExecutable({
          command: input.command,
        });
      } catch (error) {
        return {
          authState: "missing",
          executablePath: input.command,
          models: [],
          supported: false,
          unsupportedReason:
            error instanceof Error
              ? error.message
              : `Executable not found on PATH: ${input.command}`,
          version: "not-installed",
        };
      }
      const models = await detectAcpModels({
        args: input.args,
        bin: executablePath,
        cwd: process.cwd(),
      }).catch(() => []);
      return {
        authState: "unknown",
        executablePath,
        models,
        supported: true,
        version: "unknown",
      };
    },
    capabilities() {
      return {
        cancel: true,
        nativeResume: false,
        streaming: true,
        toolGateway: false,
        maxConcurrentRuns: Number.MAX_SAFE_INTEGER,
      };
    },
    async buildLaunchPlan(params) {
      const prompt = composePromptWithSystem({
        prompt: params.prompt,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      });
      return {
        args: input.args,
        command: input.command,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
        prompt,
        promptInput: "stdin",
        runId: params.runId,
        transport: "acp-json-rpc",
      };
    },
    createAdapter() {
      return {
        buildLaunchPlan: (params) => plugin.buildLaunchPlan(params),
        capabilities: () => plugin.capabilities(),
        parseEvents: parseAcpEvents,
      };
    },
    async *run(params) {
      const plan = await plugin.buildLaunchPlan(params);
      yield* runAcpTransport(plan, {
        ...params,
        prompt: plan.prompt,
      });
    },
  };

  return plugin;
}
