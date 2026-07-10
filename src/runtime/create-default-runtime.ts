import { createDefaultLocalAgentProviderPlugins } from "../providers/acp-presets/provider.js";
import { createLocalAgentRuntime } from "./create-runtime.js";

export function createDefaultLocalAgentRuntime() {
  return createLocalAgentRuntime({
    providers: createDefaultLocalAgentProviderPlugins(),
  });
}
