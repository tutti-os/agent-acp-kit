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
        input: { prompt: "agent poster", model: "codex/gpt-image-2" },
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
        input: { prompt: "agent poster" },
      },
      {
        type: "tool_result",
        id: "toolu_1",
        name: "generate_image",
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
        input: {},
      },
    ]);
  });
});
