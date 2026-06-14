# @tutti-os/agent-acp-kit

<p align="center">
  <strong>A TypeScript toolkit for running local coding agents through one ACP-oriented host API.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@tutti-os/agent-acp-kit"><img src="https://img.shields.io/npm/v/@tutti-os/agent-acp-kit.svg" alt="npm version"></a>
  <a href="https://github.com/tutti-os/agent-acp-kit/actions/workflows/npm-package-release.yml"><img src="https://github.com/tutti-os/agent-acp-kit/actions/workflows/npm-package-release.yml/badge.svg" alt="release workflow"></a>
  <img src="https://img.shields.io/badge/node-%3E%3D22-339933" alt="Node.js >= 22">
  <img src="https://img.shields.io/badge/TypeScript-ready-3178c6" alt="TypeScript ready">
  <img src="https://img.shields.io/badge/ACP-oriented-111827" alt="ACP oriented">
</p>

<p align="center">
  <img src="./assets/agent-acp-kit-architecture.png" alt="Architecture diagram for @tutti-os/agent-acp-kit">
</p>

`@tutti-os/agent-acp-kit` lets a host application detect, launch, stream, cancel, and resume local coding agents through a stable TypeScript facade.

It is built for apps that want to support Codex, Claude Code, and ACP-compatible agents such as Gemini CLI, Cursor Agent, GitHub Copilot CLI, Factory Droid, fast-agent, OpenCode, Qwen Code, Kimi CLI, Kilo, Mistral Vibe, and Trae CLI without scattering provider-specific process, transport, MCP, skill, model, and event parsing logic throughout the app.

