import type { AgentEvent } from "../../core/events.js";

type CodexEnvelope = {
  item?: CodexItem;
  message?: string;
  type?: string;
};

type CodexItem = {
  aggregated_output?: string;
  arguments?: Record<string, unknown>;
  command?: string;
  error?: { data?: Record<string, unknown>; message?: string } | null;
  exit_code?: number | null;
  id?: string;
  message?: string;
  result?: {
    content?: Array<{ text?: string; type?: string }>;
    structured_content?: Record<string, unknown> | null;
  } | null;
  status?: string;
  text?: string;
  tool?: string;
  type?: string;
};

function normalizeToolName(name: string) {
  if (name === "image_generate") return "generate_image";
  if (name === "video_generate") return "generate_video";
  return name;
}

function toRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function extractToolPayload(item: CodexItem): Record<string, unknown> | undefined {
  const structured = item.result?.structured_content;
  if (structured && typeof structured === "object" && !Array.isArray(structured)) {
    return structured;
  }

  const firstText = item.result?.content?.find(
    (entry) => entry.type === "text" && typeof entry.text === "string",
  )?.text;
  if (!firstText) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(firstText);
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    return { raw: firstText };
  }

  return undefined;
}

function parseCommandExecution(item: CodexItem): AgentEvent[] {
  if (!item.id) {
    return [];
  }

  const command = item.command ?? "";
  if (item.status === "in_progress") {
    return [
      {
        type: "tool_call",
        id: item.id,
        name: "Bash",
        input: { command },
      },
    ];
  }

  const summary =
    typeof item.aggregated_output === "string" && item.aggregated_output.length > 0
      ? item.aggregated_output
      : item.error?.message;
  const output =
    typeof item.aggregated_output === "string" && item.aggregated_output.length > 0
      ? { output: item.aggregated_output }
      : undefined;

  return [
    {
      type: "tool_result",
      id: item.id,
      name: "Bash",
      ...(output ? { output } : {}),
      ...(summary ? { summary } : {}),
      status:
        typeof item.exit_code === "number" && item.exit_code !== 0
          ? "failed"
          : "completed",
      isError: typeof item.exit_code === "number" && item.exit_code !== 0,
    },
  ];
}

function parseMcpToolCall(item: CodexItem): AgentEvent[] {
  if (!item.id) {
    return [];
  }

  const toolName = normalizeToolName(item.tool ?? "unknown_tool");
  if (item.status === "in_progress") {
    return [
      {
        type: "tool_call",
        id: item.id,
        name: toolName,
        ...(item.arguments ? { input: item.arguments } : {}),
      },
    ];
  }

  const payload = extractToolPayload(item);
  const payloadOutput =
    payload && typeof payload.output === "object" && payload.output && !Array.isArray(payload.output)
      ? (payload.output as Record<string, unknown>)
      : payload;
  const summary =
    item.error?.message ??
    (typeof payload?.outputSummary === "string" ? payload.outputSummary : item.message);

  return [
    {
      type: "tool_result",
      id: item.id,
      name: toolName,
      ...(payloadOutput ? { output: payloadOutput } : {}),
      ...(summary ? { summary } : {}),
      status: item.status === "failed" || Boolean(item.error) ? "failed" : "completed",
      isError: item.status === "failed" || Boolean(item.error),
    },
  ];
}

function parseItem(item: CodexItem): AgentEvent[] {
  if (!item.type) {
    return [];
  }

  if (item.type === "agent_message" && item.text) {
    return [{ type: "text_delta", text: item.text }];
  }

  if (item.type === "reasoning" && item.text) {
    return [{ type: "thinking", text: item.text }];
  }

  if (item.type === "message" && item.text) {
    return [{ type: "text_delta", text: item.text }];
  }

  if (item.type === "tool_call" && item.id && item.tool) {
    return [
      {
        type: "tool_call",
        id: item.id,
        name: normalizeToolName(item.tool),
        input: item.arguments,
      },
    ];
  }

  if (item.type === "tool_result" && item.id) {
    const output =
      item.result?.structured_content ??
      item.result?.content ??
      item.aggregated_output;
    const summary = item.message ?? item.error?.message;
    return [
      {
        type: "tool_result",
        id: item.id,
        name: normalizeToolName(item.tool ?? "unknown_tool"),
        ...(output === undefined ? {} : { output }),
        ...(summary === undefined ? {} : { summary }),
        status: Boolean(item.error) ? "failed" : "completed",
        isError: Boolean(item.error),
      },
    ];
  }

  if (item.type === "command_execution") {
    return parseCommandExecution(item);
  }

  if (item.type === "mcp_tool_call") {
    return parseMcpToolCall(item);
  }

  if (item.type === "error") {
    const data = toRecord(item.error?.data);
    return [
      {
        type: "error",
        code:
          typeof data?.code === "string" ? data.code : "codex_error",
        message: item.error?.message ?? item.message ?? "Codex run failed",
      },
    ];
  }

  return [];
}

export function parseCodexItem(item: CodexEnvelope | CodexItem): AgentEvent[] {
  if (
    "item" in item ||
    item.type === "item.started" ||
    item.type === "item.completed" ||
    item.type === "turn.failed" ||
    item.type === "error"
  ) {
    const envelope = item as CodexEnvelope;

    if (envelope.type === "turn.failed" || envelope.type === "error") {
      return [
        {
          type: "error",
          code: "codex_error",
          message: envelope.message ?? "Codex turn failed",
        },
      ];
    }

    if (
      (envelope.type === "item.started" || envelope.type === "item.completed") &&
      envelope.item
    ) {
      if (envelope.type === "item.completed" && envelope.item.type === "error") {
        return [];
      }
      return parseItem(envelope.item);
    }

    return [];
  }

  return parseItem(item);
}
