# @tutti-os/agent-acp-kit

<p align="center">
  <strong>A TypeScript toolkit for running local coding agents through one ACP-oriented host API.</strong>
</p>

<p align="center">
  <a href="./LICENSE"><img alt="License: Apache-2.0" src="https://img.shields.io/badge/license-Apache--2.0-blue" /></a>
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

## Local Quick Start

For a regular local host, the application owns the workspace directory and
passes that path directly as `cwd`.

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
  supported: item.supported,
  authState: item.authState,
  models: item.models,
  reason: item.reason,
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
| Tutti integration | auto CLI-backed/standalone provider catalog, composer options, dynamic skill context, browser-safe contracts |

## Tutti Workspace Apps

Tutti apps keep platform integration behind `@tutti-os/agent-acp-kit/tutti` and keep actual Agent execution in an app-owned local runtime:

```ts
import {
  createManagedAgentDetectContextFromHeaders,
  createDefaultLocalAgentRuntime,
  createManagedAgentRunContextFromHeaders,
} from "@tutti-os/agent-acp-kit";
import {
  loadTuttiAgentSkillContext,
} from "@tutti-os/agent-acp-kit/tutti";

const runtime = createDefaultLocalAgentRuntime();
const detectContext = createManagedAgentDetectContextFromHeaders(headers);
const providers = await runtime.detect(detectContext);
const providerId = (
  providers.find((provider) => provider.isDefault && provider.supported) ??
  providers.find((provider) => provider.supported)
)?.provider;
if (!providerId) {
  throw new Error("No local Agent provider is currently available.");
}
const skills = await loadTuttiAgentSkillContext({
  provider: providerId,
  agentSessionId: runId,
  cwd: appLocalCwd,
  detectContext,
});
const runContext = await createManagedAgentRunContextFromHeaders(headers, {
  providerId,
  runId,
});
```

There is no app-facing mode switch. `runtime.detect(detectContext)` is the only
high-level discovery API. A managed context uses versioned Tutti CLI provider
and composer JSON without running Provider plugin probes. A standalone context
uses Provider plugin detection. Both return the same flat `DetectedProvider[]`.
Managed results mark the schema-v2 `defaultProviderId` entry with
`isDefault: true`; callers must also require `supported: true` before selecting
it. Standalone results omit `isDefault` because there is no Tutti global
default.

Apps that wrap a Provider plugin can preserve that customization without
reimplementing managed detection:

```ts
const runtime = createDefaultLocalAgentRuntime({
  providers: customProviderPlugins,
});
```

The default factory always owns managed strategy injection. Consumer apps must
not import or wire the internal managed detector themselves.

Managed hosts pass the same request-scoped `detectContext` object unchanged to
runtime detection and skill helpers. The kit projects its existing
managed invocation credential only when it creates the immediate CLI child;
intermediate app code must not extract the credential, copy it to
`process.env`, or substitute `ManagedAgentRunContext` for `detectContext`.
App-owned non-Agent Tutti children use `projectTuttiCliChildProcess` at their
own child boundary and pass returned output through
`redactTuttiCliChildProcessText` before logging or returning errors.

Apps do not construct daemon URLs or CLI argv, read catalog tokens, pass app IDs, or map provider IDs. Provider IDs are canonical outputs. Claude Code is `claude-code`; legacy `claude` remains accepted only at SDK input ingress and is never returned. The first-party Tutti provider is `tutti-agent`; historical `nexight` must not be registered or exposed as a new App runtime provider.

Frontend code can import DTO types and guards without Node dependencies:

```ts
import {
  isTuttiAgentProviderCatalog,
  type TuttiAgentProviderCatalog,
} from "@tutti-os/agent-acp-kit/tutti/contracts";
```

## Provider Support

| Provider | Status | Transport | Notes |
| --- | --- | --- | --- |
| Codex | Supported | `codex exec --json` JSONL | Dynamic model discovery via `codex debug models`; per-run `CODEX_HOME` with copied auth and sanitized config; same-provider resume via `codex exec resume --json <session> -` |
| Claude Code (`claude-code`) | Supported | `claude -p --output-format stream-json` | Canonical provider ID is `claude-code`; legacy `claude` input is accepted internally; supports fallback model hints, custom model pass-through, and same-provider resume via `--resume <session>` |
| Tutti Agent (`tutti-agent`) | Supported | `tutti-agent exec --json` JSONL | First-party canonical provider; local runs copy credentials into a temporary `TUTTI_AGENT_HOME`, while managed runs use the managed run directory supplied by Tutti; authentication is probed with `tutti-agent login status`; no Nexight runtime alias |
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

