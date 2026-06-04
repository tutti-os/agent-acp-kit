# @nextop-os/agent-acp-kit

`@nextop-os/agent-acp-kit` is an ACP-oriented host-side SDK for detecting, launching, and streaming local coding agents behind one stable runtime facade. It bridges ACP-compatible agents and CLI-first providers such as Codex and Claude Code, hiding provider-specific process, transport, model, MCP, skill, and event differences so an application host can stay focused on product semantics such as sessions, messages, persistence, tool permissions, and replay.

The package is intentionally framework-agnostic. It can be used by desktop apps, local web apps, and trusted host applications that want to call Codex, Claude Code, or ACP-compatible agents.

## What It Provides

- Runtime facade: `createLocalAgentRuntime()` exposes `detect()`, `run()`, `cancel()`, and `listProviders()`.
- Provider plugins: Codex, Claude Code, Hermes, Kimi, Kiro, generic ACP, and fake test provider.
- Process runtime: command resolution, stdin prompt delivery, supervised child process lifecycle, timeout, cancel, stderr tail, and secret redaction.
- Transports: JSONL, plain stdout, and ACP JSON-RPC.
- MCP delivery: normalized stdio/http MCP server config passed into provider-specific launch plans.
- Skills delivery: materialized skill files, prompt injection, project-instruction style delivery, and cleanup.
- Event normalization: provider output is converted into a stable `AgentEvent` stream.
- Resume contract: same-provider resume metadata can be passed through; cross-provider handoff should be owned by the host.
- Testing tools: fake provider, fake ACP peer, fixtures, and conformance helpers under `@nextop-os/agent-acp-kit/testing`.

## Install

```bash
npm install @nextop-os/agent-acp-kit
```

Package managers such as `pnpm`, `yarn`, and `bun` also work:

```bash
pnpm add @nextop-os/agent-acp-kit
yarn add @nextop-os/agent-acp-kit
bun add @nextop-os/agent-acp-kit
```

The package is ESM-only and requires Node.js 22 or newer.

## Quick Start

```ts
import {
  createClaudeProvider,
  createCodexProvider,
  createLocalAgentRuntime,
} from "@nextop-os/agent-acp-kit";

const runtime = createLocalAgentRuntime({
  providers: [
    createCodexProvider(),
    createClaudeProvider(),
  ],
});

const detections = await runtime.detect();
console.log(detections.map((item) => ({
  provider: item.provider,
  supported: item.result?.supported !== false,
  reason: item.result?.unsupportedReason,
  models: item.result?.models,
})));

for await (const event of runtime.run({
  runId: crypto.randomUUID(),
  provider: "codex",
  cwd: "/path/to/workspace",
  prompt: "Inspect the project and summarize the main architecture.",
  model: "codex:gpt-5.4",
})) {
  if (event.type === "text_delta") {
    process.stdout.write(event.text);
  }
  if (event.type === "tool_call") {
    console.log("tool started", event.name, event.input);
  }
  if (event.type === "done") {
    console.log("run finished", event.status);
  }
}
```

## Host Integration Pattern

The package should be treated as the local-agent runtime layer, not as an application orchestrator.

Your host should own:

- User/session/run/message persistence.
- Assistant message anchor creation.
- Runtime policy such as trusted local mode, default provider, default model, and tool allowlist.
- Domain tools and MCP server creation.
- Mapping `AgentEvent` into your app's stream/replay protocol.
- Billing, job queues, media storage, and canvas writes.
- Cross-provider resume/handoff semantics.

The package should own:

- Provider detection and capability reporting.
- Provider-specific launch args and environment preparation.
- Provider-specific model handling.
- Provider-specific MCP config delivery.
- Process supervision and transport handling.
- Provider output parsing into `AgentEvent`.
- Cleanup of per-run temporary files it creates.

Keep the host adapter thin. A typical host adapter should only prepare context, call `runtime.run(input)`, and project `AgentEvent` into host events.

```ts
const mcpServers = [
  {
    name: "host-tools",
    type: "stdio" as const,
    command: process.execPath,
    args: ["/absolute/path/to/host-tools-mcp.js"],
    env: {
      HOST_TOOL_TOKEN: runScopedToolToken,
      HOST_DAEMON_URL: "http://127.0.0.1:3001",
    },
  },
];

for await (const event of runtime.run({
  runId,
  provider: selectedProvider,
  cwd: workspaceDir,
  prompt: userPrompt,
  systemPrompt,
  history,
  model,
  mcpServers,
  skillManifest,
  extraAllowedDirs: [workspaceDir],
  env: providerEnv,
  resume: resumeContext,
})) {
  await projectAgentEventToHostStream(event);
}
```

