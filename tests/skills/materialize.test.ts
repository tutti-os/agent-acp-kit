import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";

import { materializeSkills } from "../../src/skills/materialize.js";

const tempDirs: string[] = [];

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true });
  }
});

describe("materializeSkills", () => {
  it("rejects skill roots outside the run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(cwd, [
        {
          slug: "escape",
          deliveryMode: "materialized-files",
          materializedPath: "../escape",
          content: "# Escape",
        },
      ]),
    ).rejects.toThrow("escapes run directory");
  });

  it("rejects skill files outside the materialized skill root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(cwd, [
        {
          slug: "escape-file",
          deliveryMode: "materialized-files",
          content: "# Escape File",
          files: [{ path: "../escape.txt", content: "nope" }],
        },
      ]),
    ).rejects.toThrow("escapes run directory");
  });
});
