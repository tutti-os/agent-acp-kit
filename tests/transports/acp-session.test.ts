import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildAcpSessionNewParams } from "../../src/transports/acp/acp-session.js";

describe("buildAcpSessionNewParams", () => {
  it("defaults to an empty mcp server list", () => {
    expect(buildAcpSessionNewParams("/tmp/project")).toEqual({
      cwd: path.resolve("/tmp/project"),
      mcpServers: [],
    });
  });

  it("normalizes stdio and http servers to ACP shape", () => {
    expect(
      buildAcpSessionNewParams("/tmp/project", {
        mcpServers: [
          {
            name: "toolbox",
            command: "node",
            args: ["mcp.js"],
            env: { TOKEN: "secret" },
          },
          {
            type: "http",
            name: "remote",
            url: "http://127.0.0.1:3000/mcp",
            headers: { Authorization: "Bearer x" },
            env: { MUST_NOT_REACH_ACP_HTTP: "secret" },
          },
        ],
      }),
    ).toEqual({
      cwd: path.resolve("/tmp/project"),
      mcpServers: [
        {
          type: "stdio",
          name: "toolbox",
          command: "node",
          args: ["mcp.js"],
          env: [{ name: "TOKEN", value: "secret" }],
        },
        {
          type: "http",
          name: "remote",
          url: "http://127.0.0.1:3000/mcp",
          headers: { Authorization: "Bearer x" },
        },
      ],
    });
  });

  it("does not emit provider-specific MCP timeouts into generic ACP session params", () => {
    expect(
      buildAcpSessionNewParams("/tmp/project", {
        mcpServers: [
          {
            name: "toolbox",
            command: "node",
            startupTimeoutMs: 120_000,
            toolTimeoutMs: 1_800_000,
          },
        ],
      }),
    ).toEqual({
      cwd: path.resolve("/tmp/project"),
      mcpServers: [
        {
          type: "stdio",
          name: "toolbox",
          command: "node",
          args: [],
          env: [],
        },
      ],
    });
  });
});