## Providers

### Codex

Codex runs through the `codex exec --json` path and parses JSONL events. When MCP servers are provided, the provider creates a per-run `CODEX_HOME`, copies only `auth.json`, writes a clean `config.toml`, and removes temporary files after the run.

Codex model discovery uses `codex debug models`, then falls back to `codex debug models --bundled`, then to a package fallback list.

### Claude Code

Claude runs through `claude -p --output-format stream-json --verbose` and parses stream JSON events. MCP servers are delivered through a per-run `--mcp-config` file and `--strict-mcp-config`.

Claude Code does not expose a reliable model list command today. The provider returns fallback model hints such as `sonnet`, `opus`, `haiku`, and known full ids. Hosts should allow a custom model id and pass it through as `claude:<model>` or a raw Claude model id.

### ACP Providers

Hermes, Kimi, Kiro, and `createGenericAcpProvider()` use the shared ACP JSON-RPC transport. ACP providers can expose models through the ACP session lifecycle when supported by the peer.

These providers are suitable for smoke and integration paths today. If a provider needs special auth, custom resume, custom permissions, or non-standard model behavior, implement a provider-specific plugin while reusing the ACP transport.

## Input Contract

The main input is `AgentRunInput`.

Important fields:

- `runId`: stable host run id, used for cancellation and cleanup.
- `provider`: provider id, for example `codex`, `claude`, `hermes`, `kimi`, `kiro`.
- `cwd`: workspace directory for the local agent process.
- `prompt`: current user request.
- `systemPrompt`: optional host-level instruction.
- `history`: previous chat messages to include in provider prompt context.
- `model`: selected provider model. Host ids may use provider prefixes such as `codex:gpt-5.4` or `claude:sonnet`.
- `mcpServers`: stdio/http MCP server configs to make host tools available.
- `skillManifest`: skills to materialize or inject for this run.
- `resume`: provider-local resume metadata or explicit `fresh`.
- `signal`: optional abort signal for host-driven cancellation.

## Event Contract

The runtime yields `AgentEvent`.

`AgentEvent` is a TypeScript discriminated union. Narrow on `event.type` directly; TypeScript will expose the fields for that event variant.

```ts
if (event.type === "tool_result" && event.status === "failed") {
  console.error(event.error);
}
```

Common event types:

- `status`: lifecycle progress such as detecting, spawning, running, warning.
- `thinking_delta`: incremental reasoning/thinking text when a provider exposes it.
- `text_delta`: assistant text.
- `tool_call`: normalized tool start.
- `tool_result`: normalized tool completion or failure. Failed tools include `status: "failed"` and `isError: true`.
- `stderr`: redacted stderr text.
- `error`: runtime or provider error.
- `done`: terminal event with `completed`, `failed`, or `canceled`.

The host should persist enough event data to support replay and should treat `done` as the terminal source of truth for a run.

## Model Discovery

Use `runtime.detect()` to get provider installation status, support status, and model hints.

```ts
const modelOptions = await runtime.detect();
```

Detection is non-throwing at the runtime facade. If a provider CLI is missing or unusable, the detection result is either `null` or an `AgentDetection` with:

- `authState: "missing"` when the executable is not installed.
- `supported: false` when the provider cannot be used.
- `unsupportedReason` for UI/debug output.
- fallback model hints when they are still useful for settings screens.

Provider behavior differs:

- Codex: dynamic discovery when the CLI supports `debug models`, with bundled/fallback recovery.
- Claude: fallback hints plus custom model pass-through.
- ACP: attempts ACP model discovery when the peer reports models.

Hosts should not hardcode Codex or Claude model lists above the package. If a UI needs custom models, keep that UI behavior in the host and pass the chosen id into `AgentRunInput.model`.

## MCP Tools

This package does not define product tools. It accepts `mcpServers` and converts them into the provider's expected format.

The product app should expose tools through an MCP server, then pass that server into each run:

```ts
const mcpServers = [{
  name: "app-tools",
  type: "stdio" as const,
  command: "node",
  args: ["/absolute/path/to/app-tools-mcp.js"],
  env: { APP_TOOL_TOKEN: runScopedToken },
}];
```

Keep tokens run-scoped and short-lived. Do not pass broad application secrets or database credentials directly to agent processes.

