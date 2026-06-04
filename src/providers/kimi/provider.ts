import { createGenericAcpProvider } from "../generic-acp/provider.js";

export function createKimiProvider() {
  return createGenericAcpProvider({
    command: process.env.KIMI_ACP_BIN ?? "kimi",
    args: ["acp"],
    displayName: "Kimi",
    providerId: "kimi",
  });
}

export const kimiProvider = createKimiProvider();