Local Codex runs always use a run-scoped temporary `CODEX_HOME`. The temporary
root comes from run env `TMPDIR`, `TEMP`, or `TMP`, then process env, then the
OS default. The provider shares `auth.json`, `sessions/`, and `plugins/cache/`
with the requested `CODEX_HOME` or the user's default `~/.codex` so token
refreshes, native resume, and plugin assets stay durable across runs; plugin
cache exposure is best-effort and does not block a run. It copies isolated
config files such as `config.json`, `config.toml`, and `instructions.md`,
preserves compatible `config.toml` settings such as custom model providers and
`base_url`, removes Codex config values known to break current CLI parsing,
disables Codex native multi-agent for single-process run lifecycle safety, and
overlays any run-scoped MCP server config.

Managed Codex runs use a caller-supplied `CODEX_HOME` when one is provided;
otherwise they materialize a run-scoped `CODEX_HOME` at
`<managed-run-cwd>/.codex`. This managed home is for run-local Codex config
only; auth, user sessions, and MCP attachments stay on the managed execution
path instead of being copied from the app server.

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

For MCP tool events, `name` is the normalized short tool name. Providers that
surface a server namespace may also include `rawName` and `mcpServerName`, so
hosts can distinguish same-named tools exposed by different MCP servers while
keeping backward-compatible short-name routing.

Hosts should persist enough event data for replay and should treat `done` as the terminal source of truth for a run. Individual `error` events are diagnostics, not terminal status by themselves.

Codex reconnect progress such as `Reconnecting... 2/5 (request timed out)` is a transient provider retry state. The Codex provider maps those JSONL messages to `status` events with `status: "warning"` so hosts can show progress without ending the run.

## Models

Use `runtime.detect()` to get provider installation status, support status, and model hints.

```ts
const modelOptions = await runtime.detect();
```

No-argument detection is cached for the lifetime of the runtime. After a host
installs a provider or otherwise changes the local CLI environment, call
`runtime.detect({ refresh: true })` to clear that cache and probe the current
machine state.

Provider behavior differs:

- Codex: attempts dynamic discovery with `codex debug models`, then falls back to bundled or package model hints.
- Claude Code: returns fallback hints such as `sonnet`, `opus`, `haiku`, and known full ids, then adds configured custom ids from the Claude settings file when present. Custom model ids can be passed through.
- ACP providers: attempt model discovery through ACP session lifecycle when the peer supports it.

Provider plugin diagnostics remain internal to standalone projection. The
public result intentionally contains only provider identity, `supported`,
`authState`, models/default model, and an optional display-only `reason`.

Hosts should not hardcode Codex or Claude model lists above this package. If a UI needs additional custom models, keep that UI behavior in the host and pass the chosen id into `AgentRunInput.model`.

## Permissions

Runs accept an optional provider-neutral permission selection. Pass both the
semantic returned by the composer and its provider mode id when available:

```ts
permission: {
  modeId: selectedMode.id,
  semantic: selectedMode.semantic,
}
```

The SDK maps this policy to each provider. Workspace App runs default to
`full-access` when the host omits `permission`: Codex uses its unrestricted
sandbox mode, Claude uses `bypassPermissions`, and ACP requests select a
recognized permissive option when the peer offers one (otherwise the request
is cancelled).
An App can pass an explicit narrower semantic for a run. For ACP, every
non-`full-access` semantic cancels permission requests because the protocol
adapter cannot safely infer a tool's risk from a provider-specific option id.

## Managed Agent Invocation

Hosts that run inside a managed reverse-exec environment can pass a per-operation
managed invocation context to both detection and runs. In SSR or server-side
handlers behind TSH desktop runtime preview, use the header helpers so app code
does not need to parse credentials or define managed cwd rules:

```ts
import {
  createManagedAgentDetectContextFromHeaders,
  createManagedAgentRunContextFromHeaders,
} from "@tutti-os/agent-acp-kit";

const detectContext = createManagedAgentDetectContextFromHeaders(request.headers);
await runtime.detect(detectContext);

const runContext = await createManagedAgentRunContextFromHeaders(request.headers, {
  providerId: "codex",
  runId,
});
const cwd = runContext?.cwd ?? localWorkspaceDir;

for await (const event of runtime.run({
  runId,
  provider: "codex",
  cwd,
  prompt,
  managedAgentInvocation: runContext?.managedAgentInvocation,
})) {
  // Project AgentEvent into the host protocol.
}
```

