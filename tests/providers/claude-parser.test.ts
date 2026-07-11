import { describe, expect, it } from "vitest";

import { createClaudeProvider } from "../../src/providers/claude/index.js";

async function collectClaudeEvents(items: unknown[]) {
  const adapter = createClaudeProvider().createAdapter();
  expect(adapter).toBeDefined();

  async function* stream() {
    yield* items;
  }

  const events = [];
  for await (const event of adapter!.parseEvents(stream())) {
    events.push(event);
  }
  return events;
}

describe("parseClaudeStreamEvent", () => {
  it("maps assistant text fields into text deltas", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "assistant",
          text: "Hello from Claude.",
        },
      ]),
    ).resolves.toEqual([{ type: "text_delta", text: "Hello from Claude." }]);
  });

  it("maps assistant content tool_use blocks into normalized tool calls", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "assistant",
          message: {
            content: [
              { type: "text", text: "Generating an image..." },
              {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__aimc-tools-mcp__generate_image",
                input: { prompt: "agent poster", model: "codex/gpt-image-2" },
              },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "Generating an image..." },
      {
        type: "tool_call",
        id: "toolu_1",
        name: "generate_image",
        rawName: "mcp__aimc-tools-mcp__generate_image",
        mcpServerName: "aimc-tools-mcp",
        input: { prompt: "agent poster", model: "codex/gpt-image-2" },
      },
    ]);
  });

  it("uses a successful result as the final text only when no assistant text was emitted", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Fallback final answer.",
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "Fallback final answer." },
    ]);

    await expect(
      collectClaudeEvents([
        {
          type: "assistant",
          message: {
            content: [{ type: "text", text: "Streamed final answer." }],
          },
        },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Streamed final answer.",
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "Streamed final answer." },
    ]);

    await expect(
      collectClaudeEvents([
        { type: "text_delta", text: "Already normalized." },
        {
          type: "result",
          subtype: "success",
          is_error: false,
          result: "Already normalized.",
        },
      ]),
    ).resolves.toEqual([
      { type: "text_delta", text: "Already normalized." },
    ]);
  });

  it("maps failed Claude result envelopes to normalized errors", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "result",
          subtype: "error_during_execution",
          is_error: true,
          result: "Authentication expired.",
        },
      ]),
    ).resolves.toEqual([
      {
        type: "error",
        code: "claude_error",
        message: "Authentication expired.",
      },
    ]);
  });

  it("maps user tool_result blocks and preserves the previous tool name", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_1",
                name: "mcp__aimc-tools-mcp__generate_image",
                input: { prompt: "agent poster" },
              },
            ],
          },
        },
        {
          type: "user",
          message: {
            content: [
              {
                type: "tool_result",
                tool_use_id: "toolu_1",
                content: [
                  {
                    type: "text",
                    text: JSON.stringify({
                      output: {
                        imageUrl: "https://example.com/generated.png",
                        width: 1024,
                        height: 1024,
                      },
                      outputSummary: "Image generated.",
                    }),
                  },
                ],
              },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "toolu_1",
        name: "generate_image",
        rawName: "mcp__aimc-tools-mcp__generate_image",
        mcpServerName: "aimc-tools-mcp",
        input: { prompt: "agent poster" },
      },
      {
        type: "tool_result",
        id: "toolu_1",
        name: "generate_image",
        rawName: "mcp__aimc-tools-mcp__generate_image",
        mcpServerName: "aimc-tools-mcp",
        output: {
          output: {
            imageUrl: "https://example.com/generated.png",
            width: 1024,
            height: 1024,
          },
          outputSummary: "Image generated.",
        },
        status: "completed",
        isError: false,
        summary: "Image generated.",
      },
    ]);
  });

  it("maps stream_event content_block_start tool_use blocks", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "mcp_tool_use",
              id: "toolu_2",
              name: "mcp__aimc-tools-mcp__generate_image",
              input: {},
            },
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "toolu_2",
        name: "generate_image",
        rawName: "mcp__aimc-tools-mcp__generate_image",
        mcpServerName: "aimc-tools-mcp",
        input: {},
      },
    ]);
  });

  it("preserves MCP server identity for same-named tools from different servers", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "assistant",
          message: {
            content: [
              {
                type: "tool_use",
                id: "toolu_image_a",
                name: "mcp__server-a__generate_image",
                input: { prompt: "a" },
              },
              {
                type: "tool_use",
                id: "toolu_image_b",
                name: "mcp__server-b__generate_image",
                input: { prompt: "b" },
              },
            ],
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "toolu_image_a",
        name: "generate_image",
        rawName: "mcp__server-a__generate_image",
        mcpServerName: "server-a",
        input: { prompt: "a" },
      },
      {
        type: "tool_call",
        id: "toolu_image_b",
        name: "generate_image",
        rawName: "mcp__server-b__generate_image",
        mcpServerName: "server-b",
        input: { prompt: "b" },
      },
    ]);
  });

  it("preserves Claude API MCP connector server_name fields", async () => {
    await expect(
      collectClaudeEvents([
        {
          type: "stream_event",
          event: {
            type: "content_block_start",
            content_block: {
              type: "mcp_tool_use",
              id: "mcptoolu_1",
              name: "echo",
              server_name: "example-mcp",
              input: { value: "hello" },
            },
          },
        },
      ]),
    ).resolves.toEqual([
      {
        type: "tool_call",
        id: "mcptoolu_1",
        name: "echo",
        mcpServerName: "example-mcp",
        input: { value: "hello" },
      },
    ]);
  });
});
