import { describe, expect, it } from "vitest";

import { detectAcpModels } from "../../src/transports/acp/acp-models.js";
import { runAcpTransport } from "../../src/transports/acp/acp-client.js";
import { createFakeAcpPeerScript } from "../../src/testing/index.js";

describe("runAcpTransport", () => {
  it("discovers ACP models from session/new", async () => {
    const script = createFakeAcpPeerScript({
      currentModelId: "kimi-k2",
      models: [
        { modelId: "kimi-k2", name: "Kimi K2" },
        { modelId: "kimi-k2-thinking" },
      ],
      updates: [],
    });

    await expect(
      detectAcpModels({
        args: ["-e", script],
        bin: process.execPath,
        cwd: process.cwd(),
      }),
    ).resolves.toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "kimi-k2", label: "Kimi K2 (kimi-k2) (current)" },
      { id: "kimi-k2-thinking", label: "kimi-k2-thinking" },
    ]);
  });

  it("includes redacted stderr when ACP model discovery exits early", async () => {
    const secret = "acp-model-secret";

    await expect(
      detectAcpModels({
        args: [
          "-e",
          `process.stderr.write("model probe failed: ${secret}"); setTimeout(() => process.exit(7), 10);`,
        ],
        bin: process.execPath,
        cwd: process.cwd(),
        redactionSecrets: [secret],
      }),
    ).rejects.toThrow(
      "ACP model detection exited with code 7. stderr: model probe failed: [REDACTED]",
    );
  });

  it("maps ACP session updates into normalized agent events", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      updates: [
        { sessionUpdate: "text_delta", content: { type: "text", text: "hello" } },
        { sessionUpdate: "reasoning_delta", content: { type: "text", text: "thinking" } },
        { type: "tool_call", id: "tool_1", name: "generate_image", input: { prompt: "x" } },
        {
          type: "tool_result",
          id: "tool_1",
          name: "generate_image",
          output: { imageUrl: "https://example.com/image.png" },
        },
        { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      ],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "make image",
        runId: "run_acp",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "hello" },
      { type: "thinking_delta", text: "thinking" },
      {
        type: "tool_call",
        id: "tool_1",
        name: "generate_image",
        input: { prompt: "x" },
      },
      {
        type: "tool_result",
        id: "tool_1",
        name: "generate_image",
        status: "completed",
        output: { imageUrl: "https://example.com/image.png" },
      },
      { type: "usage", usage: { inputTokens: 1, outputTokens: 2 } },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_fake",
      },
    ]);
  });

  it("waits for lifecycle acknowledgements and sets model before prompt", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      expectedMethods: [
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/prompt",
      ],
      sessionId: "session_model",
      updates: [{ type: "text_delta", text: "model ready" }],
    });

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        model: "kimi-k2",
        prompt: "make image",
        runId: "run_acp_model",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "model ready" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session_model",
      },
    ]);
  });

  it("uses ACP capabilities, model fallback, prompt content, and permission result shape", async () => {
    const script = String.raw`
process.stdin.setEncoding("utf8");
let buffer = "";
let promptRequestId;
function send(message) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
}
function fail(message) {
  send({ method: "session/update", params: { type: "error", error: message } });
  process.exit(2);
}
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf("\n");
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    index = buffer.indexOf("\n");
    if (!line) continue;
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      if (message.params?.clientCapabilities?.fs?.readTextFile !== false ||
          message.params?.clientCapabilities?._meta?.terminal_output !== true) {
        fail("invalid client capabilities");
        return;
      }
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/new") {
      send({ id: message.id, result: { sessionId: "session-fallback" } });
    } else if (message.method === "session/set_config_option") {
      send({ id: message.id, error: { code: -32601, message: "unsupported" } });
    } else if (message.method === "session/set_model") {
      if (message.params?.modelId !== "model-x") {
        fail("missing modelId");
        return;
      }
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/prompt") {
      if (!Array.isArray(message.params?.prompt) || message.params.prompt[0]?.text !== "hello") {
        fail("prompt is not ACP content");
        return;
      }
      promptRequestId = message.id;
      send({
        id: 99,
        method: "session/request_permission",
        params: { options: [{ optionId: "allow" }] },
      });
    } else if (message.id === 99) {
      if (message.result?.outcome?.outcome !== "selected" ||
          message.result?.outcome?.optionId !== "allow") {
        fail("invalid permission response");
        return;
      }
      send({ method: "session/update", params: { sessionUpdate: "text_delta", content: { text: "ok" } } });
      send({ id: promptRequestId, result: { stopReason: "end_turn" } });
      setTimeout(() => process.exit(0), 5);
    }
  }
});
`;
    const events = [];
    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "hello",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        model: "model-x",
        prompt: "hello",
        runId: "run_acp_fallback",
      },
    )) {
      events.push(event);
    }
    expect(events).toEqual([
      { type: "text_delta", text: "ok" },
      {
        type: "done",
        status: "completed",
        reason: "completed",
        exitCode: 0,
        sessionId: "session-fallback",
      },
    ]);
  });

  it("fails lifecycle requests promptly when the ACP peer exits before acknowledgement", async () => {
    const events = [];

    for await (const event of runAcpTransport(
      {
        args: ["-e", "process.exit(1)"],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "make image",
        promptInput: "stdin",
        timeoutMs: 5_000,
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "make image",
        runId: "run_acp_exit",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "error",
          code: "acp_lifecycle_failed",
        }),
        expect.objectContaining({
          type: "done",
          status: "failed",
        }),
      ]),
    );
  });
});
