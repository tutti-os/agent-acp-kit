import { access } from "node:fs/promises";
import { accessSync, constants } from "node:fs";
import { delimiter, isAbsolute, join } from "node:path";

async function isExecutable(filePath: string) {
  try {
    await access(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isExecutableSync(filePath: string) {
  try {
    accessSync(filePath, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function getCandidates(input: {
  command: string;
  fallbackCommands?: string[];
}) {
  return [input.command, ...(input.fallbackCommands ?? [])];
}

export async function resolveCommandExecutable(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  fallbackCommands?: string[];
  overridePath?: string;
}) {
  if (input.overridePath) {
    return input.overridePath;
  }

  const commands = getCandidates(input);
  for (const command of commands) {
    if (isAbsolute(command) && (await isExecutable(command))) {
      return command;
    }

    const pathValue = input.env?.PATH ?? process.env.PATH ?? "";
    for (const part of pathValue.split(delimiter).filter(Boolean)) {
      const candidate = join(part, command);
      if (await isExecutable(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(
    `Executable not found on PATH: ${commands.join(", ")}`,
  );
}

export function resolveCommandExecutableSync(input: {
  command: string;
  env?: NodeJS.ProcessEnv;
  fallbackCommands?: string[];
  overridePath?: string;
}) {
  if (input.overridePath) {
    return input.overridePath;
  }

  const commands = getCandidates(input);
  for (const command of commands) {
    if (isAbsolute(command) && isExecutableSync(command)) {
      return command;
    }

    const pathValue = input.env?.PATH ?? process.env.PATH ?? "";
    for (const part of pathValue.split(delimiter).filter(Boolean)) {
      const candidate = join(part, command);
      if (isExecutableSync(candidate)) {
        return candidate;
      }
    }
  }

  throw new Error(`Executable not found on PATH: ${commands.join(", ")}`);
}
