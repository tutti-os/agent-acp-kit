import { execFile } from "node:child_process";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { resolveCommandExecutable } from "../../process/command-resolver.js";
import { CLAUDE_FALLBACK_MODELS } from "./fallback-models.js";

const execFileAsync = promisify(execFile);

export async function detectClaude(options?: {
  command?: string;
  env?: NodeJS.ProcessEnv;
  overridePath?: string;
}) {
  const command = options?.command ?? "claude";
  const configDir = path.join(homedir(), ".claude");
  let executablePath: string;
  try {
    executablePath = await resolveCommandExecutable({
      command,
      ...(options?.env ? { env: options.env } : {}),
      fallbackCommands: ["openclaude"],
      ...(options?.overridePath ? { overridePath: options.overridePath } : {}),
    });
  } catch (error) {
    return {
      authState: "missing" as const,
      configDir,
      executablePath: command,
      models: CLAUDE_FALLBACK_MODELS,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? error.message
          : "Executable not found on PATH: claude, openclaude",
      version: "not-installed",
    };
  }

  let stdout: string;
  try {
    ({ stdout } = await execFileAsync(executablePath, ["--version"], {
      env: options?.env,
    }));
  } catch (error) {
    return {
      authState: "unknown" as const,
      configDir,
      executablePath,
      models: CLAUDE_FALLBACK_MODELS,
      skillsDir: path.join(configDir, "skills"),
      supported: false,
      unsupportedReason:
        error instanceof Error
          ? `Unable to run ${command} --version: ${error.message}`
          : `Unable to run ${command} --version`,
      version: "unknown",
    };
  }

  return {
    authState: "unknown" as const,
    configDir,
    executablePath,
    models: CLAUDE_FALLBACK_MODELS,
    skillsDir: path.join(configDir, "skills"),
    supported: true,
    version: stdout.trim() || "unknown",
  };
}
