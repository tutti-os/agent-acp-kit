import { createHash } from "node:crypto";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";

import type { SkillMaterializationRecord } from "../core/skills.js";

function assertInside(baseDir: string, targetPath: string) {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  const relativePath = relative(resolvedBase, resolvedTarget);
  if (
    relativePath.startsWith("..") ||
    relativePath === ".." ||
    relativePath.length === 0 && resolvedTarget !== resolvedBase
  ) {
    throw new Error(`Skill materialization path escapes run directory: ${targetPath}`);
  }
}

function assertStrictInside(baseDir: string, targetPath: string) {
  assertInside(baseDir, targetPath);
  if (resolve(baseDir) === resolve(targetPath)) {
    throw new Error(`Skill materialization path escapes run directory: ${targetPath}`);
  }
}

function safePathSegment(value: string | undefined, fallback: string) {
  const safe = (value ?? "")
    .trim()
    .replaceAll(/[^\w.-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  if (!safe || safe === "." || safe === "..") {
    return fallback;
  }
  return safe;
}

function stablePathSegment(value: string | undefined, fallback: string) {
  const raw = (value ?? "").trim();
  const safe = safePathSegment(raw, fallback);
  if (!raw || raw === safe) {
    return safe;
  }
  const hash = createHash("sha256").update(raw).digest("hex").slice(0, 8);
  return `${safe}-${hash}`;
}

async function assertNotSymlink(path: string) {
  try {
    const stat = await lstat(path);
    if (stat.isSymbolicLink()) {
      throw new Error(`Skill materialization path must not contain symlinks: ${path}`);
    }
  } catch (error) {
    if (
      error &&
      typeof error === "object" &&
      "code" in error &&
      error.code === "ENOENT"
    ) {
      return;
    }
    throw error;
  }
}

async function assertPathHasNoSymlinks(baseDir: string, targetPath: string) {
  const resolvedBase = resolve(baseDir);
  const resolvedTarget = resolve(targetPath);
  assertInside(resolvedBase, resolvedTarget);

  const relativePath = relative(resolvedBase, resolvedTarget);
  if (!relativePath) {
    await assertNotSymlink(resolvedTarget);
    return;
  }

  let current = resolvedBase;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    await assertNotSymlink(current);
  }
}

async function ensureDirectoryNoSymlink(path: string, baseDir: string) {
  const resolvedBase = resolve(baseDir);
  const resolvedPath = resolve(path);
  assertInside(resolvedBase, resolvedPath);

  const relativePath = relative(resolvedBase, resolvedPath);
  let current = resolvedBase;
  for (const part of relativePath.split(sep).filter(Boolean)) {
    current = join(current, part);
    await assertNotSymlink(current);
    await mkdir(current).catch((error: unknown) => {
      if (
        error &&
        typeof error === "object" &&
        "code" in error &&
        error.code === "EEXIST"
      ) {
        return;
      }
      throw error;
    });
    await assertNotSymlink(current);
  }
}

async function resetSkillRoot(path: string, baseDir: string) {
  await assertPathHasNoSymlinks(baseDir, path);
  await rm(path, { recursive: true, force: true });
  await ensureDirectoryNoSymlink(path, baseDir);
}

async function writeFileNoSymlink(path: string, content: string, baseDir: string) {
  const resolvedPath = resolve(path);
  assertInside(baseDir, resolvedPath);
  await ensureDirectoryNoSymlink(dirname(resolvedPath), baseDir);
  await assertNotSymlink(resolvedPath);
  await writeFile(resolvedPath, content, "utf8");
}

export async function materializeSkills(
  cwd: string,
  skills: SkillMaterializationRecord[],
  runId?: string,
) {
  const materialized: SkillMaterializationRecord[] = [];
  const runRoot = resolve(cwd);
  const defaultSkillRoot = join(
    runRoot,
    ".local-agent",
    "runs",
    stablePathSegment(runId, "run"),
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
      join(defaultSkillRoot, stablePathSegment(skill.slug, "skill"));
    const rootPath = resolve(runRoot, relativeRoot);
    assertStrictInside(runRoot, rootPath);
    if (seenRoots.has(rootPath)) {
      throw new Error(`Duplicate skill materialization path: ${rootPath}`);
    }
    seenRoots.add(rootPath);
    await resetSkillRoot(rootPath, runRoot);

    const mainFilePath = join(rootPath, "SKILL.md");
    await writeFileNoSymlink(
      mainFilePath,
      skill.content ?? `# ${skill.slug}\n`,
      rootPath,
    );

    for (const file of skill.files ?? []) {
      const filePath = resolve(rootPath, file.path);
      assertStrictInside(rootPath, filePath);
      await writeFileNoSymlink(filePath, file.content, rootPath);
    }

    materialized.push({
      ...skill,
      materializedPath: rootPath,
    });
  }

  return materialized;
}
