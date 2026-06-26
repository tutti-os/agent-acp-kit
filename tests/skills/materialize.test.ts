import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
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
  it("uses a run-scoped default skill directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    const [skill] = await materializeSkills(
      cwd,
      [
        {
          slug: "tutti-cli",
          skillId: "tutti/tutti-cli",
          deliveryMode: "materialized-files",
          content: "# Tutti CLI",
        },
      ],
      "run/one",
    );

    expect(skill.materializedPath).toBe(
      join(cwd, ".local-agent", "runs", "run-one", "skills", "tutti-cli"),
    );
    await expect(
      readFile(join(skill.materializedPath!, "SKILL.md"), "utf8"),
    ).resolves.toBe("# Tutti CLI");
  });

  it("rejects skill roots outside the run directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(cwd, [
        {
          slug: "escape",
          skillId: "test/escape",
          deliveryMode: "materialized-files",
          materializedPath: "../escape",
          content: "# Escape",
        },
      ]),
    ).rejects.toThrow("escapes run directory");
  });

  it("rejects explicit skill roots outside the package run skill directory", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(
        cwd,
        [
          {
            slug: "workspace-root",
            skillId: "test/workspace-root",
            deliveryMode: "materialized-files",
            materializedPath: ".",
            content: "# Workspace Root",
          },
        ],
        "run-1",
      ),
    ).rejects.toThrow("escapes run directory");
  });

  it("rejects duplicate materialization roots after path sanitization", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(
        cwd,
        [
          {
            slug: "foo/bar",
            skillId: "test/foo-bar-one",
            deliveryMode: "materialized-files",
            content: "# One",
          },
          {
            slug: "foo-bar",
            skillId: "test/foo-bar-two",
            deliveryMode: "materialized-files",
            content: "# Two",
          },
        ],
        "run-1",
      ),
    ).rejects.toThrow("Duplicate skill materialization path");
  });

  it("clears stale files before rewriting a materialized skill root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    const [first] = await materializeSkills(
      cwd,
      [
        {
          slug: "tutti-cli",
          skillId: "tutti/tutti-cli",
          deliveryMode: "materialized-files",
          content: "# First",
          files: [{ path: "old.txt", content: "old" }],
        },
      ],
      "run-1",
    );
    await expect(
      readFile(join(first.materializedPath!, "old.txt"), "utf8"),
    ).resolves.toBe("old");

    const [second] = await materializeSkills(
      cwd,
      [
        {
          slug: "tutti-cli",
          skillId: "tutti/tutti-cli",
          deliveryMode: "materialized-files",
          content: "# Second",
        },
      ],
      "run-1",
    );

    expect(second.materializedPath).toBe(first.materializedPath);
    await expect(
      readFile(join(second.materializedPath!, "SKILL.md"), "utf8"),
    ).resolves.toBe("# Second");
    await expect(
      readFile(join(second.materializedPath!, "old.txt"), "utf8"),
    ).rejects.toThrow();
  });

  it("rejects symlinks in the materialized skill path", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    const outside = await mkdtemp(join(tmpdir(), "agent-acp-kit-outside-"));
    tempDirs.push(cwd, outside);
    await mkdir(join(cwd, ".local-agent"));
    await symlink(outside, join(cwd, ".local-agent", "runs"));

    await expect(
      materializeSkills(
        cwd,
        [
          {
            slug: "tutti-cli",
            skillId: "tutti/tutti-cli",
            deliveryMode: "materialized-files",
            content: "# Tutti CLI",
          },
        ],
        "run-1",
      ),
    ).rejects.toThrow("includes symlink");
    await expect(readFile(join(outside, "run-1", "skills", "tutti-cli", "SKILL.md"), "utf8")).rejects.toThrow();
  });

  it("rejects skill files outside the materialized skill root", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "agent-acp-kit-skills-"));
    tempDirs.push(cwd);

    await expect(
      materializeSkills(cwd, [
        {
          slug: "escape-file",
          skillId: "test/escape-file",
          deliveryMode: "materialized-files",
          content: "# Escape File",
          files: [{ path: "../escape.txt", content: "nope" }],
        },
      ]),
    ).rejects.toThrow("escapes run directory");
  });
});
