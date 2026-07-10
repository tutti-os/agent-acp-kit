export type TuttiAgentAppRuntimeErrorCode =
  | "incomplete_tutti_app_environment"
  | "invalid_tutti_api_base_url"
  | "tutti_catalog_request_failed"
  | "tutti_catalog_response_invalid"
  | "provider_runtime_unavailable"
  | "managed_provider_unsupported"
  | "tutti_run_context_failed"
  | "local_cwd_required"
  | "prepared_run_already_started";

export class TuttiAgentAppRuntimeError extends Error {
  readonly code: TuttiAgentAppRuntimeErrorCode;
  readonly status?: number;

  constructor(
    code: TuttiAgentAppRuntimeErrorCode,
    message: string,
    options: { cause?: unknown; status?: number } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "TuttiAgentAppRuntimeError";
    this.code = code;
    this.status = options.status;
  }
}
