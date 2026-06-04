import type { JsonRpcEnvelope } from "./acp-types.js";

export function createJsonRpcLineParser(
  onMessage: (message: JsonRpcEnvelope) => void,
) {
  let buffer = "";

  return {
    feed(chunk: string) {
      buffer += chunk;
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        onMessage(JSON.parse(trimmed) as JsonRpcEnvelope);
      }
    },
    flush() {
      const trimmed = buffer.trim();
      if (!trimmed) return;
      onMessage(JSON.parse(trimmed) as JsonRpcEnvelope);
      buffer = "";
    },
  };
}

export function sendJsonRpc(
  writable: NodeJS.WritableStream,
  envelope: JsonRpcEnvelope,
) {
  writable.write(`${JSON.stringify(envelope)}\n`);
}
