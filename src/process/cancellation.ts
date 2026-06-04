import type { ChildProcessWithoutNullStreams } from "node:child_process";

export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

export function createAbortError(message = "Operation aborted") {
  const error = new Error(message);
  error.name = "AbortError";
  return error;
}

export function attachAbortSignal(
  child: ChildProcessWithoutNullStreams,
  signal?: AbortSignal,
  options?: { killAfterMs?: number },
) {
  if (!signal) {
    return () => {};
  }
  let killFallback: NodeJS.Timeout | undefined;

  const abort = () => {
    if (!child.killed) {
      child.kill("SIGTERM");
      killFallback = setTimeout(() => {
        if (!child.killed) {
          child.kill("SIGKILL");
        }
      }, options?.killAfterMs ?? 2_000);
    }
  };

  if (signal.aborted) {
    abort();
    return () => {};
  }

  signal.addEventListener("abort", abort, { once: true });
  return () => {
    signal.removeEventListener("abort", abort);
    if (killFallback) {
      clearTimeout(killFallback);
    }
  };
}
