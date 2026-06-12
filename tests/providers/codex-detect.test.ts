import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { detectCodex } from "../../src/providers/codex/detect.js";

describe("detectCodex", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    while (tempDirs.length > 0) {
      rmSync(tempDirs.pop()!, { recursive: true, force: true });
    }
  });

  it("reports unsupported when the Codex CLI is not installed", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-missing-"));
    tempDirs.push(dir);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection).toMatchObject({
      authState: "missing",
      executablePath: "codex",
      supported: false,
      version: "not-installed",
    });
    expect(detection.unsupportedReason).toContain("Executable not found");
    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
    ]);
  });

  it("returns config and skills directories from CODEX_HOME", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-detect-"));
    tempDirs.push(dir);
    const codexBin = join(dir, "codex");
    writeFileSync(
      codexBin,
      "#!/bin/sh\nif [ \"$1\" = \"--version\" ]; then echo \"codex 1.2.3\"; exit 0; fi\nexit 1\n",
    );
    chmodSync(codexBin, 0o755);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection).toMatchObject({
      executablePath: codexBin,
      version: "codex 1.2.3",
      configDir: join(dir, ".codex-home"),
      skillsDir: join(dir, ".codex-home", "skills"),
      supported: true,
    });
  });

  it("discovers Codex models from the debug catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-models-"));
    tempDirs.push(dir);
    const codexBin = join(dir, "codex");
    writeFileSync(
      codexBin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "models" ]; then
  printf '%s\\n' '{"models":[{"slug":"gpt-live","display_name":"GPT Live","visibility":"list"},{"slug":"codex-hidden","display_name":"Hidden","visibility":"hide"}]}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(codexBin, 0o755);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "gpt-live", label: "GPT Live" },
    ]);
  });

  it("prefers Codex app-server model/list over the debug catalog", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-app-server-"));
    tempDirs.push(dir);
    const codexBin = join(dir, "codex");
    writeFileSync(
      codexBin,
      `#!${process.execPath}
const readline = require("node:readline");
if (process.argv[2] === "--version") {
  console.log("codex 1.2.3");
  process.exit(0);
}
if (process.argv[2] === "app-server") {
  const rl = readline.createInterface({ input: process.stdin });
  rl.on("line", (line) => {
    const message = JSON.parse(line);
    if (message.method === "initialize") {
      console.log(JSON.stringify({ id: message.id, result: {} }));
    } else if (message.method === "model/list") {
      console.log(JSON.stringify({
        id: message.id,
        result: {
          data: [
            { id: "gpt-5.5", displayName: "GPT-5.5", description: "Frontier", hidden: false },
            { id: "gpt-5.4", displayName: "GPT-5.4", hidden: false },
            { id: "hidden", displayName: "Hidden", hidden: true }
          ]
        }
      }));
      process.exit(0);
    }
  });
} else if (process.argv[2] === "debug" && process.argv[3] === "models") {
  console.log(JSON.stringify({ models: [{ slug: "debug-only", display_name: "Debug Only" }] }));
} else {
  process.exit(1);
}
`,
    );
    chmodSync(codexBin, 0o755);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
      { id: "gpt-5.5", label: "GPT-5.5", description: "Frontier" },
      { id: "gpt-5.4", label: "GPT-5.4" },
    ]);
  });

  it("does not expose bundled Codex catalog entries when refreshed discovery fails", async () => {
    const dir = mkdtempSync(join(tmpdir(), "agent-acp-kit-codex-bundled-models-"));
    tempDirs.push(dir);
    const codexBin = join(dir, "codex");
    writeFileSync(
      codexBin,
      `#!/bin/sh
if [ "$1" = "--version" ]; then echo "codex 1.2.3"; exit 0; fi
if [ "$1" = "debug" ] && [ "$2" = "models" ] && [ "$3" = "--bundled" ]; then
  printf '%s\\n' '{"models":[{"slug":"gpt-bundled","display_name":"GPT Bundled","visibility":"list"}]}'
  exit 0
fi
exit 1
`,
    );
    chmodSync(codexBin, 0o755);

    const detection = await detectCodex({
      env: { PATH: dir, CODEX_HOME: join(dir, ".codex-home") },
    });

    expect(detection.models).toEqual([
      { id: "default", label: "Default (CLI config)" },
    ]);
  });
});
