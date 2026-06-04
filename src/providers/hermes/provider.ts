import { createGenericAcpProvider } from "../generic-acp/provider.js";

export function createHermesProvider() {
  return createGenericAcpProvider({
    command: process.env.HERMES_ACP_BIN ?? "hermes",
    args: ["acp"],
    displayName: "Hermes",
    providerId: "hermes",
  });
}

export const hermesProvider = createHermesProvider();
