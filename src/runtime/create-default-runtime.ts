import type { LocalAgentProviderPlugin } from "../core/provider-plugin.js";
import type { Transport } from "../core/transport.js";
import { createDefaultLocalAgentProviderPlugins } from "../providers/acp-presets/provider.js";
import {
  createLocalAgentRuntime,
  type LocalAgentRuntime,
} from "./create-runtime.js";
import { createTuttiRuntimeIntegration } from "../tutti/runtime-integration.js";

export type DefaultLocalAgentRuntimeOptions<
  TKind extends string = "local-agent",
  TProvider extends string = string,
> = {
  providers?: LocalAgentProviderPlugin<TKind, TProvider>[];
  transports?: Transport[];
};

/** Creates the standard app-owned runtime used by Tutti workspace apps. */
export function createDefaultLocalAgentRuntime<
  TKind extends string = "local-agent",
  TProvider extends string = string,
>(
  options: DefaultLocalAgentRuntimeOptions<TKind, TProvider> = {},
): LocalAgentRuntime<TKind, TProvider> {
  const providers = options.providers ??
    (createDefaultLocalAgentProviderPlugins() as unknown as LocalAgentProviderPlugin<TKind, TProvider>[]);
  const tuttiIntegration = createTuttiRuntimeIntegration<TKind, TProvider>();
  return createLocalAgentRuntime({
    providers,
    ...(options.transports ? { transports: options.transports } : {}),
    detectTuttiTargets: tuttiIntegration.detect,
    prepareTuttiRun: tuttiIntegration.prepareRun,
  });
}
