import { z } from "zod";

import { TuttiAgentAppRuntimeError } from "./errors.js";

const availabilityStatusSchema = z.enum([
  "ready",
  "not_installed",
  "auth_required",
  "unsupported",
  "unknown",
]);

const providerStatusSchema = z
  .object({
    provider: z.string().min(1),
    availability: z.object({
      status: availabilityStatusSchema,
      reasonCode: z.string().nullable().optional(),
    }),
    auth: z
      .object({
        status: z.enum(["authenticated", "required", "unknown"]),
      })
      .optional(),
  })
  .passthrough();

const providerStatusListSchema = z.object({
  capturedAt: z.string().nullable(),
  defaultProvider: z.string().nullable(),
  providers: z.array(providerStatusSchema),
});

const composerOptionSchema = z.object({
  id: z.string().min(1),
  value: z.string().min(1),
  label: z.string().min(1),
  description: z.string().optional(),
  supportsImageInput: z.boolean().optional(),
});

const composerConfigSchema = z.object({
  configurable: z.boolean(),
  currentValue: z.string().optional(),
  defaultValue: z.string().optional(),
  options: z.array(composerOptionSchema),
});

const composerOptionsSchema = z
  .object({
    provider: z.string().min(1),
    modelConfig: composerConfigSchema,
    reasoningConfig: composerConfigSchema,
    speedConfig: composerConfigSchema.optional(),
  })
  .passthrough();

export type TuttiAgentProviderDaemonStatus = z.infer<
  typeof providerStatusSchema
>;
export type TuttiAgentProviderStatusSnapshot = z.infer<
  typeof providerStatusListSchema
>;
export type TuttiAgentComposerConfig = z.infer<typeof composerConfigSchema>;

export interface TuttiAgentComposerOptions {
  provider: string;
  modelConfig: TuttiAgentComposerConfig;
  reasoningConfig: TuttiAgentComposerConfig;
  speedConfig?: TuttiAgentComposerConfig;
}

export interface TuttiWorkspaceAppAgentEnvironment {
  apiBaseUrl: string;
  appId: string;
  appServerToken: string;
  workspaceId: string;
}

export interface TuttiWorkspaceAppAgentClient {
  getProviderStatuses(input?: {
    includeNetwork?: boolean;
  }): Promise<TuttiAgentProviderStatusSnapshot>;
  getProviderComposerOptions(
    providerId: string,
    input?: {
      cwd?: string;
      locale?: string;
      settings?: Record<string, unknown>;
    },
  ): Promise<TuttiAgentComposerOptions>;
}

export function createTuttiWorkspaceAppAgentClient(input: {
  environment: TuttiWorkspaceAppAgentEnvironment;
  fetch?: typeof fetch;
  requestTimeoutMs?: number;
}): TuttiWorkspaceAppAgentClient {
  const fetchImplementation = input.fetch ?? globalThis.fetch;
  const requestTimeoutMs = input.requestTimeoutMs ?? 15_000;
  const baseUrl = parseBaseUrl(input.environment.apiBaseUrl);

  async function requestJson(
    path: string,
    init: RequestInit,
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeoutMs);
    try {
      const response = await fetchImplementation(new URL(path, baseUrl), {
        ...init,
        headers: {
          Authorization: `Bearer ${input.environment.appServerToken}`,
          Accept: "application/json",
          ...(init.body === undefined ? {} : { "Content-Type": "application/json" }),
          ...(init.headers ?? {}),
        },
        signal: controller.signal,
      });
      if (!response.ok) {
        throw new TuttiAgentAppRuntimeError(
          "tutti_catalog_request_failed",
          `Tutti workspace-app agent request failed with status ${response.status}.`,
          { status: response.status },
        );
      }
      return await response.json();
    } catch (error) {
      if (error instanceof TuttiAgentAppRuntimeError) throw error;
      throw new TuttiAgentAppRuntimeError(
        "tutti_catalog_request_failed",
        "Tutti workspace-app agent request failed.",
        { cause: error },
      );
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async getProviderStatuses(options = {}) {
      const url = new URL(workspaceAppPath(input.environment, "/agent-providers/status"), baseUrl);
      if (options.includeNetwork !== undefined) {
        url.searchParams.set("includeNetwork", String(options.includeNetwork));
      }
      const payload = await requestJson(url.pathname + url.search, {
        method: "GET",
      });
      return parseResponse(providerStatusListSchema, payload);
    },

    async getProviderComposerOptions(providerId, options = {}) {
      const payload = await requestJson(
        workspaceAppPath(
          input.environment,
          `/agent-providers/${encodeURIComponent(providerId)}/composer-options`,
        ),
        {
          method: "POST",
          body: JSON.stringify({
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.locale ? { locale: options.locale } : {}),
            ...(options.settings ? { settings: options.settings } : {}),
          }),
        },
      );
      const parsed = parseResponse(composerOptionsSchema, payload);
      return {
        provider: parsed.provider,
        modelConfig: parsed.modelConfig,
        reasoningConfig: parsed.reasoningConfig,
        ...(parsed.speedConfig ? { speedConfig: parsed.speedConfig } : {}),
      };
    },
  };
}

function parseBaseUrl(value: string) {
  try {
    return new URL(value);
  } catch (error) {
    throw new TuttiAgentAppRuntimeError(
      "invalid_tutti_api_base_url",
      "TUTTI_API_BASE_URL must be a valid absolute URL.",
      { cause: error },
    );
  }
}

function workspaceAppPath(
  environment: TuttiWorkspaceAppAgentEnvironment,
  suffix: string,
) {
  const normalizedSuffix = suffix.startsWith("/") ? suffix : `/${suffix}`;
  return `/v1/workspaces/${encodeURIComponent(environment.workspaceId)}/apps/${encodeURIComponent(environment.appId)}${normalizedSuffix}`;
}

function parseResponse<TSchema extends z.ZodType>(
  schema: TSchema,
  payload: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(payload);
  if (result.success) return result.data;
  throw new TuttiAgentAppRuntimeError(
    "tutti_catalog_response_invalid",
    "Tutti workspace-app agent response did not match the expected contract.",
    { cause: result.error },
  );
}
