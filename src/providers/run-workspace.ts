import { mkdir, mkdtemp } from "node:fs/promises";
import { join } from "node:path";

import { resolveTempDir } from "../process/env.js";
import { cleanupPaths } from "../skills/cleanup.js";

type ProviderRunWorkspace = {
  getRoot(): Promise<string>;
  track(path: string): void;
};

function safePrefix(value: string) {
  const normalized = value
    .toLowerCase()
    .replaceAll(/[^a-z0-9._-]+/g, "-")
    .replaceAll(/^-+|-+$/g, "");
  return normalized || "provider";
}

/**
 * Owns provider-generated, run-scoped files without changing the application
 * cwd or the provider's authentication home. Roots are lazy so prompt-only
 * providers do not pay for filesystem preparation.
 */
export function createProviderRunWorkspaceManager(
  providerId: string,
  options: { rootKind?: string } = {},
) {
  const preparingRunIds = new Set<string>();
  const cleanupByRunId = new Map<string, string[]>();
  const prefix = `agent-acp-kit-${safePrefix(providerId)}-${safePrefix(options.rootKind ?? "run")}-`;

  async function prepare<T>(
    runId: string,
    env: Record<string, string> | undefined,
    prepareRun: (workspace: ProviderRunWorkspace) => Promise<T>,
  ): Promise<T> {
    if (preparingRunIds.has(runId) || cleanupByRunId.has(runId)) {
      throw new Error(`Provider run ${runId} is already prepared.`);
    }
    preparingRunIds.add(runId);

    const cleanupTargets: string[] = [];
    let rootPromise: Promise<string> | undefined;
    const workspace: ProviderRunWorkspace = {
      getRoot() {
        rootPromise ??= (async () => {
          const tempRoot = resolveTempDir(env);
          await mkdir(tempRoot, { recursive: true });
          const root = await mkdtemp(join(tempRoot, prefix));
          cleanupTargets.push(root);
          return root;
        })();
        return rootPromise;
      },
      track(path) {
        if (!cleanupTargets.includes(path)) cleanupTargets.push(path);
      },
    };

    try {
      const result = await prepareRun(workspace);
      if (cleanupTargets.length > 0) {
        cleanupByRunId.set(runId, [...cleanupTargets]);
      }
      return result;
    } catch (error) {
      await Promise.allSettled(rootPromise ? [rootPromise] : []);
      await cleanupPaths(cleanupTargets);
      throw error;
    } finally {
      preparingRunIds.delete(runId);
    }
  }

  async function cleanup(runId: string) {
    const cleanupTargets = cleanupByRunId.get(runId) ?? [];
    cleanupByRunId.delete(runId);
    await cleanupPaths(cleanupTargets);
  }

  return { cleanup, prepare };
}
