import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { SkillMaterializationRecord } from "../core/skills.js";

const maxPathSegmentLength = 128;

function assertInside(baseDir: string, targetPath: string) {
  const relativePath = relative(baseDir, targetPath);
  if (
    relativePath.startsWith("..") ||
    relativePath === ".." ||
    relativePath.length === 0 && targetPath !== baseDir
  ) {
    throw new Error(`Skill materialization path escapes run directory: ${targetPath}`);
  }
}

function assertInsideStrict(baseDir: string, targetPath: string) {
  const relativePath = relative(baseDir, targetPath);
  if (
    relativePath.length === 0 ||
    relativePath.startsWith("..") ||
    relativePath === ".."
  ) {
    throw new Error(`Skill materialization path escapes run directory: ${targetPath}`);
  }
}

function safePathSegment(value: string | undefined, fallback: string) {
  const trimmed = value?.trim() ?? "";
  const normalized = trimmed
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^\.+$/, "")
    .replace(/^-+|-+$/g, "");
  return (normalized || fallback).slice(0, maxPathSegmentLength);
}

async function assertNotSymlink(path: string) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill materialization path includes symlink: ${path}`);
    }
    return stat;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function ensureDirectoryNoSymlink(baseDir: string, targetDir: string) {
  assertInside(baseDir, targetDir);
  const relativePath = relative(baseDir, targetDir);
  if (!relativePath) {
    await assertNotSymlink(baseDir);
    return;
  }

  let current = baseDir;
  for (const segment of relativePath.split(/[\\/]+/).filter(Boolean)) {
    current = join(current, segment);
    const stat = await assertNotSymlink(current);
    if (!stat) {
      await mkdir(current);
      continue;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Skill materialization path is not a directory: ${current}`);
    }
  }
}

async function resetSkillRoot(runRoot: string, rootPath: string) {
  await ensureDirectoryNoSymlink(runRoot, dirname(rootPath));
  const stat = await assertNotSymlink(rootPath);
  if (stat && !stat.isDirectory()) {
    throw new Error(`Skill materialization path is not a directory: ${rootPath}`);
  }
  if (stat) {
    await rm(rootPath, { recursive: true, force: true });
  }
  await mkdir(rootPath);
}

async function writeFileNoSymlink(path: string, content: string) {
  await assertNotSymlink(path);
  await writeFile(path, content, "utf8");
}

export async function materializeSkills(
  cwd: string,
  skills: SkillMaterializationRecord[],
  runId?: string,
) {
  const materialized: SkillMaterializationRecord[] = [];
  const runRoot = resolve(cwd);
  const runSegment = safePathSegment(runId, "run");
  const skillRootBase = resolve(
    runRoot,
    ".local-agent",
    "runs",
    runSegment,
    "skills",
  );
  const seenRoots = new Set<string>();

  for (const skill of skills) {
    if (skill.deliveryMode !== "materialized-files") {
      materialized.push(skill);
      continue;
    }

    const relativeRoot =
      skill.materializedPath ??
      join(".local-agent", "runs", runSegment, "skills", safePathSegment(skill.slug, "skill"));
    const rootPath = resolve(runRoot, relativeRoot);
    assertInside(runRoot, rootPath);
    assertInsideStrict(skillRootBase, rootPath);
    if (seenRoots.has(rootPath)) {
      throw new Error(`Duplicate skill materialization path: ${rootPath}`);
    }
    seenRoots.add(rootPath);
    await resetSkillRoot(runRoot, rootPath);

    const mainFilePath = join(rootPath, "SKILL.md");
    await writeFileNoSymlink(mainFilePath, skill.content ?? `# ${skill.slug}\n`);

    for (const file of skill.files ?? []) {
      const filePath = resolve(rootPath, file.path);
      assertInside(rootPath, filePath);
      await ensureDirectoryNoSymlink(rootPath, dirname(filePath));
      await writeFileNoSymlink(filePath, file.content);
    }

    materialized.push({
      ...skill,
      materializedPath: rootPath,
    });
  }

  return materialized;
}