The helpers read `X-TSH-Managed-Agent-Credential` case-insensitively from
headers-like inputs. If the header is absent, they return `undefined` and the
existing non-managed behavior is unchanged. The `localWorkspaceDir` fallback
above is only for that non-managed path. When `runContext` is present, use
`runContext.cwd` as the provider process cwd and pass
`runContext.managedAgentInvocation` through to `runtime.run()`.

When the header is present, the helpers use `TUTTI_APP_DATA_DIR` as the
app-isolated base directory. Run contexts create a scoped cwd under
`TUTTI_APP_DATA_DIR/.agent-runs/`; the final directory name is generated by the
SDK and should not be parsed or recreated by host applications.

When this context is present, the SDK injects
`TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL` only into the current provider
operation and sets the provider process cwd from `managedAgentInvocation.cwd`.
Managed cwd values are not remapped to `/workspace`; the host runtime-provided
app data directory is used directly.

For Codex managed runs, the SDK also prepares a run-scoped `CODEX_HOME`. If the
host passes `env.CODEX_HOME`, that directory is used; otherwise the SDK creates
one under the managed cwd. Hosts that do not need a custom Codex home can use
the run context returned by `createManagedAgentRunContextFromHeaders()` without
passing any Codex-home path.

Managed invocation is intentionally limited to provider ids `codex`,
`claude-code`, and `tutti-agent`. There is no `nextop` or `nexight` ingress
alias. All three are built-in providers. The SDK expects managed CLI shims to
be available on `PATH` and does not hardcode shim paths.

In managed hosts, avoid alternate credential paths. Do not read a browser JSB
credential and forward it in the request body, do not store managed credentials
in run records or messages, and do not build `.agent-runs` paths in application
code. Treat the request header as the server-side trust boundary and let these
helpers produce the context consumed by `runtime.detect()` and `runtime.run()`.

Managed credentials are not written to `process.env`, detection cache keys,
provider config files, or global skill directories. They are added to
run-scoped process env and redaction secrets so stderr tails and transport
errors do not expose the credential. Detection contexts may also include
`redactionSecrets`; managed invocation credentials are added to that list before
provider detection runs.

When a managed Codex or Claude run includes `mcpServers`, the SDK does not ask
the provider to materialize provider-native MCP config. Instead it serializes a
normalized MCP attachment into
`TSH_MANAGED_AGENT_MCP_ATTACHMENT_B64` for the tsh shim. Managed MCP handoff v1
supports only VM-local stdio MCP servers; VM execution is implicit and callers
do not need to set an execution-side flag. If that MCP server calls back into a
host or app tool gateway, the injected gateway URL must be reachable from the VM
process. MCP env/header values and the handoff payload are added to run
redaction secrets.

## Installing Local Providers

Hosts can expose an install action for supported local providers through one
public function:

```ts
import { installAgentProvider } from "@tutti-os/agent-acp-kit";

const result = await installAgentProvider("codex");
```

Supported install targets are `codex` and `claude`. The function installs and
checks the official provider CLIs only:

- Codex install: `npm install -g @openai/codex`
- Claude Code install: `npm install -g @anthropic-ai/claude-code`

ACP adapter packages such as `codex-acp` and `claude-agent-acp` are not required
for these built-in providers. The install status still reports whether legacy
adapter binaries are present as compatibility metadata, but adapter presence no
longer affects `availability`, command selection, or post-install success.

The result is structured instead of throwing raw shell output. Failed installs
include a `failureReason` such as `install_command_failed`,
`install_timed_out`, or `post_install_probe_failed`. A successful install can
still return `auth_required` in `after.availability`; hosts should then prompt
the user to log in with the provider CLI.

Install, detection, and runtime launch envs include common local binary
directories such as `/opt/homebrew/bin`, `/usr/local/bin`, `~/.local/bin`, npm
configured prefix bins, and npm's global prefix bin when it can be resolved.

## MCP Tools

This package does not define product tools. It accepts `mcpServers` and converts them into the provider's expected format.

