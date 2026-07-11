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
        error: { message: "boom" },
      }),
    ).toEqual([
      {
        type: "error",
        code: "codex_error",
        message: "boom",
      },
    ]);
  });

  it("maps reconnect errors into transient warning statuses", () => {
    expect(
      parseCodexItem({
        type: "error",
        message: "Reconnecting... 2/5 (request timed out)",
      }),
    ).toEqual([
      {
        type: "status",
        status: "warning",
        stage: "warning",
        message: "Reconnecting... 2/5 (request timed out)",
      },
    ]);

    expect(
      parseCodexItem({
        type: "error",
        message: "Reconnecting... 5/5",
      }),
    ).toEqual([
      {
        type: "status",
        status: "warning",
        stage: "warning",
        message: "Reconnecting... 5/5",
      },
    ]);
  });

  it("maps skill budget diagnostics into transient warning statuses", () => {
    const diagnostics = [
      "Skill descriptions were shortened to fit the 2% skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
      "Skill descriptions were shortened to fit the skills context budget. Codex can still see every skill, but some descriptions are shorter. Disable unused skills or plugins to leave more room for the rest.",
      "Exceeded skills context budget. All skill descriptions were removed and Codex will continue without them.",
    ];

    for (const message of diagnostics) {
      expect(parseCodexItem({ type: "error", message })).toEqual([
        {
          type: "status",
          status: "warning",
          stage: "warning",
          message,
        },
      ]);
    }
  });

  it("keeps turn failures terminal even when their message resembles a skill diagnostic", () => {
    const message =
      "Skill descriptions were shortened to fit the 2% skills context budget.";

    expect(
      parseCodexItem({
        type: "turn.failed",
        error: { message },
      }),
    ).toEqual([
      {
        type: "error",
        code: "codex_error",
        message,
      },
    ]);
  });

  it("maps ordinary top-level errors into error events", () => {
    expect(
      parseCodexItem({
        type: "error",
        message: "fatal provider error",
      }),
    ).toEqual([
      {
        type: "error",
        code: "codex_error",
        message: "fatal provider error",
      },
    ]);
  });

  it("maps response_item compatibility envelopes", () => {
    expect(
      parseCodexItem({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Built the page." }],
        },
      }),
    ).toEqual([{ type: "text_delta", text: "Built the page." }]);

    expect(
      parseCodexItem({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "call-1",
          arguments: '{"cmd":"wc -l DESIGN.md"}',
        },
      }),
    ).toEqual([
      {
        type: "tool_call",
        id: "call-1",
        name: "exec_command",
        input: { cmd: "wc -l DESIGN.md" },
      },
    ]);

    expect(
      parseCodexItem({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "call-1",
          output: "229 DESIGN.md\n",
        },
      }),
    ).toEqual([
      {
        type: "tool_result",
        id: "call-1",
        output: "229 DESIGN.md\n",
        status: "completed",
        isError: false,
      },
    ]);
  });

  it("maps event_msg compatibility envelopes", () => {
    expect(
      parseCodexItem({
        type: "event_msg",
        payload: { type: "turn_completed" },
      }),
    ).toEqual([{ type: "done", status: "completed", reason: "completed" }]);
  });
});
