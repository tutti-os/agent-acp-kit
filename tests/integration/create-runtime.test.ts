import { describe, expect, it } from "vitest";

import {
  createRuntimeControlPlane,
  inferRuntimeKind,
} from "../../src/runtime/control-plane.js";
import { createFakeRuntimeProvider } from "../../src/testing/index.js";

describe("runtime control plane", () => {
  it("defaults to the single registered runtime when no selector is provided", () => {
    const controlPlane = createRuntimeControlPlane([
      createFakeRuntimeProvider({
        runtime: {
          id: "server-deepagent",
          kind: "server-deepagent",
          mode: "server",
          status: "online",
          capabilities: {
            cancel: true,
            nativeResume: false,
            streaming: true,
            toolGateway: false,
            maxConcurrentRuns: 8,
          },
        },
      }),
    ]);

    expect(
      controlPlane.resolveRuntimeTarget({
        model: "codex:gpt-5.4",
        requestedRuntimeKind: undefined,
      }),
    ).toEqual({ kind: "server-deepagent" });
  });

  it("returns the requested runtime kind before applying fallback inference", () => {
    expect(
      inferRuntimeKind({
        availableRuntimeTargets: [
          { kind: "server-deepagent" },
          { kind: "local-agent", provider: "codex" },
        ],
        model: "codex:gpt-5.4",
        requestedRuntimeKind: "local-agent",
        requestedRuntimeProvider: "codex",
      }),
    ).toEqual({ kind: "local-agent", provider: "codex" });
  });

  it("resolves declared legacy provider aliases to the canonical runtime target", () => {
    const provider = createFakeRuntimeProvider({
      runtime: {
        id: "local-agent:claude-code",
        kind: "local-agent",
        provider: "claude-code",
        mode: "local",
        status: "online",
        capabilities: {
          cancel: true,
          nativeResume: true,
          streaming: true,
          toolGateway: true,
          maxConcurrentRuns: 1,
        },
      },
    });
    provider.aliases = ["claude"];
    const controlPlane = createRuntimeControlPlane([provider]);

    expect(
      controlPlane.resolveRuntimeTarget({
        model: "claude:default",
        requestedRuntimeKind: "local-agent",
        requestedRuntimeProvider: "claude",
      }),
    ).toEqual({ kind: "local-agent", provider: "claude-code" });
  });
});