```ts
const mcpServers = [{
  name: "app-tools",
  type: "stdio" as const,
  command: "node",
  args: ["/absolute/path/to/app-tools-mcp.js"],
  env: { APP_TOOL_TOKEN: runScopedToken },
  toolTimeoutMs: 30 * 60_000,
  startupTimeoutMs: 2 * 60_000,
}];
```

Timeouts are normalized by provider. Codex writes `startup_timeout_sec` and
`tool_timeout_sec` into its per-run config. Claude Code writes per-server
`timeout` for tool calls. Generic ACP providers receive only standard ACP MCP
server fields because the ACP MCP server schema does not define timeout fields.
For non-managed Codex and Claude runs, MCP delivery continues to use those
provider-native config paths. For managed Codex and Claude runs, MCP delivery
uses the tsh handoff env described above.

Keep tool tokens run-scoped and short-lived. Do not pass broad application secrets or database credentials directly to agent processes.

## Skills

`skillManifest` supports three delivery modes:

- `materialized-files`: writes skill files into the run workspace and references them in the prompt.
- `prompt-injection`: injects skill content into the provider prompt.
- `project-instructions`: injects instruction-style skill content.

The package handles delivery and cleanup. The host remains the source of truth for skill selection, permission, and storage.

Hosts can also pass skill manifests produced by external commands. Tutti
workspace apps can use the Tutti subpath helper to load dynamic CLI skills, then
decide how to merge Tutti's recommended system prompt with the app-owned prompt:

```ts
import { loadTuttiAgentSkillContext } from "@tutti-os/agent-acp-kit/tutti";

const tuttiContext = await loadTuttiAgentSkillContext({
  provider,
  agentSessionId: runId,
  cwd,
  commandEnvNames: ["MY_APP_TUTTI_CLI"],
});
const systemPrompt = [
  appSystemPrompt,
  tuttiContext.recommendedSystemPrompt?.content,
].filter(Boolean).join("\n\n");

for await (const event of runtime.run({
  runId,
  provider,
  cwd,
  prompt,
  systemPrompt,
  skillManifest: tuttiContext.skillManifest,
})) {
  await projectAgentEventToHostStream(event);
}
```

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
  MANAGED_AGENT_INVOCATION_PROVIDER_IDS,
  type AgentEvent,
  type AgentRunInput,
  type ManagedAgentInvocation,
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

## Release Workflow

Use `.github/workflows/npm-package-release.yml` for package releases.

Stable `latest` releases:

- Open and merge a PR that bumps `package.json` to the target stable version.
- Run the workflow from `main` with `version_bump=current`, `dist_tag=latest`, and `dry_run=true` first.
- Re-run with `dry_run=false` to publish the current `package.json` version and push tag `v<version>`.

Beta and other prerelease packages:

- Run the workflow from a feature or release branch.
- Use `dist_tag=beta` and either a prerelease bump such as `prepatch`, `preminor`, `premajor`, or `prerelease`, or `version_bump=custom` with a prerelease version such as `0.3.0-beta.0`.
- The workflow commits the prerelease version bump back to the triggering branch, publishes the package, and pushes tag `v<version>`.

The workflow never commits directly to `main`. Non-`latest` releases must use prerelease semver versions, and `latest` releases must use stable semver versions.

## Security

Local agents execute user-trusted CLIs on the local machine. Only enable this package in trusted local mode.

Recommended host policy:

- Use run-scoped tool tokens with TTL and explicit revoke.
- Do not pass Supabase, database, or cloud provider tokens directly to agents.
- Redact stdout and stderr before persistence.
- Clean per-run temporary directories.
- Limit MCP tool allowlists per run.
- Gate dangerous provider flags behind trusted local mode.
- Treat managed invocation credentials as per-operation values; do not store
  them, pass them through global env, or reuse them across detect/run calls.
- Persist terminal events durably so cancellation or failure cannot be overwritten by late process output.

## License

@tutti-os/agent-acp-kit is licensed under the [Apache License 2.0](./LICENSE).

## Roadmap

- Stabilize the public `AgentRunInput` and `AgentEvent` contracts.
- Expand provider conformance tests for ACP lifecycle edge cases.
- Add more provider-specific adapters where shared ACP behavior is not enough.
- Add first-class examples for desktop apps and local web apps.
- Add repository-level `CONTRIBUTING.md` and `SECURITY.md` before broader external contribution.
