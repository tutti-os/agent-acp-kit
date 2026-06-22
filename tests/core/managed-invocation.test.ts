import { describe, expect, it } from "vitest";

import {
  MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV,
  MANAGED_AGENT_MCP_ATTACHMENT_ENV,
  MANAGED_AGENT_INVOCATION_PROVIDER_IDS,
  applyManagedAgentInvocationToLaunchPlan,
  buildManagedAgentMcpAttachmentEnv,
  isManagedAgentInvocationCwd,
  isManagedAgentInvocationProviderId,
  prepareManagedAgentInvocationDetectContext,
} from "../../src/core/managed-invocation.js";

function decodeManagedMcpAttachment(value: string) {
  return JSON.parse(Buffer.from(value, "base64").toString("utf8"));
}

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

  it("builds managed MCP attachment env for sandbox-side stdio servers", () => {
    const attachment = buildManagedAgentMcpAttachmentEnv([
      {
        name: "aimc",
        type: "stdio",
        executionSide: "sandbox",
        command: process.execPath,
        args: ["/tmp/aimc-mcp.js"],
        env: { AIMC_TOOL_TOKEN: "aimc-token" },
        startupTimeoutMs: 120_000,
        toolTimeoutMs: 1_800_000,
      },
    ]);

    expect(attachment).toBeDefined();
    expect(decodeManagedMcpAttachment(attachment!.encoded)).toEqual({
      mcpServers: {
        aimc: {
          type: "stdio",
          executionSide: "sandbox",
          command: "node",
          args: ["/tmp/aimc-mcp.js"],
          env: { AIMC_TOOL_TOKEN: "aimc-token" },
          timeouts: {
            startupTimeoutMs: 120_000,
            toolTimeoutMs: 1_800_000,
          },
        },
      },
    });
    expect(attachment!.env[MANAGED_AGENT_MCP_ATTACHMENT_ENV]).toBe(
      attachment!.encoded,
    );
    expect(attachment!.redactionSecrets).toEqual([
      "aimc-token",
      attachment!.payload,
      attachment!.encoded,
    ]);
  });

  it("rejects managed MCP handoff configs outside v1 sandbox stdio scope", () => {
    expect(() =>
      buildManagedAgentMcpAttachmentEnv([
        {
          name: "missing-side",
          command: "node",
        },
      ]),
    ).toThrow(/executionSide: "sandbox"/);

    expect(() =>
      buildManagedAgentMcpAttachmentEnv([
        {
          name: "vm-side",
          command: "node",
          executionSide: "vm",
        },
      ]),
    ).toThrow(/executionSide: "sandbox"/);

    expect(() =>
      buildManagedAgentMcpAttachmentEnv([
        {
          name: "remote",
          type: "http",
          url: "https://example.com/mcp",
        },
      ]),
    ).toThrow(/supports only sandbox-side stdio/);

    expect(() =>
      buildManagedAgentMcpAttachmentEnv([
        {
          name: "unknown-node-path",
          command: "/tmp/node",
          executionSide: "sandbox",
        },
      ]),
    ).toThrow(/bare command name or a known absolute node path/);
  });

  it("moves managed MCP servers into launch env and redaction secrets", () => {
    const managed = applyManagedAgentInvocationToLaunchPlan(
      "codex",
      {
        args: [],
        command: "codex",
        cwd: "/tmp/project",
        env: { KEEP: "1" },
        fallbackPlan: {
          args: [],
          command: "codex",
          cwd: "/tmp/fallback",
          mcpServers: [
            {
              name: "aimc",
              command: "/usr/local/bin/node",
              args: ["/tmp/aimc-mcp.js"],
              executionSide: "sandbox",
              env: { AIMC_TOOL_TOKEN: "fallback-token" },
            },
          ],
          prompt: "hello",
          promptInput: "stdin",
        },
        mcpServers: [
          {
            name: "aimc",
            command: process.execPath,
            args: ["/tmp/aimc-mcp.js"],
            executionSide: "sandbox",
            env: { AIMC_TOOL_TOKEN: "tool-token" },
          },
        ],
        prompt: "hello",
        promptInput: "stdin",
        redactionSecrets: ["existing-secret"],
      },
      { credential: "managed-secret", cwd: "/workspace/project" },
    );

    const encoded = managed.env?.[MANAGED_AGENT_MCP_ATTACHMENT_ENV];
    expect(encoded).toBeTruthy();
    expect(decodeManagedMcpAttachment(encoded!)).toMatchObject({
      mcpServers: {
        aimc: {
          type: "stdio",
          executionSide: "sandbox",
          command: "node",
          env: { AIMC_TOOL_TOKEN: "tool-token" },
        },
      },
    });
    expect(decodeManagedMcpAttachment(encoded!)).not.toMatchObject({
      servers: expect.anything(),
    });
    expect(managed.mcpServers).toBeUndefined();
    expect(managed.env).toMatchObject({
      KEEP: "1",
      [MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]: "managed-secret",
      [MANAGED_AGENT_MCP_ATTACHMENT_ENV]: encoded,
    });
    expect(managed.redactionSecrets).toEqual([
      "existing-secret",
      "managed-secret",
      "tool-token",
      JSON.stringify(decodeManagedMcpAttachment(encoded!)),
      encoded,
    ]);
    const fallbackEncoded =
      managed.fallbackPlan?.env?.[MANAGED_AGENT_MCP_ATTACHMENT_ENV];
    expect(fallbackEncoded).toBeTruthy();
    expect(managed.fallbackPlan?.mcpServers).toBeUndefined();
    expect(decodeManagedMcpAttachment(fallbackEncoded!)).toMatchObject({
      mcpServers: {
        aimc: {
          command: "node",
          env: { AIMC_TOOL_TOKEN: "fallback-token" },
        },
      },
    });
  });

  it("adds managed credentials to detection redaction secrets", () => {
    const context = prepareManagedAgentInvocationDetectContext("nexight", {
      managedAgentInvocation: {
        credential: "managed-detect-secret",
        cwd: "/workspace/project",
      },
      redactionSecrets: ["existing-secret"],
    });

    expect(context).toMatchObject({
      cwd: "/workspace/project",
      redactionSecrets: ["existing-secret", "managed-detect-secret"],
    });
    expect(context?.env?.[MANAGED_AGENT_INVOCATION_CREDENTIAL_ENV]).toBe(
      "managed-detect-secret",
    );
  });
});
