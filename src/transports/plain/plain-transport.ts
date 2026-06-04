import type { AgentEvent } from "../../core/events.js";
import type { ProviderLaunchPlan } from "../../core/provider-plugin.js";
import { spawnSupervisedProcess } from "../../process/supervisor.js";

export async function* runPlainTransport(
  plan: ProviderLaunchPlan,
  signal?: AbortSignal,
): AsyncGenerator<AgentEvent> {
  const processHandle = spawnSupervisedProcess({
    ...plan,
    ...(signal ? { signal } : {}),
  });
  const queue: AgentEvent[] = [];
  let done = false;

  processHandle.child.stdout.on("data", (chunk: string) => {
    queue.push({ type: "text_delta", text: chunk });
  });

  processHandle.child.stderr.on("data", (chunk: string) => {
    queue.push({ type: "stderr", text: processHandle.stderr.redact(chunk) });
  });

  void processHandle.waitForExit().then(({ code, signal, timedOut }) => {
    if (timedOut) {
      queue.push({
        type: "error",
        code: "process_timeout",
        message: `Process timed out after ${plan.timeoutMs}ms.`,
      });
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
    }
    const canceled = signal != null;
    const failed = timedOut || (code != null && code !== 0);
    queue.push({
      type: "done",
      status: canceled ? "canceled" : failed ? "failed" : "completed",
      reason: canceled ? "cancelled" : failed ? "error" : "completed",
      exitCode: code,
    });
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
