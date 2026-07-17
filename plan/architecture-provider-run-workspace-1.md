---
goal: Unify Run-Scoped Provider Preparation Across Native and ACP Providers
version: 1.0
date_created: 2026-07-17
last_updated: 2026-07-17
owner: agent-acp-kit maintainers
status: 'Completed'
tags: [architecture, performance, providers, skills, acp]
---

# Introduction

![Status: Completed](https://img.shields.io/badge/status-Completed-brightgreen)

This plan defines and executes a provider preparation architecture that keeps formal project data in the caller-provided `cwd`, stores provider-owned transient artifacts under the resolved runtime temp directory, delivers selected skills consistently to native and ACP providers, and cleans every run-scoped artifact at the provider lifecycle boundary.

## 1. Requirements & Constraints

- **REQ-001**: Claude, Codex, Tutti Agent, Cursor, OpenCode, and every provider created by `createGenericAcpProvider` must receive prompt-injected and materialized-file skills selected in `AgentRunParams.skillManifest`.
- **REQ-002**: Materialized skill files and generated provider configuration must be created below `resolveTempDir(params.env)` and must never be created below `params.cwd`.
- **REQ-003**: Generic ACP MCP configuration must continue to be delivered through ACP `session/new`; it must not be duplicated into generated files.
- **REQ-004**: Provider preparation must reject concurrent or duplicate preparation for the same `runId` and must clean partial artifacts after any preparation failure.
- **REQ-005**: Provider run artifacts must be cleaned after direct `run()` completion, adapter stream completion, cancellation, and provider parse failure.
- **REQ-006**: Cursor and OpenCode must be validated as representative Generic ACP providers through launch-plan tests and executable detection or ACP transport tests.
- **SEC-001**: Generic ACP preparation must not replace `HOME` or provider-specific authentication directories because doing so can hide existing credentials and configuration.
- **SEC-002**: Generated prompts and logs must not expose MCP environment values, headers, authentication files, or unrelated global skills.
- **CON-001**: `params.cwd` remains the canonical application project working directory under `TUTTI_APP_DATA_DIR`; this plan does not introduce a local project mirror or synchronization protocol.
- **CON-002**: Generic ACP providers report `nativeResume: false`; this plan must not invent provider resume semantics.
- **CON-003**: Public provider factory signatures and existing provider identifiers must remain backward compatible.
- **GUD-001**: Shared lifecycle behavior belongs in a small provider utility; provider-specific launch arguments and transports remain in provider plugins.
- **PAT-001**: Use one run-scoped root per provider run, atomic run reservation, parallel independent preparation, and idempotent cleanup.

## 2. Implementation Steps

### Implementation Phase 1

- GOAL-001: Define the shared run workspace lifecycle and document provider ownership boundaries.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-001 | Add this plan at `plan/architecture-provider-run-workspace-1.md` with explicit storage, lifecycle, security, and validation contracts. | ✅ | 2026-07-17 |
| TASK-002 | Add `src/providers/run-workspace.ts` with atomic `runId` reservation, lazy temp-root creation, tracked cleanup targets, and idempotent success/failure cleanup. | ✅ | 2026-07-17 |
| TASK-003 | Export no new root API; keep the lifecycle utility provider-internal until a second independent consumer proves a public contract is necessary. | ✅ | 2026-07-17 |

### Implementation Phase 2

- GOAL-002: Deliver selected skills correctly and efficiently to all Generic ACP providers.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-004 | Update `src/providers/generic-acp/provider.ts` to materialize `materialized-files` skills below the run workspace and compose all skill delivery modes into the prompt. | ✅ | 2026-07-17 |
| TASK-005 | Preserve ACP MCP delivery through `runAcpTransport` and avoid generated MCP files or provider-home replacement. | ✅ | 2026-07-17 |
| TASK-006 | Add adapter and direct-run lifecycle cleanup, including preparation failure, parse failure, cancellation, and duplicate-run protection. | ✅ | 2026-07-17 |

### Implementation Phase 3

- GOAL-003: Align native and Codex-compatible providers with the shared lifecycle invariants without changing their provider-specific formats.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-007 | Audit Claude against the shared invariants and retain its parallel skills/MCP preparation under a run-scoped temp root. | ✅ | 2026-07-17 |
| TASK-008 | Update Codex and Tutti Agent preparation to reject duplicate `runId` preparation and prevent adapter reuse races. | ✅ | 2026-07-17 |
| TASK-009 | Remove avoidable per-run cwd marker churn or make marker ownership concurrency-safe while preserving Codex project-root discovery. | ✅ | 2026-07-17 |

### Implementation Phase 4

- GOAL-004: Verify representative Generic ACP providers and complete package regression validation.

| Task | Description | Completed | Date |
|------|-------------|-----------|------|
| TASK-010 | Add Cursor and OpenCode tests proving TMPDIR skill materialization, prompt delivery, ACP MCP forwarding, duplicate protection, and cleanup. | ✅ | 2026-07-17 |
| TASK-011 | Run Cursor and OpenCode executable detection in the development environment and record supported/auth/model outcomes without mutating user configuration. | ✅ | 2026-07-17 |
| TASK-012 | Run `pnpm typecheck`, `pnpm test`, `pnpm build`, `pnpm pack:check`, and `pnpm test:packed-consumer`; update this plan status and task completion fields. | ✅ | 2026-07-17 |
| TASK-013 | Exercise a real stdio MCP tool through Claude, Codex, Cursor, and OpenCode; normalize long-lived ACP peer shutdown and isolate Codex child temp files below its run home. | ✅ | 2026-07-17 |

## 3. Alternatives

- **ALT-001**: Set a temporary global `HOME` for every provider. Rejected because Cursor, OpenCode, Gemini, and other ACP CLIs may keep authentication and configuration in provider-specific locations below the existing user home.
- **ALT-002**: Materialize skills below the application `cwd`. Rejected because the cwd can be FabricFS/NFS-backed formal project data and would reintroduce remote write latency and cleanup races.
- **ALT-003**: Generate provider-specific MCP files for Generic ACP providers. Rejected because ACP already has a normalized `session/new.mcpServers` contract and duplicate configuration can diverge.
- **ALT-004**: Share one mutable skills directory across runs. Rejected because concurrent runs can select different versions or content for the same skill slug.

## 4. Dependencies

- **DEP-001**: Existing `resolveTempDir` logic defines VM and non-VM runtime temp selection using run environment variables followed by process environment and the OS temp directory.
- **DEP-002**: Existing `materializeSkillsIntoRoot` enforces safe paths, no symlink traversal, stable skill slugs, and per-root reset semantics.
- **DEP-003**: Existing ACP transport delivers MCP servers through `session/new` and owns the child process lifecycle.

## 5. Files

- **FILE-001**: `src/providers/run-workspace.ts` — internal provider preparation and cleanup lifecycle.
- **FILE-002**: `src/providers/generic-acp/provider.ts` — Generic ACP skill delivery and run cleanup.
- **FILE-003**: `src/providers/codex/index.ts` — Codex and Tutti Agent duplicate preparation and marker ownership.
- **FILE-004**: `tests/providers/acp-providers.test.ts` — Generic ACP, Cursor, and OpenCode launch-plan/lifecycle tests.
- **FILE-005**: `tests/providers/codex-launch-plan.test.ts` — Codex-compatible concurrency and cleanup tests.
- **FILE-006**: `README.md` — provider storage and skill-delivery behavior.
- **FILE-007**: `src/transports/acp/acp-client.ts` — ACP MCP forwarding, tool-event projection, and completed-turn child reclamation.

## 6. Testing

- **TEST-001**: Verify materialized skills are written below explicit `TMPDIR`, referenced by prompt, and absent from `cwd` for Cursor and OpenCode.
- **TEST-002**: Verify prompt-injection and project-instructions skills are included without filesystem writes.
- **TEST-003**: Verify ACP MCP configs remain in the launch plan and `session/new` while no generated MCP config file exists.
- **TEST-004**: Verify direct run, adapter completion, preparation failure, and duplicate `runId` paths remove all run-scoped directories.
- **TEST-005**: Verify Codex and Tutti Agent reject duplicate preparation and adapter reuse without deleting another run's artifacts.
- **TEST-006**: Verify the complete package test, build, pack, and packed-consumer commands pass.
- **TEST-007**: Start a real stdio MCP server and require installed provider CLIs to discover and invoke its `validation_echo` tool, return a run-unique marker, and leave no run temp artifacts.
- **TEST-008**: Verify a long-lived ACP peer is reclaimed after `session/prompt` acknowledges completion and a wrapper-style exit code 143 is normalized as a completed client shutdown.

Validation record from 2026-07-17:

| Provider | Executable detection | Real ACP run | Isolation result |
|----------|----------------------|--------------|------------------|
| Cursor | Supported; 7.55 seconds; live model catalog returned | `ACP_OK`; 13.82 seconds on the final run; one preceding 45-second provider timeout was retried | Project cwd unchanged; runtime root empty after completion and timeout |
| OpenCode | Supported; 0.87 seconds; default model returned | `ACP_OK`; 10.08 seconds on the final run | Project cwd unchanged; runtime root empty after completion |

Materialized-skill read validation used a random marker available only inside
the generated `SKILL.md`. OpenCode read and returned the marker in 14.64
seconds. Cursor read and returned the marker in 24.12 seconds but prefixed one
explanatory sentence despite the exact-output instruction. Both providers used
file tools successfully and left the project cwd and runtime root empty.
The same validation exposed standard ACP `tool_call_update` events being
projected as duplicate anonymous calls. The transport now coalesces each
`toolCallId` into one named call and one terminal result. Final live validation
produced `read`/`completed` call-result pairs for both Cursor and OpenCode.

Real stdio MCP validation used a local `validation_echo` server whose marker
was available only from `tools/call`. The audit file proved that each passing
provider invoked the tool with `{ value: "probe" }`; matching assistant text
alone was not considered sufficient evidence.

| Provider | Real MCP result | Final duration | Cleanup/result |
|----------|-----------------|----------------|----------------|
| Claude | Passed: config materialization, tool discovery, call, and result | 25.35 seconds | Completed; cwd and runtime temp empty |
| Codex | Passed: TOML config, tool discovery, call, and result | 48.89 seconds | Completed; only the intentional cwd root marker remains; runtime temp empty |
| Cursor | Passed: ACP `session/new`, discovery, call, and result | 27.25 seconds | Completed; long-lived ACP peer reclaimed; cwd and runtime temp empty |
| OpenCode | Passed: ACP `session/new`, discovery, call, and result | 9.84 seconds | Completed; cwd and runtime temp empty |
| Tutti Agent | Not completed: CLI returned `ACC_SESSION_EXPIRED` before the model could invoke MCP | N/A | MCP config generation is covered deterministically; live call requires renewed user login |
| Other Generic ACP presets | Deterministic transport/config/cleanup coverage only | N/A | Live MCP calls require each optional CLI and its credentials |

The Cursor validation originally completed the MCP call but left its ACP
server running until the process watchdog. ACP peers are long-lived servers,
so the transport now treats the successful `session/prompt` response as the
turn boundary, drains queued notifications, and reclaims the child. Codex now
sets `TMPDIR`, `TEMP`, and `TMP` to `CODEX_HOME/tmp` inside the run home, so
provider/MCP scratch files are deleted by the same lifecycle cleanup.

## 7. Risks & Assumptions

- **RISK-001**: Some ACP providers may ignore prompt-referenced skill paths. Mitigation: keep prompt-injected content supported and validate representative Cursor/OpenCode ACP sessions.
- **RISK-002**: Cleanup after abrupt process termination cannot execute in-process finally blocks. Mitigation: use isolated temp roots with no formal-data impact and allow OS/runtime temp reclamation.
- **RISK-003**: Removing Codex project markers can change root discovery. Mitigation: retain marker semantics unless tests prove config-only markers are sufficient.
- **ASSUMPTION-001**: Provider child processes can read the resolved runtime temp directory using the same workspace-session user identity.
- **ASSUMPTION-002**: Cursor and OpenCode implement ACP `session/new` with the normalized MCP and cwd fields already used by `runAcpTransport`.

## 8. Related Specifications / Further Reading

[Agent package coding guide](../AGENTS.md)

[Public provider integration guide](../README.md)
