export type LocalAgentRuntimeErrorCode =
  | "runtime_offline"
  | "runtime_capacity_exceeded"
  | "runtime_not_registered"
  | "provider_protocol_error";

export class LocalAgentRuntimeError extends Error {
  constructor(
    readonly code: LocalAgentRuntimeErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalAgentRuntimeError";
  }
}
