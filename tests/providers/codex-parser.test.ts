import { describe, expect, it } from "vitest";

import { parseCodexItem } from "../../src/providers/codex/parser.js";

describe("parseCodexItem", () => {
  it("maps agent message envelopes to text deltas", () => {
    expect(
      parseCodexItem({
        type: "item.completed",
        item: {
          id: "msg-1",
          type: "agent_message",
          text: "hello world",
        },
      }),
    ).toEqual([{ type: "text_delta", text: "hello world" }]);
  });

  it("maps command execution start and completion into Bash tool lifecycle events", () => {
    expect(
      parseCodexItem({
        type: "item.started",
        item: {
          id: "bash-1",
          type: "command_execution",
          status: "in_progress",
          command: "ls -la",
        },
      }),
    ).toEqual([
      {
        type: "tool_call",
        id: "bash-1",
        name: "Bash",
        input: { command: "ls -la" },
      },
    ]);

    expect(
      parseCodexItem({
        type: "item.completed",
        item: {
          id: "bash-1",
          type: "command_execution",
          status: "completed",
          aggregated_output: "done",
          exit_code: 0,
        },
      }),
    ).toEqual([
      {
        type: "tool_result",
        id: "bash-1",
        name: "Bash",
        output: { output: "done" },
        status: "completed",
        summary: "done",
        isError: false,
      },
    ]);
  });

  it("maps MCP tool calls and normalizes tool aliases", () => {
    expect(
      parseCodexItem({
        type: "item.started",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          tool: "image_generate",
          status: "in_progress",
          arguments: { prompt: "poster" },
        },
      }),
    ).toEqual([
      {
        type: "tool_call",
        id: "tool-1",
        name: "generate_image",
        input: { prompt: "poster" },
      },
    ]);

    expect(
      parseCodexItem({
        type: "item.completed",
        item: {
          id: "tool-1",
          type: "mcp_tool_call",
          tool: "image_generate",
          status: "completed",
          result: {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  output: {
                    imageUrl: "https://example.com/image.png",
                  },
                  outputSummary: "generated",
                }),
              },
            ],
          },
        },
      }),
    ).toEqual([
      {
        type: "tool_result",
        id: "tool-1",
        name: "generate_image",
        output: {
          imageUrl: "https://example.com/image.png",
        },
        status: "completed",
        summary: "generated",
        isError: false,
      },
    ]);
  });

  it("maps turn failures into error events", () => {
    expect(
      parseCodexItem({
        type: "turn.failed",
        message: "boom",
      }),
    ).toEqual([
      {
        type: "error",
        code: "codex_error",
        message: "boom",
      },
    ]);
  });
});
