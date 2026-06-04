import type { AgentEvent } from "../../core/events.js";
import type { ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { spawnSupervisedProcess } from "../../process/supervisor.js";
import { createJsonlParser } from "./jsonl-parser.js";

export async function* runJsonlTransport<TItem>(
  plan: ProviderLaunchPlan,
  mapItem: (item: TItem) => AgentEvent[],
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const processHandle = spawnSupervisedProcess({
    ...plan,
    ...(signal ? { signal } : {}),
  });

  const queue: AgentEvent[] = [];
  let done = false;
  let transportError: unknown;

  const parser = createJsonlParser<TItem>((item) => {
    queue.push(...mapItem(item));
  });

  processHandle.child.stdout.on("data", (chunk: string) => {
    try {
      parser.feed(chunk);
    } catch (error) {
      transportError = error;
    }
  });

  void processHandle.waitForExit().then(({ code, signal, timedOut }) => {
    try {
      parser.flush();
    } catch (error) {
      transportError = error;
    }
    const canceled = signal != null;
    if (timedOut) {
      queue.push({
        type: "error",
        code: "process_timeout",
        message: `Process timed out after ${plan.timeoutMs}ms.`,
      });
      queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
    } else if (canceled) {
      queue.push({ type: "done", status: "canceled", reason: "cancelled", exitCode: code });
    } else if (transportError) {
      queue.push({
        type: "error",
        code: "jsonl_parse_failed",
        message:
          transportError instanceof Error
            ? transportError.message
            : String(transportError),
      });
      queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
    } else if (code && code !== 0) {
      const stderrTail = processHandle.stderr.tail().trim();
      queue.push({
        type: "error",
        code: "process_exit_nonzero",
        message:
          stderrTail.length > 0
            ? stderrTail
            : `Process exited with code ${code}.`,
      });
      queue.push({ type: "done", status: "failed", reason: "error", exitCode: code });
    } else {
      queue.push({
        type: "done",
        status: code === 0 ? "completed" : "failed",
        reason: code === 0 ? "completed" : "error",
        exitCode: code,
      });
    }
    done = true;
  });

  while (!done || queue.length > 0) {
    const next = queue.shift();
    if (next) {
      yield next;
      continue;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
