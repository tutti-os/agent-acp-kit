export type AgentEvent =
  | {
      type: "status";
      status?: "initializing" | "detecting" | "spawning" | "running" | "warning";
      stage?: "detecting" | "spawning" | "running" | "warning";
      message?: string;
    }
  | { type: "thinking"; text: string }
  | { type: "thinking_delta"; text: string }
  | { type: "text_delta"; text: string }
  | {
      type: "tool_call";
      id: string;
      name: string;
      input?: unknown;
      rawName?: string;
      mcpServerName?: string;
    }
  | {
      type: "tool_result";
      id: string;
      name?: string;
      rawName?: string;
      mcpServerName?: string;
      status?: "completed" | "failed";
      output?: unknown;
      summary?: string;
      error?: string;
      isError?: boolean;
    }
  | { type: "usage"; usage: unknown }
  | { type: "file_write"; path: string }
  | { type: "stderr"; text: string }
  | { type: "error"; code: string; message: string; retryable?: boolean }
  | {
      type: "done";
      status?: "completed" | "failed" | "canceled";
      reason?: "completed" | "cancelled" | "error";
      exitCode?: number | null;
      sessionId?: string;
      resumeToken?: string;
    };
