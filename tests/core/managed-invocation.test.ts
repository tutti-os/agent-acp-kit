import { describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV,
  MANAGED_AGENT_INVOCATION_PROVIDER_IDS,
  applyManagedAgentInvocationToLaunchPlan,
  isManagedAgentInvocationCwd,
  isManagedAgentInvocationProviderId,
} from "../../src/core/managed-invocation.js";

describe("managed agent invocation", () => {
  it("limits managed invocation providers to codex, claude, and nexight", () => {
    expect(MANAGED_AGENT_INVOCATION_PROVIDER_IDS).toEqual([
      "codex",
      "claude",
      "nexight",
    ]);
    expect(isManagedAgentInvocationProviderId("codex")).toBe(true);
    expect(isManagedAgentInvocationProviderId("claude")).toBe(true);
    expect(isManagedAgentInvocationProviderId("nexight")).toBe(true);
    expect(isManagedAgentInvocationProviderId("nextop")).toBe(false);
  });

  it("requires managed cwd to be /workspace or below it", () => {
    expect(isManagedAgentInvocationCwd("/workspace")).toBe(true);
    expect(isManagedAgentInvocationCwd("/workspace/project")).toBe(true);
    expect(isManagedAgentInvocationCwd("/workspace/../tmp")).toBe(false);
    expect(isManagedAgentInvocationCwd("/workspace-other")).toBe(false);

    expect(() =>
      applyManagedAgentInvocationToLaunchPlan(
        "codex",
        {
          args: [],
          command: "codex",
          cwd: "/tmp/project",
          prompt: "hello",
          promptInput: "stdin",
        },
        { credential: "secret", cwd: "/tmp/project" },
      ),
    ).toThrow(/cwd must be \/workspace/);
  });

  it("injects credential, cwd, redaction, and fallback plans without mutation", () => {
    const plan = {
      args: ["exec"],
      command: "codex",
      cwd: "/tmp/project",
      env: { KEEP: "1" },
      fallbackPlan: {
        args: ["exec"],
        command: "codex",
        cwd: "/tmp/fallback",
        prompt: "hello",
        promptInput: "stdin" as const,
      },
      prompt: "hello",
      promptInput: "stdin" as const,
      redactionSecrets: ["existing-secret"],
    };

    const managed = applyManagedAgentInvocationToLaunchPlan(
      "codex",
      plan,
      { credential: "managed-secret", cwd: "/workspace/project" },
    );

    expect(managed).toMatchObject({
      cwd: "/workspace/project",
      env: {
        KEEP: "1",
        [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-secret",
      },
      fallbackPlan: {
        cwd: "/workspace/project",
        env: {
          [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-secret",
        },
      },
      redactionSecrets: ["existing-secret", "managed-secret"],
    });
    expect(plan.cwd).toBe("/tmp/project");
    expect(plan.env).toEqual({ KEEP: "1" });
    expect(process.env[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]).not.toBe(
      "managed-secret",
    );
  });
});
