import { createDefaultLocalAgentProviderPlugins } from "../providers/acp-presets/provider.js";
import { createLocalAgentRuntime } from "./create-runtime.js";
import { detectTuttiManagedProviders } from "../tutti/runtime-detection.js";

/** Creates the standard app-owned runtime used by Tutti workspace apps. */
export function createDefaultLocalAgentRuntime() {
  return createLocalAgentRuntime({
    providers: createDefaultLocalAgentProviderPlugins(),
    detectManagedProviders: detectTuttiManagedProviders,
  });
}