This is an embeddable host SDK. It is not a replacement for ACP clients such as [`acpx`](https://github.com/openclaw/acpx), and it is not a single-provider ACP adapter binary such as `codex-acp`.

## Why This Exists

Local coding agents do not all expose the same interface:

- Codex is CLI-first and can stream JSONL from `codex exec --json`.
- Claude Code is CLI-first and streams `stream-json` output.
- ACP-compatible agents speak JSON-RPC session protocols and can be discovered through the ACP Registry.
- Host apps still need their own messages, sessions, tool permissions, replay, canvas state, billing, and product semantics.

This package sits in the middle. It owns local agent execution. Your application owns product behavior.

## ACP-compatible Agents

ACP-compatible agents in the wider ecosystem include:

| Agent | Typical ACP command |
| --- | --- |
| Gemini CLI | `gemini --acp` |
| Cursor Agent | `cursor-agent acp` |
| GitHub Copilot CLI | `copilot --acp --stdio` |
| Factory Droid | `droid exec --output-format acp` |
| fast-agent | `uvx fast-agent-mcp acp` |
| OpenCode | `opencode acp` |
| Qwen Code | `qwen --acp --experimental-skills` |
| Kimi CLI | `kimi acp` |
| Kilo | `kilo acp` |
| Mistral Vibe | `vibe-acp` |
| Trae CLI | `traecli acp serve` |

This table is for ecosystem orientation. Commands can vary by agent version, so use the registry as the source of truth. Built-in provider support in this package is listed below, and hosts can use `createGenericAcpProvider()` or a custom provider plugin when they already have an ACP command to launch.

For the latest installable agent list, see:

- [ACP Registry guide](https://agentclientprotocol.com/get-started/registry)
- [agentclientprotocol/registry](https://github.com/agentclientprotocol/registry)
- [latest registry JSON](https://cdn.agentclientprotocol.com/registry/v1/latest/registry.json)

## Install

```bash
npm install @tutti-os/agent-acp-kit
```

Other package managers work too:

```bash
pnpm add @tutti-os/agent-acp-kit
yarn add @tutti-os/agent-acp-kit
bun add @tutti-os/agent-acp-kit
```

Requirements:

- Node.js 22 or newer.
- ESM runtime.
- Installed provider CLIs for the providers you want to use.

## Quick Start

```ts
import {
  createClaudeProvider,
  createCodexProvider,
  createLocalAgentRuntime,
} from "@tutti-os/agent-acp-kit";

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
  models: item.result?.models,
  reason: item.result?.unsupportedReason,
})));

for await (const event of runtime.run({
  runId: crypto.randomUUID(),
  provider: "codex",
  cwd: "/path/to/workspace",
  prompt: "Inspect this project and summarize the architecture.",
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

## What You Get

| Area | Included |
| --- | --- |
| Runtime facade | `detect()`, `run()`, `cancel()`, `listProviders()` |
| Providers | Codex, Claude Code, ACP presets, generic ACP, fake test provider |
| Process runtime | command resolution, stdin prompt delivery, timeout, cancel, stderr tail, redaction |
| Transports | JSONL, plain stdout, ACP JSON-RPC |
| MCP delivery | normalized stdio/http MCP server config passed into provider launch plans |
| Skills | materialized files, prompt injection, project-instruction style delivery, cleanup |
| Events | normalized `AgentEvent` discriminated union |
| Testing | fake provider, fake ACP peer, fixtures, conformance helpers |

## Provider Support

| Provider | Status | Transport | Notes |
| --- | --- | --- | --- |
| Codex | Supported | `codex exec --json` JSONL | Dynamic model discovery via `codex debug models`; per-run `CODEX_HOME` with copied auth and sanitized config; same-provider resume via `codex exec resume --json <session> -` |
| Claude Code | Supported | `claude -p --output-format stream-json` | Uses fallback model hints, custom model pass-through, and same-provider resume via `--resume <session>` |
| Devin for Terminal | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `DEVIN_ACP_BIN` |
| Hermes | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `HERMES_ACP_BIN` |
| Kimi | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `KIMI_ACP_BIN` |
| Kiro | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `KIRO_ACP_BIN` |
| Kilo | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `KILO_ACP_BIN` |
| Mistral Vibe | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `VIBE_ACP_BIN` |
| Cursor Agent | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `CURSOR_ACP_BIN` |
| Gemini CLI | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `GEMINI_ACP_BIN` |
| OpenCode | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `OPENCODE_ACP_BIN` |
| Qoder CLI | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `QODER_ACP_BIN` |
| Qwen Code | Experimental | ACP JSON-RPC | Shared generic ACP transport; command override `QWEN_ACP_BIN` |
| Generic ACP | Experimental | ACP JSON-RPC | Bring your own ACP agent command |
| Fake | Test helper | In-memory async events | For host tests and conformance checks |

Built-in real local providers do not impose a provider-level concurrency cap. Hosts can still enforce stricter queueing, cancellation, or watchdog policies around `runtime.run()` when a product surface needs serialized execution.

Codex runs always use a run-scoped temporary `CODEX_HOME`. The provider shares
`auth.json`, `sessions/`, and `plugins/cache/` with the requested `CODEX_HOME`
or the user's default `~/.codex` so token refreshes, native resume, and plugin
assets stay durable across runs; plugin cache exposure is best-effort and does
not block a run. It copies isolated config files such as
`config.json`, `config.toml`, and `instructions.md`, preserves compatible
`config.toml` settings such as custom model providers and `base_url`, removes
Codex config values known to break current CLI parsing, disables Codex native
multi-agent for single-process run lifecycle safety, and overlays any run-scoped
MCP server config.

## Host Integration Pattern

Treat this package as the local-agent execution layer, not as your application orchestrator.

Your host should own:

- User, session, run, and message persistence.
- Assistant message anchor creation.
- Runtime policy, such as trusted local mode, default provider, default model, and tool allowlists.
- Domain tools and MCP server creation.
- Mapping `AgentEvent` into your app stream, websocket, or replay protocol.
- Billing, job queues, media storage, canvas writes, and product state.
- Cross-provider resume or handoff semantics.

This package should own:

- Provider detection and capability reporting.
- Provider-specific command args, env, MCP config delivery, and model normalization.
- Process supervision and transport handling.
- Provider output parsing into `AgentEvent`.
- Cleanup of per-run temporary files it creates.

Keep the host adapter thin:

```ts
const mcpServers = [{
  name: "app-tools",
  type: "stdio" as const,
  command: process.execPath,
  args: ["/absolute/path/to/app-tools-mcp.js"],
  env: {
    APP_TOOL_TOKEN: runScopedToken,
    APP_DAEMON_URL: "http://127.0.0.1:3001",
  },
}];

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

## Events

`AgentEvent` is a TypeScript discriminated union. Narrow on `event.type` and TypeScript will expose the fields for that event variant.

```ts
if (event.type === "tool_result" && event.status === "failed") {
  console.error(event.error);
}
```

Common event types:

| Event | Meaning |
| --- | --- |
| `status` | Lifecycle progress such as detecting, spawning, running, warning |
| `thinking_delta` | Incremental reasoning or thinking text when a provider exposes it |
| `text_delta` | Assistant text |
| `tool_call` | Normalized tool start |
| `tool_result` | Normalized tool completion or failure |
| `stderr` | Redacted stderr text |
| `error` | Runtime or provider error |
| `done` | Terminal event with `completed`, `failed`, or `canceled` |

Hosts should persist enough event data for replay and should treat `done` as the terminal source of truth for a run.

## Models

Use `runtime.detect()` to get provider installation status, support status, and model hints.

```ts
const modelOptions = await runtime.detect();
```

Provider behavior differs:

- Codex: attempts dynamic discovery with `codex debug models`, then falls back to bundled or package model hints.
- Claude Code: returns fallback hints such as `sonnet`, `opus`, `haiku`, and known full ids, then adds configured custom ids from the Claude settings file when present. Custom model ids can be passed through.
- ACP providers: attempt model discovery through ACP session lifecycle when the peer supports it.

Hosts should not hardcode Codex or Claude model lists above this package. If a UI needs additional custom models, keep that UI behavior in the host and pass the chosen id into `AgentRunInput.model`.

## Installing Local Providers

Hosts can expose an install action for supported local providers through one
public function:

```ts
import { installAgentProvider } from "@tutti-os/agent-acp-kit";

const result = await installAgentProvider("codex");
```

Supported install targets are `codex` and `claude`. The function probes the
provider CLI and ACP adapter first, then chooses the right npm command:

- Codex full install: `npm install -g @openai/codex @zed-industries/codex-acp`
- Codex adapter-only install: `npm install -g @zed-industries/codex-acp`
- Claude Code full install: `npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp`
- Claude Code adapter-only install: `npm install -g @agentclientprotocol/claude-agent-acp`

The result is structured instead of throwing raw shell output. Failed installs
include a `failureReason` such as `install_command_failed`,
`install_timed_out`, or `post_install_probe_failed`. A successful install can
still return `auth_required` in `after.availability`; hosts should then prompt
the user to log in with the provider CLI.

## MCP Tools

This package does not define product tools. It accepts `mcpServers` and converts them into the provider's expected format.

```ts
const mcpServers = [{
  name: "app-tools",
  type: "stdio" as const,
  command: "node",
  args: ["/absolute/path/to/app-tools-mcp.js"],
  env: { APP_TOOL_TOKEN: runScopedToken },
}];
```

Keep tool tokens run-scoped and short-lived. Do not pass broad application secrets or database credentials directly to agent processes.

## Skills

`skillManifest` supports three delivery modes:

- `materialized-files`: writes skill files into the run workspace and references them in the prompt.
- `prompt-injection`: injects skill content into the provider prompt.
- `project-instructions`: injects instruction-style skill content.

The package handles delivery and cleanup. The host remains the source of truth for skill selection, permission, and storage.

## Cancellation And Resume

Use `runtime.cancel(runId)` or abort the `signal` passed into `runtime.run()`.

```ts
const controller = new AbortController();
const stream = runtime.run({ ...input, signal: controller.signal });

controller.abort();
await runtime.cancel(input.runId);
```

Resume is conservative by design:

- Same-provider resume may pass `providerSessionId` or `resumeToken` when the provider supports it.
- If no provider resume metadata exists, pass `resume: { mode: "fresh" }`.
- Cross-provider resume should be host-level handoff: rebuild prompt, history, and context, then start a fresh provider run.

Hosts should still pass durable `history` on every run. Native resume is an optimization for the same provider, not the only source of continuity:

```ts
const sameProvider = previousRun?.provider === selectedProvider;
const providerResumeId = previousRun?.providerSessionId ?? previousRun?.resumeToken;
const resume = sameProvider && providerResumeId
  ? {
      mode: "provider" as const,
      providerSessionId: previousRun?.providerSessionId,
      resumeToken: previousRun?.resumeToken,
    }
  : { mode: "fresh" as const };

for await (const event of runtime.run({
  runId,
  provider: selectedProvider,
  cwd,
  prompt,
  history: durableMessages,
  resume,
})) {
  if (event.type === "done") {
    await saveRunResumeMetadata(runId, {
      providerSessionId: event.sessionId,
      resumeToken: event.resumeToken,
    });
  }
}
```

## Public API

Main export:

```ts
import {
  createLocalAgentRuntime,
  createCodexProvider,
  createClaudeProvider,
  createDefaultLocalAgentProviderPlugins,
  createGenericAcpProvider,
  installAgentProvider,
  type AgentEvent,
  type AgentRunInput,
} from "@tutti-os/agent-acp-kit";
```

Runtime control plane export:

```ts
import {
  createRuntimeControlPlane,
  inferRuntimeKind,
} from "@tutti-os/agent-acp-kit/runtime-control-plane";
```

Testing export:

```ts
import {
  assertProviderConformance,
  createFakeAcpPeer,
  createFakeProvider,
} from "@tutti-os/agent-acp-kit/testing";
```

## Development

```bash
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm pack:check
```

## Security

Local agents execute user-trusted CLIs on the local machine. Only enable this package in trusted local mode.

Recommended host policy:

- Use run-scoped tool tokens with TTL and explicit revoke.
- Do not pass Supabase, database, or cloud provider tokens directly to agents.
- Redact stdout and stderr before persistence.
- Clean per-run temporary directories.
- Limit MCP tool allowlists per run.
- Gate dangerous provider flags behind trusted local mode.
- Persist terminal events durably so cancellation or failure cannot be overwritten by late process output.

## Roadmap

- Stabilize the public `AgentRunInput` and `AgentEvent` contracts.
- Expand provider conformance tests for ACP lifecycle edge cases.
- Add more provider-specific adapters where shared ACP behavior is not enough.
- Add first-class examples for desktop apps and local web apps.
- Add repository-level `LICENSE`, `CONTRIBUTING.md`, and `SECURITY.md` before broader external contribution.
