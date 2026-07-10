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
        { type: "text_delta", text: "hello" },
        {
          sessionUpdate: "agent_message_chunk",
          content: { type: "text", text: " nested" },
        },
        { type: "reasoning_delta", text: "thinking" },
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
      { type: "text_delta", text: " nested" },
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
      expect.objectContaining({
        type: "done",
        status: "completed",
        reason: "completed",
        sessionId: "session_fake",
      }),
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
      expectPromptContentBlocks: true,
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
      expect.objectContaining({
        type: "done",
        status: "completed",
        reason: "completed",
        sessionId: "session_model",
      }),
    ]);
  });

  it("falls back to session/set_model when config options are unsupported", async () => {
    const events = [];
    const script = createFakeAcpPeerScript({
      errorMethods: ["session/set_config_option"],
      expectedMethods: [
        "initialize",
        "session/new",
        "session/set_config_option",
        "session/set_model",
        "session/prompt",
      ],
      sessionId: "session_model_fallback",
      updates: [{ type: "text_delta", text: "fallback ready" }],
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
        runId: "run_acp_model_fallback",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "fallback ready" },
      expect.objectContaining({
        type: "done",
        status: "completed",
        reason: "completed",
        sessionId: "session_model_fallback",
      }),
    ]);
  });

  it("answers ACP permission requests with the selected outcome shape", async () => {
    const events = [];
    const script = `
process.stdin.setEncoding("utf8");
let buffer = "";
let permissionGranted = false;
let sessionNewRequestId;
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
    if (message.method === "initialize") {
      send({ id: message.id, result: { ok: true } });
    } else if (message.method === "session/new") {
      sessionNewRequestId = message.id;
      send({
        id: "permission-1",
        method: "session/request_permission",
        params: { options: [{ optionId: "allow" }] },
      });
    } else if (message.id === "permission-1" && !message.method) {
      permissionGranted =
        message.result?.outcome?.outcome === "selected" &&
        message.result?.outcome?.optionId === "allow";
      send({ id: sessionNewRequestId, result: { sessionId: "permission-session" } });
    } else if (message.method === "session/prompt") {
      send({ id: message.id, result: { ok: true } });
      send({
        method: "session/update",
        params: { type: "text_delta", text: permissionGranted ? "approved" : "rejected" },
      });
      process.exit(permissionGranted ? 0 : 4);
    }
  }
});
`;

    for await (const event of runAcpTransport(
      {
        args: ["-e", script],
        command: process.execPath,
        cwd: process.cwd(),
        prompt: "continue",
        promptInput: "stdin",
        transport: "acp-json-rpc",
      },
      {
        cwd: process.cwd(),
        prompt: "continue",
        runId: "run_acp_permission",
      },
    )) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "text_delta", text: "approved" },
      expect.objectContaining({
        type: "done",
        status: "completed",
        sessionId: "permission-session",
      }),
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
