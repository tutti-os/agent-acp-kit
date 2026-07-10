export function createFakeAcpPeer(messages: unknown[]) {
  return messages.map((message) => JSON.stringify(message)).join("\n");
}

export function createFakeAcpPeerScript(input: {
  updates: unknown[];
  exitCode?: number;
  errorMethods?: string[];
  expectedMethods?: string[];
  expectPromptContentBlocks?: boolean;
  models?: Array<{ modelId: string; name?: string }>;
  currentModelId?: string;
  sessionId?: string;
}) {
  return `
process.stdin.setEncoding("utf8");
let buffer = "";
const updates = ${JSON.stringify(input.updates)};
const exitCode = ${input.exitCode ?? 0};
const errorMethods = ${JSON.stringify(input.errorMethods ?? [])};
const expectedMethods = ${JSON.stringify(input.expectedMethods ?? [])};
const expectPromptContentBlocks = ${input.expectPromptContentBlocks ?? false};
const models = ${JSON.stringify(input.models ?? [])};
const currentModelId = ${JSON.stringify(input.currentModelId ?? null)};
const sessionId = ${JSON.stringify(input.sessionId ?? "session_fake")};
const seenMethods = [];

function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\\n");
}

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let newlineIndex = buffer.indexOf("\\n");
  while (newlineIndex >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    newlineIndex = buffer.indexOf("\\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method) {
      seenMethods.push(message.method);
    }
    if (
      expectedMethods.length > 0 &&
      seenMethods.length === expectedMethods.length &&
      JSON.stringify(seenMethods) !== JSON.stringify(expectedMethods)
    ) {
      send({
        method: "session/update",
        params: {
          type: "error",
          error: "Unexpected ACP method order: " + JSON.stringify(seenMethods),
        },
      });
      process.exit(2);
    }
    if (message.id !== undefined) {
      if (errorMethods.includes(message.method)) {
        send({ id: message.id, error: { code: -32601, message: "unsupported" } });
      } else {
        send({
          id: message.id,
          result:
            message.method === "session/new"
              ? {
                  ok: true,
                  sessionId,
                  models: {
                    availableModels: models,
                    ...(currentModelId ? { currentModelId } : {}),
                  },
                }
              : { ok: true },
        });
      }
    }
    if (message.method === "session/prompt") {
      if (expectPromptContentBlocks && !Array.isArray(message.params?.prompt)) {
        process.exit(3);
      }
      for (const update of updates) {
        send({ method: "session/update", params: update });
      }
      process.exit(exitCode);
    }
  }
});
`;
}
