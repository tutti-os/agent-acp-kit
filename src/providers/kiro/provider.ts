import { createGenericAcpProvider } from "../generic-acp/provider.js";

export function createKiroProvider() {
  return createGenericAcpProvider({
    command: process.env.KIRO_ACP_BIN ?? "kiro",
    args: ["acp"],
    displayName: "Kiro",
    providerId: "kiro",
  });
}

export const kiroProvider = createKiroProvider();
