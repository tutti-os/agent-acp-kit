import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { runTuttiCliJson } from "../../src/tutti/cli-json-runner.js";

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

  it("classifies timeout and abort without exposing process output", async () => {
    const command = await executable(
      `process.stderr.write("managed-secret"); setInterval(() => {}, 1000);`,
    );
    const timeout = await runTuttiCliJson({ command, args: [], timeoutMs: 20 })
      .catch((error) => error);
    expect(timeout).toMatchObject({ code: "cli_timeout" });
    expect(String(timeout)).not.toContain("managed-secret");

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 20);
    const aborted = await runTuttiCliJson({
      command,
      args: [],
      signal: controller.signal,
      timeoutMs: 5_000,
    }).catch((error) => error);
    expect(aborted).toMatchObject({ code: "cli_aborted" });
    expect(String(aborted)).not.toContain("managed-secret");
  });

  it("classifies malformed JSON", async () => {
    const command = await executable(`process.stdout.write("not-json");`);
    await expect(runTuttiCliJson({ command, args: [] })).rejects.toMatchObject({
      code: "invalid_response",
    });
  });
});
