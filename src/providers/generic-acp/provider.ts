import type { AgentEvent } from "../../core/events.js";
import type { AgentDetectionDiagnostic } from "../../core/provider-plugin.js";
import type { LocalAgentProviderPlugin } from "../../core/provider-plugin.js";
import type { RawAgentStream } from "../../core/transport.js";
import {
  applyManagedAgentInvocationToLaunchPlan,
  applyManagedAgentInvocationToRunParams,
  prepareManagedAgentInvocationDetectContext,
} from "../../core/managed-invocation.js";
import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { resolveAgentPermissionSelection } from "../../core/permissions.js";
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

  function toModelDiscoveryDiagnostic(error: unknown): AgentDetectionDiagnostic {
    return {
      message:
        error instanceof Error
          ? error.message
          : "ACP model discovery failed.",
      source: "acp-model-discovery",
    };
  }

  const plugin: LocalAgentProviderPlugin<"local-agent", string> = {
    id: input.providerId,
    displayName: input.displayName,
    kind: "local-agent",
    async detect(context) {
      const detectionContext = prepareManagedAgentInvocationDetectContext(
        input.providerId,
        context,
      );
      let executablePath: string;
      try {
        executablePath = await resolveCommandExecutable({
          command: input.command,
          ...(detectionContext?.env ? { env: detectionContext.env } : {}),
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
      let diagnostics: AgentDetectionDiagnostic[] | undefined;
      let models: Array<{ id: string; label: string }> = [];
      try {
        models = await detectAcpModels({
          args: input.args,
          bin: executablePath,
          cwd: detectionContext?.cwd ?? process.cwd(),
          ...(detectionContext?.env ? { env: detectionContext.env } : {}),
          ...(detectionContext?.redactionSecrets
            ? { redactionSecrets: detectionContext.redactionSecrets }
            : {}),
        });
      } catch (error) {
        diagnostics = [toModelDiscoveryDiagnostic(error)];
      }
      return {
        authState: "unknown",
        executablePath,
        ...(diagnostics ? { diagnostics } : {}),
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
      params = applyManagedAgentInvocationToRunParams(input.providerId, params);
      params = {
        ...params,
        permission: resolveAgentPermissionSelection(params.permission),
      };
      const prompt = composePromptWithSystem({
        prompt: params.prompt,
        ...(params.systemPrompt ? { systemPrompt: params.systemPrompt } : {}),
      });
      return applyManagedAgentInvocationToLaunchPlan(input.providerId, {
        args: input.args,
        command: input.command,
        cwd: params.cwd,
        ...(params.env ? { env: params.env } : {}),
        ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
        ...(params.model ? { model: params.model } : {}),
        ...(params.permission ? { permission: params.permission } : {}),
        ...(params.resume ? { resume: params.resume } : {}),
        ...(params.timeoutMs ? { timeoutMs: params.timeoutMs } : {}),
        prompt,
        promptInput: "stdin",
        runId: params.runId,
        transport: "acp-json-rpc",
      }, params.managedAgentInvocation);
    },
    createAdapter() {
      return {
        buildLaunchPlan: (params) => plugin.buildLaunchPlan(params),
        capabilities: () => plugin.capabilities(),
        parseEvents: parseAcpEvents,
      };
    },
    async *run(params) {
      params = applyManagedAgentInvocationToRunParams(input.providerId, params);
      const plan = await plugin.buildLaunchPlan(params);
      const { mcpServers: _paramsMcpServers, ...paramsWithoutMcpServers } =
        params;
      yield* runAcpTransport(plan, {
        ...paramsWithoutMcpServers,
        ...(plan.mcpServers ? { mcpServers: plan.mcpServers } : {}),
        permission: resolveAgentPermissionSelection(plan.permission),
        cwd: plan.cwd,
        prompt: plan.prompt,
      });
    },
  };

  return plugin;
}
