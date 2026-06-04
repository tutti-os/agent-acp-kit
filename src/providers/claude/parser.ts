import type { AgentEvent } from "../../core/events.js";

export function parseClaudeStreamEvent(
  item: Record<string, unknown>,
): AgentEvent[] {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "assistant" && typeof item.text === "string") {
    return [{ type: "text_delta", text: item.text }];
  }
  if (type === "thinking" && typeof item.text === "string") {
    return [{ type: "thinking", text: item.text }];
  }
  if (type === "tool_use") {
    return [
      {
        type: "tool_call",
        id: String(item.id ?? ""),
        name: String(item.name ?? "tool"),
        input: item.input,
      },
    ];
  }
  if (type === "tool_result") {
    return [
      {
        type: "tool_result",
        id: String(item.id ?? ""),
        name: String(item.name ?? "tool"),
        output: item.output,
        status: "completed",
      },
    ];
  }
  if (type === "error") {
    return [
      {
        type: "error",
        code: "claude_error",
        message: String(item.message ?? "Claude run failed"),
      },
    ];
  }
  return [];
}
