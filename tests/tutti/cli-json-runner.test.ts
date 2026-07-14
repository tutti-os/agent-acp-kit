import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  hasConfiguredTuttiCli,
  runTuttiCliJson,
} from "../../src/tutti/cli-json-runner.js";
import {
  projectTuttiCliChildProcess,
  redactTuttiCliChildProcessText,
} from "../../src/tutti/index.js";

const cleanup: string[] = [];

async function executable(source: string) {
  const dir = await mkdtemp(join(tmpdir(), "agent-acp-kit-tutti-cli-"));
  cleanup.push(dir);
  const file = join(dir, "tutti-test");
  await writeFile(file, `#!/usr/bin/env node\n${source}\n`, "utf8");
  await chmod(file, 0o755);
  return file;
}

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(cleanup.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runTuttiCliJson", () => {
  it("executes argv without a shell and parses JSON", async () => {
    const command = await executable(
      `process.stdout.write(JSON.stringify({ argv: process.argv.slice(2) }));`,
    );
    await expect(
      runTuttiCliJson({ command, args: ["--json", "agent", "providers"] }),
    ).resolves.toEqual({ argv: ["--json", "agent", "providers"] });
  });

  it("projects request-scoped credential only into the immediate child", async () => {
    const command = await executable(`process.stdout.write(JSON.stringify({
      base: process.env.BASE_VALUE,
      canonical: process.env.TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL,
      legacy: process.env.TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL,
    }));`);
    const baseEnv = {
      PATH: process.env.PATH,
      BASE_VALUE: "base",
      TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL: "ambient-canonical",
      TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL: "ambient-legacy",
    };
    const detectContext = {
      managedAgentInvocation: { credential: "request-secret", cwd: "/workspace" },
      redactionSecrets: ["existing-secret"],
    };

    await expect(runTuttiCliJson({
      command,
      args: [],
      env: baseEnv,
      detectContext,
    })).resolves.toEqual({
      base: "base",
      legacy: "request-secret",
    });
    expect(baseEnv.TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL).toBe(
      "ambient-canonical",
    );
    expect(baseEnv.TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL).toBe(
      "ambient-legacy",
    );
  });

  it("inherits host env for managed requests with a partial context env", async () => {
    const command = await executable(`process.stdout.write(JSON.stringify({
      command: process.env.TUTTI_CLI,
      workspace: process.env.TSH_WORKSPACE_ID,
      appData: process.env.TUTTI_APP_DATA_DIR,
      credential: process.env.TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL,
    }));`);
    vi.stubEnv("TUTTI_CLI", command);
    vi.stubEnv("TSH_WORKSPACE_ID", "workspace-1");
    const detectContext = {
      env: { TUTTI_APP_DATA_DIR: "/tmp/aimc-app-data" },
      managedAgentInvocation: {
        credential: "request-secret",
        cwd: "/tmp/aimc-app-data",
      },
    };

    expect(hasConfiguredTuttiCli({
      detectContext,
      env: detectContext.env,
    })).toBe(true);
    await expect(runTuttiCliJson({
      args: [],
      detectContext,
      env: detectContext.env,
    })).resolves.toEqual({
      command,
      workspace: "workspace-1",
      appData: "/tmp/aimc-app-data",
      credential: "request-secret",
    });
  });

  it("keeps explicit env authoritative for non-managed requests", () => {
    vi.stubEnv("TUTTI_CLI", "/ambient/tutti");
    expect(hasConfiguredTuttiCli({ env: {} })).toBe(false);
  });

  it("returns an immutable env and merged redaction secrets", () => {
    const baseEnv = { BASE_VALUE: "base" };
    const projection = projectTuttiCliChildProcess({
      baseEnv,
      detectContext: {
        managedAgentInvocation: { credential: "request-secret", cwd: "/workspace" },
        redactionSecrets: ["existing-secret", "request-secret"],
      },
    });

    expect(projection.env).toEqual({
      BASE_VALUE: "base",
      TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL: "request-secret",
    });
    expect(projection.redactionSecrets).toEqual(["existing-secret", "request-secret"]);
    expect(Object.isFrozen(projection)).toBe(true);
    expect(Object.isFrozen(projection.env)).toBe(true);
    expect(Object.isFrozen(projection.redactionSecrets)).toBe(true);
    expect(baseEnv).toEqual({ BASE_VALUE: "base" });
    expect(
      redactTuttiCliChildProcessText(
        "credential=request-secret",
        projection.redactionSecrets,
      ),
    ).toBe("credential=[REDACTED]");
    expect(
      redactTuttiCliChildProcessText("token-long-secret", ["secret", "long-secret"]),
    ).toBe("token-[REDACTED]");
  });

  it("sanitizes ambient credentials for a custom runner without context", async () => {
    await runTuttiCliJson({
      args: [],
      env: {
        TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL: "ambient-canonical",
        TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL: "ambient-legacy",
      },
      runTuttiCli: async (_args, options) => {
        expect(options.env).not.toHaveProperty(
          "TSH_REVERSE_CAPABILITY_INVOCATION_CREDENTIAL",
        );
        expect(options.env).not.toHaveProperty(
          "TSH_MANAGED_AGENT_INVOCATION_CREDENTIAL",
        );
        expect(options.redactionSecrets).toEqual([]);
        return {};
      },
    });
  });

  it("classifies timeout and abort without exposing request credentials", async () => {
    const command = await executable(
      `process.stderr.write("managed-secret"); setInterval(() => {}, 1000);`,
    );
    const diagnosticsContext = {
      managedAgentInvocation: { credential: "managed-secret", cwd: "/workspace" },
    };
    const timeout = await runTuttiCliJson({
      command,
      args: [],
      timeoutMs: 20,
      detectContext: diagnosticsContext,
    }).catch((error) => error);
    expect(timeout).toMatchObject({ code: "cli_timeout" });
    expect(String(timeout)).not.toContain("managed-secret");
    expect(timeout.details).toMatchObject({ stderrBytes: expect.any(Number) });
    expect(timeout.cause).toBeUndefined();

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await runTuttiCliJson({
      command,
      args: [],
      signal: controller.signal,
      timeoutMs: 5_000,
      detectContext: diagnosticsContext,
    }).catch((error) => error);
    expect(aborted).toMatchObject({ code: "cli_aborted" });
    expect(String(aborted)).not.toContain("managed-secret");
    expect(aborted.details).toMatchObject({ stderrBytes: expect.any(Number) });
    expect(aborted.cause).toBeUndefined();

    const failed = await runTuttiCliJson({
      args: [],
      runTuttiCli: async () => {
        throw new Error("managed-secret");
      },
    }).catch((error) => error);
    expect(failed).toMatchObject({ code: "cli_execution_failed" });
    expect(failed.cause).toBeUndefined();
  });

  it("keeps non-secret CLI stderr in failure diagnostics", async () => {
    const command = await executable(
      `process.stderr.write("app-cli returned 502\\n"); process.exit(1);`,
    );
    const error = await runTuttiCliJson({ command, args: [] }).catch((candidate) => candidate);

    expect(error).toMatchObject({
      code: "cli_execution_failed",
      details: {
        exitCode: 1,
        stderr: "app-cli returned 502\n",
      },
    });
  });

  it("redacts managed credentials from CLI stderr diagnostics", async () => {
    const credential = "request-secret-stderr";
    const command = await executable(
      `process.stderr.write(${JSON.stringify(`app-cli failed credential=${credential}`)}); process.exit(1);`,
    );
    const error = await runTuttiCliJson({
      command,
      args: [],
      detectContext: { managedAgentInvocation: { credential, cwd: "/workspace" } },
    }).catch((candidate) => candidate);

    expect(error).toMatchObject({
      code: "cli_execution_failed",
      details: { stderr: "app-cli failed credential=[REDACTED]" },
    });
    expect(JSON.stringify(error)).not.toContain(credential);
  });

  it("classifies malformed JSON", async () => {
    const command = await executable(`process.stdout.write("not-json");`);
    await expect(runTuttiCliJson({ command, args: [] })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });

  it("does not expose credential text from malformed CLI output", async () => {
    const credential = "request-secret-malformed-json";
    const command = await executable(`process.stdout.write(${JSON.stringify(credential)});`);
    const error = await runTuttiCliJson({
      command,
      args: [],
      detectContext: {
        managedAgentInvocation: { credential, cwd: "/workspace" },
        redactionSecrets: [credential],
      },
    }).catch((candidate) => candidate);

    expect(error).toMatchObject({ code: "invalid_response", details: {} });
    expect(error.cause).toBeUndefined();
    expect(JSON.stringify(error)).not.toContain(credential);
    expect(String(error)).not.toContain(credential);
  });
});
