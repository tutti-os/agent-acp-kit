import type { AgentEvent } from "../../core/events.js";
import type { AgentRunParams, ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { spawnSupervisedProcess } from "../../process/supervisor.js";
import { createJsonRpcLineParser, sendJsonRpc } from "./acp-jsonrpc.js";
import { choosePermissionOutcome } from "./acp-permissions.js";
import { buildAcpSessionNewParams } from "./acp-session.js";

function pushSessionUpdateEvents(queue: AgentEvent[], params: unknown) {
  const payload = (params ?? {}) as Record<string, unknown>;
  const update = ((payload.update ?? payload.event ?? payload) ?? {}) as Record<
    string,
    unknown
  >;
  const kind = String(
    update.sessionUpdate ?? update.type ?? update.kind ?? update.status ?? "",
  );

  const content =
    update.content && typeof update.content === "object"
      ? (update.content as Record<string, unknown>)
      : undefined;
  const text =
    typeof update.text === "string"
      ? update.text
      : typeof update.delta === "string"
        ? update.delta
        : typeof update.content === "string"
          ? update.content
          : typeof content?.text === "string"
            ? content.text
            : undefined;
  if (text && /reason|thinking/i.test(kind)) {
    queue.push({ type: "thinking_delta", text });
    return;
  }
  if (text && (/text|message|delta|content/i.test(kind) || !kind)) {
    queue.push({ type: "text_delta", text });
    return;
  }

  const toolCall =
    (update.toolCall ?? update.tool_call ?? update.call) as
      | Record<string, unknown>
      | undefined;
  if (toolCall || /tool.*(call|start)|call.*start/i.test(kind)) {
    const source = toolCall ?? update;
    queue.push({
      type: "tool_call",
      id: String(source.id ?? source.toolCallId ?? source.callId ?? "tool"),
      name: String(source.name ?? source.toolName ?? "tool"),
      ...(typeof source.rawName === "string" ? { rawName: source.rawName } : {}),
      ...(typeof source.mcpServerName === "string"
        ? { mcpServerName: source.mcpServerName }
        : {}),
      ...(source.input !== undefined ? { input: source.input } : {}),
    });
    return;
  }

  const toolResult =
    (update.toolResult ?? update.tool_result ?? update.result) as
      | Record<string, unknown>
      | undefined;
  if (toolResult || /tool.*(result|complete|failed)|call.*(complete|failed)/i.test(kind)) {
    const source = toolResult ?? update;
    const isFailed =
      source.status === "failed" ||
      source.isError === true ||
      source.error !== undefined ||
      /failed|error/i.test(kind);
    queue.push({
      type: "tool_result",
      id: String(source.id ?? source.toolCallId ?? source.callId ?? "tool"),
      ...(source.name ?? source.toolName
        ? { name: String(source.name ?? source.toolName) }
        : {}),
      ...(typeof source.rawName === "string" ? { rawName: source.rawName } : {}),
      ...(typeof source.mcpServerName === "string"
        ? { mcpServerName: source.mcpServerName }
        : {}),
      status: isFailed ? "failed" : "completed",
      ...(source.output !== undefined ? { output: source.output } : {}),
      ...(source.error !== undefined ? { error: String(source.error) } : {}),
    });
    return;
  }

  if (update.usage !== undefined || /usage/i.test(kind)) {
    queue.push({ type: "usage", usage: update.usage ?? update });
    return;
  }

  if (/done|complete|finished|cancel|fail|error/i.test(kind)) {
    const status =
      /cancel/i.test(kind)
        ? "canceled"
        : /fail|error/i.test(kind)
          ? "failed"
          : "completed";
    queue.push({
      type: "done",
      status,
      reason:
        status === "canceled"
          ? "cancelled"
          : status === "failed"
            ? "error"
            : "completed",
      ...(typeof update.sessionId === "string" ? { sessionId: update.sessionId } : {}),
      ...(typeof update.resumeToken === "string"
        ? { resumeToken: update.resumeToken }
        : {}),
    });
  }
}

export async function* runAcpTransport(
  plan: ProviderLaunchPlan,
  params: AgentRunParams,
): AsyncGenerator<AgentEvent> {
  const processHandle = spawnSupervisedProcess({
    ...plan,
    keepStdinOpen: true,
    ...(params.signal ? { signal: params.signal } : {}),
  });
  const queue: AgentEvent[] = [];
  let done = false;
  let fatalError = false;
  let nextId = 1;
  let sessionId: string | undefined;
  let resumeToken: string | undefined;
  let lifecycleCompleted = false;
  let lifecycleSettled = false;
  const pending = new Map<
    number,
    {
      reject: (error: Error) => void;
      resolve: (result: unknown) => void;
      timer: NodeJS.Timeout;
    }
  >();

  function resolvePending(message: {
    id?: number | string;
    result?: unknown;
    error?: { code?: number; message?: string };
  }) {
    if (message.id === undefined) return false;
    const id =
      typeof message.id === "number"
        ? message.id
        : Number.parseInt(String(message.id), 10);
    const request = pending.get(id);
    if (!request) return false;
    pending.delete(id);
    clearTimeout(request.timer);
    if (message.error) {
      request.reject(
        new Error(message.error.message ?? `ACP request ${id} failed.`),
      );
    } else {
      request.resolve(message.result);
    }
    return true;
  }

  function failPending(error: Error) {
    for (const [id, request] of pending) {
      pending.delete(id);
      clearTimeout(request.timer);
      request.reject(error);
    }
  }

  function sendRequest(method: string, requestParams?: unknown) {
    const id = nextId++;
    const timeoutMs = params.timeoutMs ?? plan.timeoutMs ?? 15_000;
    const promise = new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`ACP ${method} timed out after ${timeoutMs}ms.`));
      }, timeoutMs);
      pending.set(id, { reject, resolve, timer });
    });
    sendJsonRpc(processHandle.child.stdin, {
      jsonrpc: "2.0",
      id,
      method,
      ...(requestParams !== undefined ? { params: requestParams } : {}),
    });
    return promise;
  }

  function captureSessionMetadata(result: unknown) {
    if (!result || typeof result !== "object") return;
    const record = result as Record<string, unknown>;
    const candidateSessionId = record.sessionId ?? record.session_id ?? record.id;
    if (typeof candidateSessionId === "string") {
      sessionId = candidateSessionId;
    }
    const candidateResumeToken = record.resumeToken ?? record.resume_token;
    if (typeof candidateResumeToken === "string") {
      resumeToken = candidateResumeToken;
    }
  }

  const parser = createJsonRpcLineParser((message) => {
    if (resolvePending(message)) {
      return;
    }

    if (message.error) {
      fatalError = true;
      queue.push({
        type: "error",
        code: String(message.error.code ?? "acp_error"),
        message: message.error.message ?? "ACP error",
      });
      return;
    }

    if (message.method === "session/request_permission") {
      const params = (message.params ?? {}) as {
        options?: Array<{ kind?: string; optionId?: string }>;
      };
      if (message.id !== undefined) {
        const options = params.options ?? [];
        const selectedOptionId =
          choosePermissionOutcome(options) ??
          options.find((option) => typeof option.optionId === "string")
            ?.optionId;
        sendJsonRpc(processHandle.child.stdin, {
          jsonrpc: "2.0",
          id: message.id,
          result: {
            outcome: selectedOptionId
              ? { outcome: "selected", optionId: selectedOptionId }
              : { outcome: "cancelled" },
          },
        });
      }
      return;
    }

    if (message.method === "message/stream") {
      const payload = (message.params ?? {}) as { delta?: string };
      if (payload.delta) {
        queue.push({ type: "text_delta", text: payload.delta });
      }
      return;
    }

    if (message.method === "session/update") {
      pushSessionUpdateEvents(queue, message.params);
      return;
    }
  });

  processHandle.child.stdout.on("data", (chunk: string) => {
    try {
      parser.feed(chunk);
    } catch (error) {
      fatalError = true;
      const message =
        error instanceof Error ? error.message : "Invalid ACP JSON-RPC output.";
      queue.push({
        type: "error",
        code: "acp_parse_error",
        message,
      });
      failPending(new Error(message));
      processHandle.child.kill();
    }
  });
  processHandle.child.stderr.on("data", (chunk: string) => {
    queue.push({ type: "stderr", text: processHandle.stderr.redact(chunk) });
  });

  const waitForExit = processHandle.waitForExit().then(({ code, signal, timedOut }) => {
    if (pending.size > 0) {
      failPending(
        new Error(
          code && code !== 0
            ? `ACP process exited with code ${code} before lifecycle completed.`
            : "ACP process exited before lifecycle completed.",
        ),
      );
    }

    if (timedOut) {
      queue.push({
        type: "error",
        code: "process_timeout",
        message: `ACP process timed out after ${plan.timeoutMs}ms.`,
      });
    } else if (code && code !== 0) {
      const stderrTail = processHandle.stderr.tail().trim();
      queue.push({
        type: "error",
        code: "process_exit_nonzero",
        message:
          stderrTail.length > 0
            ? stderrTail
            : `ACP process exited with code ${code}.`,
      });
    }
    const failed = fatalError || timedOut || (code != null && code !== 0);
    const canceled = signal != null && !failed && !lifecycleCompleted;
    queue.push({
      type: "done",
      status: canceled ? "canceled" : failed ? "failed" : "completed",
      reason: canceled ? "cancelled" : failed ? "error" : "completed",
      exitCode: code,
      ...(sessionId ? { sessionId } : {}),
      ...(resumeToken ? { resumeToken } : {}),
    });
    done = true;
  });

  const runLifecycle = async () => {
    try {
      await sendRequest("initialize", {
        clientInfo: { name: "agent-acp-kit", version: "0.0.0" },
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
          _meta: { terminal_output: true },
        },
      });
      const newSessionResult = await sendRequest(
        "session/new",
        buildAcpSessionNewParams(
          params.cwd,
          params.mcpServers || params.resume
            ? {
                ...(params.mcpServers ? { mcpServers: params.mcpServers } : {}),
                ...(params.resume ? { resume: params.resume } : {}),
              }
            : undefined,
        ),
      );
      captureSessionMetadata(newSessionResult);
      if (params.model && sessionId) {
        try {
          await sendRequest("session/set_config_option", {
            sessionId,
            configId: "model",
            value: params.model,
          });
        } catch {
          await sendRequest("session/set_model", {
            sessionId,
            modelId: params.model,
          });
        }
      }
      await sendRequest("session/prompt", {
        ...(sessionId ? { sessionId } : {}),
        prompt: [{ type: "text", text: params.prompt }],
      });
      lifecycleCompleted = true;
      processHandle.child.stdin.end();
    } catch (error) {
      fatalError = true;
      queue.push({
        type: "error",
        code: "acp_lifecycle_failed",
        message: error instanceof Error ? error.message : "ACP lifecycle failed.",
      });
      processHandle.child.kill();
    } finally {
      lifecycleSettled = true;
    }
  };
  void runLifecycle();

  while (!done || !lifecycleSettled || queue.length > 0) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }

  await waitForExit.catch(() => undefined);
}