## Skills

`skillManifest` supports three delivery modes:

- `materialized-files`: writes skill files into the run workspace and references them in the prompt.
- `prompt-injection`: injects skill content into the provider prompt.
- `project-instructions`: injects instruction-style skill content.

The package handles materialization and cleanup. The host remains the source of truth for skill selection, permission, and storage.

## Cancellation And Resume

Use `runtime.cancel(runId)` or abort the `signal` passed into `runtime.run()`.

```ts
const controller = new AbortController();
const stream = runtime.run({ ...input, signal: controller.signal });

controller.abort();
await runtime.cancel(input.runId);
```

Resume is deliberately conservative:

- Same-provider resume may pass `providerSessionId` or `resumeToken` when the provider supports it.
- If no provider resume metadata exists, pass `resume: { mode: "fresh" }`.
- Cross-provider resume should be implemented as host-level handoff: rebuild prompt/history/context and start a fresh provider run.

## Testing

Use the testing export for package consumers and provider authors.

```ts
import {
  assertProviderConformance,
  createFakeAcpPeer,
  createFakeProvider,
} from "@nextop-os/agent-acp-kit/testing";
```

Recommended checks:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

Provider-specific tests should cover:

- Detection success and fallback.
- Launch plan args, env, model, MCP, and prompt input.
- Parser output for text, tools, errors, and terminal events.
- Cancellation and nonzero exit stderr.
- ACP initialize/session/model/prompt lifecycle when applicable.

## Security Notes

Local agents execute user-trusted CLIs on the local machine. Only enable this package in trusted local mode.

Recommended host policy:

- Use run-scoped tool tokens with TTL and explicit revoke.
- Do not pass Supabase, database, or cloud provider tokens directly to agents.
- Redact stdout/stderr secrets before persistence.
- Clean per-run temporary directories.
- Limit MCP tool allowlists per run.
- Gate dangerous provider flags behind trusted local mode.
- Persist terminal events durably so cancellation/failure cannot be overwritten by late process output.

## Public API

Main export:

```ts
import {
  createLocalAgentRuntime,
  createCodexProvider,
  createClaudeProvider,
  createGenericAcpProvider,
  createHermesProvider,
  createKimiProvider,
  createKiroProvider,
  type AgentEvent,
  type AgentRunInput,
} from "@nextop-os/agent-acp-kit";
```

Runtime control plane export:

```ts
import {
  createRuntimeControlPlane,
  inferRuntimeKind,
} from "@nextop-os/agent-acp-kit/runtime-control-plane";
```

Testing export:

```ts
import {
  assertProviderConformance,
  createFakeAcpPeer,
  createFakeProvider,
} from "@nextop-os/agent-acp-kit/testing";
```

## Publishing Checklist

Use the GitHub Actions workflow `.github/workflows/npm-package-release.yml` for normal releases. It is intentionally manual-triggered but does not require typing the next version for normal releases.

Required repository setup:

- Add an npm automation token as the repository secret `NPM_TOKEN`.
- Run the workflow from the `main` branch.
- Choose `version_bump`: `patch`, `minor`, `major`, or `custom`.
- Keep the default `patch` for routine compatible fixes.
- Use `minor` for backward-compatible feature releases.
- Use `major` for breaking public API changes.
- Use `custom` only for prereleases or explicit versions, then fill `custom_version`, for example `0.2.0-beta.1`.
- Keep `dist_tag` as `latest` for stable releases, or use a tag such as `next` for prereleases.
- Use `dry_run: true` to validate the full release flow without publishing or pushing a tag.

The workflow computes the next version from `package.json` with `npm version <patch|minor|major> --no-git-tag-version`, or uses `custom_version` for custom releases. It then runs install, typecheck, tests, build, `npm pack --dry-run`, and publishes with npm provenance. After a successful real publish it commits the package version and pushes tag `v<version>`.

Local fallback, only when GitHub Actions is unavailable:

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
npm version <next-version> --no-git-tag-version
npm publish --access public --provenance
git add package.json
git commit -m "Release @nextop-os/agent-acp-kit v<next-version>"
git tag v<next-version>
git push origin main --follow-tags
```

Before publishing:

- Keep host-specific code out of this package.
- Keep provider-specific differences inside providers.
- Keep `AgentRunInput` and `AgentEvent` backward compatible when possible.
- Include README, AGENTS, package tests, and provider conformance tests.
- Run typecheck, tests, and build.
- Validate npm package contents with `pnpm pack:check`.
