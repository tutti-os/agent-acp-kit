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
        "session/set_model",
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
