import type { AgentEvent } from "../../core/events.js";

type CodexEnvelope = {
  error?: { data?: Record<string, unknown>; message?: string } | null;
  item?: CodexItem;
  message?: string;
  payload?: Record<string, unknown> | null;
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

function isReconnectMessage(message: string) {
  return /^Reconnecting\.\.\.\s+\d+\/\d+(?:\s+\([^)]+\))?$/.test(message);
}

function isSkillBudgetDiagnostic(message: string) {
  return /^(?:Skill descriptions were shortened to fit (?:the )?(?:\d+% )?skills context budget\.|Exceeded skills context budget\. All skill descriptions were removed and\b)/.test(
    message,
  );
}

function isTransientWarningMessage(message: string) {
  return isReconnectMessage(message) || isSkillBudgetDiagnostic(message);
}

function statusWarning(message: string): AgentEvent {
  return {
    type: "status",
    status: "warning",
    stage: "warning",
    message,
  };
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

function parseJsonValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function readContentText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) {
    return value;
  }
  if (!Array.isArray(value)) {
    return undefined;
  }
  const text = value
    .map((entry) => {
      const record = toRecord(entry);
      return typeof record?.text === "string" ? record.text : "";
    })
    .filter(Boolean)
    .join("\n");
  return text.trim() ? text : undefined;
}

function parseResponseItem(payload: Record<string, unknown>): AgentEvent[] {
  const type = typeof payload.type === "string" ? payload.type : "";
  if (type === "message" || type === "agent_message") {
    const text =
      typeof payload.text === "string" ? payload.text : readContentText(payload.content);
    return text && payload.role !== "user" ? [{ type: "text_delta", text }] : [];
  }

  if (type === "reasoning") {
    const text = readContentText(payload.summary) ??
      (typeof payload.text === "string" ? payload.text : undefined);
    return text ? [{ type: "thinking_delta", text }] : [];
  }

  if (type === "function_call" || type === "tool_call") {
    const id =
      typeof payload.call_id === "string" ? payload.call_id :
      typeof payload.id === "string" ? payload.id : undefined;
    const name =
      typeof payload.name === "string" ? payload.name :
      typeof payload.tool === "string" ? payload.tool : "unknown_tool";
    return id ? [{
      type: "tool_call",
      id,
      name: normalizeToolName(name),
      input: parseJsonValue(payload.arguments ?? payload.input),
    }] : [];
  }

  if (type === "function_call_output" || type === "tool_result") {
    const id =
      typeof payload.call_id === "string" ? payload.call_id :
      typeof payload.id === "string" ? payload.id : undefined;
    if (!id) return [];
    const error = toRecord(payload.error);
    const isError = payload.is_error === true || payload.isError === true || Boolean(error);
    const summary =
      typeof payload.message === "string" ? payload.message :
      typeof error?.message === "string" ? error.message : undefined;
    return [{
      type: "tool_result",
      id,
      ...(payload.output !== undefined || payload.result !== undefined ?
        { output: payload.output ?? payload.result }
      : {}),
      ...(summary ? { summary } : {}),
      status: isError ? "failed" : "completed",
      isError,
    }];
  }

  return parseItem(payload as CodexItem);
}

function parseEventMessage(payload: Record<string, unknown>): AgentEvent[] {
  if (payload.type === "turn_completed" || payload.type === "turn_complete") {
    return [{ type: "done", status: "completed", reason: "completed" }];
  }
  if (payload.type === "turn_failed") {
    return [{
      type: "error",
      code: "codex_error",
      message: typeof payload.message === "string" ? payload.message : "Codex turn failed",
    }];
  }
  return [];
}

export function parseCodexItem(item: CodexEnvelope | CodexItem): AgentEvent[] {
  if (
    "item" in item ||
    item.type === "item.started" ||
    item.type === "item.completed" ||
    item.type === "turn.failed" ||
    item.type === "error" ||
    item.type === "response_item" ||
    item.type === "event_msg"
  ) {
    const envelope = item as CodexEnvelope;

    if (envelope.type === "turn.failed" || envelope.type === "error") {
      const message =
        envelope.error?.message ?? envelope.message ?? "Codex turn failed";
      if (envelope.type === "error" && isTransientWarningMessage(message)) {
        return [statusWarning(message)];
      }
      return [
        {
          type: "error",
          code: "codex_error",
          message,
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

    if (envelope.type === "response_item" && envelope.payload) {
      return parseResponseItem(envelope.payload);
    }

    if (envelope.type === "event_msg" && envelope.payload) {
      return parseEventMessage(envelope.payload);
    }

    return [];
  }

  return parseItem(item);
}
