import { describe, expect, it } from "vitest";

import { normalizeMcpServerConfig } from "../../src/core/mcp.js";

describe("normalizeMcpServerConfig", () => {
  it("defaults run-scoped MCP tools to approve", () => {
    expect(
      normalizeMcpServerConfig({
        name: "app-tools",
        command: "node",
      }).defaultToolsApprovalMode,
    ).toBe("approve");
  });

  it("preserves an explicit approval policy", () => {
    expect(
      normalizeMcpServerConfig({
        name: "external-tools",
        command: "node",
        defaultToolsApprovalMode: "prompt",
      }).defaultToolsApprovalMode,
    ).toBe("prompt");
  });
});
