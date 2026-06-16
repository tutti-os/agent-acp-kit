import type { AgentEvent } from "../../core/events.js";

type ClaudeParserState = {
  toolNamesById: Map<string, string>;
};

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function normalizeClaudeToolName(name: string) {
  if (!name.startsWith("mcp__")) return name;
  const parts = name.split("__");
  if (parts.length < 3) return name;
  return parts.slice(2).join("__") || name;
}

function isToolUseBlock(block: Record<string, unknown>) {
  return (
    block.type === "tool_use" ||
    block.type === "mcp_tool_use" ||
    block.type === "server_tool_use"
  );
}

function getContentBlocks(item: Record<string, unknown>) {
  const message = toRecord(item.message);
  const content = Array.isArray(message?.content)
    ? message.content
    : Array.isArray(item.content)
      ? item.content
      : undefined;
  return content
    ?.map((block) => toRecord(block))
    .filter((block): block is Record<string, unknown> => Boolean(block));
}

function parseTextContent(content: unknown): unknown {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content;
  const text = content
    .map((part) => toRecord(part))
    .filter((part): part is Record<string, unknown> => Boolean(part))
    .filter((part) => part.type === "text" && typeof part.text === "string")
    .map((part) => part.text as string)
    .join("");
  if (!text) return content;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

function toolCallFromBlock(
  block: Record<string, unknown>,
  state: ClaudeParserState,
): AgentEvent | undefined {
  if (!isToolUseBlock(block)) return undefined;
  const id = String(block.id ?? "");
  const name = normalizeClaudeToolName(String(block.name ?? "tool"));
  if (id) state.toolNamesById.set(id, name);
  return {
    type: "tool_call",
    id,
    name,
    ...(block.input !== undefined ? { input: block.input } : {}),
  };
}

function toolResultFromBlock(
  block: Record<string, unknown>,
  state: ClaudeParserState,
): AgentEvent | undefined {
  if (block.type !== "tool_result") return undefined;
  const id = String(block.tool_use_id ?? block.id ?? "");
  const output = parseTextContent(block.content ?? block.output);
  const outputRecord = toRecord(output);
  const isError = block.is_error === true || block.isError === true;
  return {
    type: "tool_result",
    id,
    ...(state.toolNamesById.get(id)
      ? { name: state.toolNamesById.get(id) }
      : {}),
    output,
    status: isError ? "failed" : "completed",
    isError,
    ...(typeof outputRecord?.outputSummary === "string"
      ? { summary: outputRecord.outputSummary }
      : typeof outputRecord?.summary === "string"
        ? { summary: outputRecord.summary }
        : {}),
  };
}

function mapCompleteMessage(
  item: Record<string, unknown>,
  state: ClaudeParserState,
): AgentEvent[] {
  const blocks = getContentBlocks(item);
  if (!blocks) return [];

  const events: AgentEvent[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "text_delta", text: block.text });
      continue;
    }
    const toolCall = toolCallFromBlock(block, state);
    if (toolCall) {
      events.push(toolCall);
      continue;
    }
    const toolResult = toolResultFromBlock(block, state);
    if (toolResult) {
      events.push(toolResult);
    }
  }
  return events;
}

function mapStreamEvent(
  item: Record<string, unknown>,
  state: ClaudeParserState,
): AgentEvent[] {
  const event = toRecord(item.event);
  if (!event) return [];
  if (event.type === "content_block_start") {
    const block = toRecord(event.content_block);
    const toolCall = block ? toolCallFromBlock(block, state) : undefined;
    return toolCall ? [toolCall] : [];
  }
  if (event.type === "content_block_delta") {
    const delta = toRecord(event.delta);
    if (delta?.type === "text_delta" && typeof delta.text === "string") {
      return [{ type: "text_delta", text: delta.text }];
    }
  }
  return [];
}

export function createClaudeEventMapper() {
  const state: ClaudeParserState = {
    toolNamesById: new Map(),
  };

  return (item: Record<string, unknown>): AgentEvent[] => {
    const type = typeof item.type === "string" ? item.type : "";
    if (
      type === "done" ||
      type === "error" ||
      type === "status" ||
      type === "text_delta" ||
      type === "thinking_delta"
    ) {
      return [item as AgentEvent];
    }
    if (type === "tool_call") {
      const event = {
        ...(item as Extract<AgentEvent, { type: "tool_call" }>),
        name: normalizeClaudeToolName(String(item.name ?? "tool")),
      };
      if (event.id) state.toolNamesById.set(event.id, event.name);
      return [event];
    }
    if (type === "tool_result") {
      const id = String(item.id ?? "");
      return [
        {
          ...(item as Extract<AgentEvent, { type: "tool_result" }>),
          ...(item.name
            ? { name: normalizeClaudeToolName(String(item.name)) }
            : state.toolNamesById.get(id)
              ? { name: state.toolNamesById.get(id) }
              : {}),
        },
      ];
    }
    if (type === "stream_event") {
      return mapStreamEvent(item, state);
    }
    if (type === "assistant" || type === "user") {
      return mapCompleteMessage(item, state);
    }
    return parseClaudeStreamEvent(item, state);
  };
}

export function parseClaudeStreamEvent(
  item: Record<string, unknown>,
  state: ClaudeParserState = { toolNamesById: new Map() },
): AgentEvent[] {
  const type = typeof item.type === "string" ? item.type : "";
  if (type === "assistant" && typeof item.text === "string") {
    return [{ type: "text_delta", text: item.text }];
  }
  if (type === "thinking" && typeof item.text === "string") {
    return [{ type: "thinking", text: item.text }];
  }
  if (type === "tool_use") {
    const toolCall = toolCallFromBlock(item, state);
    return toolCall ? [toolCall] : [];
  }
  if (type === "tool_result") {
    return [
      {
        type: "tool_result",
        id: String(item.id ?? ""),
        name: normalizeClaudeToolName(String(item.name ?? "tool")),
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
