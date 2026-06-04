import { rm } from "node:fs/promises";

export async function cleanupPaths(paths: string[]) {
  await Promise.all(
    paths.map((path) => rm(path, { recursive: true, force: true }).catch(() => undefined)),
  );
}
