import { describe, expect, it } from "vitest";

import {
  createJsonRpcLineParser,
  sendJsonRpc,
} from "../../src/transports/acp/acp-jsonrpc.js";

describe("ACP JSON-RPC helpers", () => {
  it("parses newline-delimited envelopes across chunk boundaries", () => {
    const envelopes: Array<{ id: number }> = [];
    const parser = createJsonRpcLineParser((message) => {
      envelopes.push(message as { id: number });
    });

    parser.feed('{"jsonrpc":"2.0","id":1}\n{"jsonrpc":"2.0",');
    parser.feed('"id":2}\n');
    parser.flush();

    expect(envelopes.map((message) => message.id)).toEqual([1, 2]);
  });

  it("writes newline-delimited envelopes", () => {
    let output = "";
    sendJsonRpc(
      {
        write(chunk: string) {
          output += chunk;
          return true;
        },
      } as NodeJS.WritableStream,
      { jsonrpc: "2.0", id: 1, method: "ping" },
    );

    expect(output).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
  });
});
