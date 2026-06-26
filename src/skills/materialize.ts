import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";

import type { SkillMaterializationRecord } from "../core/skills.js";

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

export async function materializeSkills(
  cwd: string,
  skills: SkillMaterializationRecord[],
) {
  const materialized: SkillMaterializationRecord[] = [];
  const runRoot = resolve(cwd);

  for (const skill of skills) {
    if (skill.deliveryMode !== "materialized-files") {
      materialized.push(skill);
      continue;
    }

    const relativeRoot =
      skill.materializedPath ?? join(".local-agent", "skills", skill.slug);
    const rootPath = resolve(runRoot, relativeRoot);
    assertInside(runRoot, rootPath);
    await mkdir(rootPath, { recursive: true });

    const mainFilePath = join(rootPath, "SKILL.md");
    await writeFile(mainFilePath, skill.content ?? `# ${skill.slug}\n`, "utf8");

    for (const file of skill.files ?? []) {
      const filePath = resolve(rootPath, file.path);
      assertInside(rootPath, filePath);
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, file.content, "utf8");
    }

    materialized.push({
      ...skill,
      materializedPath: rootPath,
    });
  }

  return materialized;
}
