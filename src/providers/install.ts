import { spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { homedir, platform } from "node:os";
import path from "node:path";

import { resolveCommandExecutable } from "../process/command-resolver.js";

export type InstallableAgentProviderId = "codex" | "claude";

export type AgentProviderInstallAvailability =
  | "ready"
  | "not_installed"
  | "auth_required"
  | "unknown";

export type AgentProviderInstallReason =
  | "ready"
  | "cli_not_found"
  | "acp_adapter_not_found"
  | "auth_required"
  | "unknown";

export type AgentProviderInstallFailureReason =
  | "install_timed_out"
  | "install_canceled"
  | "install_start_failed"
  | "install_command_failed"
  | "post_install_probe_failed";

export type AgentProviderInstallSpec = {
  provider: InstallableAgentProviderId;
  displayName: string;
  cliBinary: string;
  adapterBinary: string;
  installCommand: string;
  adapterInstallCommand: string;
};

export type AgentProviderInstallStatus = {
  availability: AgentProviderInstallAvailability;
  reason: AgentProviderInstallReason;
  cli: {
    binary: string;
    installed: boolean;
    path?: string;
  };
  adapter: {
    binary: string;
    installed: boolean;
    path?: string;
  };
  auth: {
    ok: boolean;
    required: boolean;
  };
};

export type AgentProviderInstallCommandResult = {
  command: string;
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  canceled: boolean;
};

export type AgentProviderInstallResult = {
  provider: InstallableAgentProviderId;
  status: "succeeded" | "failed" | "skipped";
  command: string | null;
  before: AgentProviderInstallStatus;
  after: AgentProviderInstallStatus;
  failureReason?: AgentProviderInstallFailureReason;
  commandResult?: AgentProviderInstallCommandResult;
};

export type AgentProviderInstallOptions = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  timeoutMs?: number;
  commandRunner?: (
    command: string,
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      signal?: AbortSignal;
      timeoutMs: number;
    },
  ) => Promise<AgentProviderInstallCommandResult>;
};

const DEFAULT_INSTALL_TIMEOUT_MS = 5 * 60 * 1000;
const AUTH_CHECK_TIMEOUT_MS = 5_000;

export const AGENT_PROVIDER_INSTALL_SPECS = {
  codex: {
    provider: "codex",
    displayName: "Codex",
    cliBinary: "codex",
    adapterBinary: "codex-acp",
    installCommand: "npm install -g @openai/codex @zed-industries/codex-acp",
    adapterInstallCommand: "npm install -g @zed-industries/codex-acp",
  },
  claude: {
    provider: "claude",
    displayName: "Claude Code",
    cliBinary: "claude",
    adapterBinary: "claude-agent-acp",
    installCommand:
      "npm install -g @anthropic-ai/claude-code @agentclientprotocol/claude-agent-acp",
    adapterInstallCommand: "npm install -g @agentclientprotocol/claude-agent-acp",
  },
} as const satisfies Record<InstallableAgentProviderId, AgentProviderInstallSpec>;

async function findCommand(
  binary: string,
  env: NodeJS.ProcessEnv,
): Promise<string | undefined> {
  try {
    return await resolveCommandExecutable({ command: binary, env });
  } catch {
    return undefined;
  }
}

async function codexAuthOk(env: NodeJS.ProcessEnv) {
  const configDir = (env.CODEX_HOME || process.env.CODEX_HOME || "").trim()
    || path.join(homedir(), ".codex");
  try {
    await access(path.join(configDir, "auth.json"));
    return true;
  } catch {
    return false;
  }
}

async function runShortCommand(input: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}) {
  return new Promise<boolean>((resolve) => {
    const child = spawn(input.command, input.args, {
      env: input.env,
      stdio: ["ignore", "ignore", "ignore"],
    });
    const timeout = setTimeout(() => {
      if (!child.killed) child.kill("SIGTERM");
      resolve(false);
    }, input.timeoutMs);

    child.once("error", () => {
      clearTimeout(timeout);
      resolve(false);
    });
    child.once("close", (code) => {
      clearTimeout(timeout);
      resolve(code === 0);
    });
  });
}

async function providerAuthOk(
  provider: InstallableAgentProviderId,
  cliPath: string | undefined,
  env: NodeJS.ProcessEnv,
) {
  if (provider === "codex") return codexAuthOk(env);
  if (provider === "claude" && cliPath) {
    return runShortCommand({
      command: cliPath,
      args: ["auth", "status"],
      env,
      timeoutMs: AUTH_CHECK_TIMEOUT_MS,
    });
  }
  return false;
}

export async function getAgentProviderInstallStatus(
  provider: InstallableAgentProviderId,
  options: Pick<AgentProviderInstallOptions, "env"> = {},
): Promise<AgentProviderInstallStatus> {
  const spec = AGENT_PROVIDER_INSTALL_SPECS[provider];
  const env = { ...process.env, ...(options.env ?? {}) };
  const cliPath = await findCommand(spec.cliBinary, env);
  const adapterPath = await findCommand(spec.adapterBinary, env);
  const authOk = await providerAuthOk(provider, cliPath, env);

  if (!cliPath) {
    return {
      availability: "not_installed",
      reason: "cli_not_found",
      cli: { binary: spec.cliBinary, installed: false },
      adapter: {
        binary: spec.adapterBinary,
        installed: Boolean(adapterPath),
        ...(adapterPath ? { path: adapterPath } : {}),
      },
      auth: { ok: false, required: true },
    };
  }

  if (!adapterPath) {
    return {
      availability: "not_installed",
      reason: "acp_adapter_not_found",
      cli: { binary: spec.cliBinary, installed: true, path: cliPath },
      adapter: { binary: spec.adapterBinary, installed: false },
      auth: { ok: authOk, required: !authOk },
    };
  }

  if (!authOk) {
    return {
      availability: "auth_required",
      reason: "auth_required",
      cli: { binary: spec.cliBinary, installed: true, path: cliPath },
      adapter: { binary: spec.adapterBinary, installed: true, path: adapterPath },
      auth: { ok: false, required: true },
    };
  }

  return {
    availability: "ready",
    reason: "ready",
    cli: { binary: spec.cliBinary, installed: true, path: cliPath },
    adapter: { binary: spec.adapterBinary, installed: true, path: adapterPath },
    auth: { ok: true, required: false },
  };
}

function getShell(env: NodeJS.ProcessEnv) {
  if (platform() === "win32") {
    return {
      command: env.ComSpec || "cmd.exe",
      args: ["/C"] as string[],
    };
  }

  return {
    command: env.SHELL || "/bin/zsh",
    args: ["-lc"] as string[],
  };
}

export function runShellInstallCommand(
  command: string,
  options: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    signal?: AbortSignal;
    timeoutMs: number;
  },
): Promise<AgentProviderInstallCommandResult> {
  return new Promise((resolve, reject) => {
    const shell = getShell(options.env);
    const child = spawn(shell.command, [...shell.args, command], {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: string[] = [];
    const stderr: string[] = [];
    let timedOut = false;
    let canceled = false;
    let settled = false;

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => stdout.push(chunk));
    child.stderr.on("data", (chunk: string) => stderr.push(chunk));

    const timeout = setTimeout(() => {
      timedOut = true;
      if (!child.killed) child.kill("SIGTERM");
    }, options.timeoutMs);
    const abortHandler = () => {
      canceled = true;
      if (!child.killed) child.kill("SIGTERM");
    };
    options.signal?.addEventListener("abort", abortHandler, { once: true });

    function cleanup() {
      clearTimeout(timeout);
      options.signal?.removeEventListener("abort", abortHandler);
    }

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.once("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();
      resolve({
        command,
        code,
        signal,
        stdout: stdout.join(""),
        stderr: stderr.join(""),
        timedOut,
        canceled,
      });
    });
  });
}

function commandForStatus(
  spec: AgentProviderInstallSpec,
  status: AgentProviderInstallStatus,
) {
  if (!status.cli.installed) return spec.installCommand;
  if (!status.adapter.installed) return spec.adapterInstallCommand || spec.installCommand;
  return null;
}

export async function installAgentProvider(
  provider: InstallableAgentProviderId,
  options: AgentProviderInstallOptions = {},
): Promise<AgentProviderInstallResult> {
  const spec = AGENT_PROVIDER_INSTALL_SPECS[provider];
  const env = { ...process.env, ...(options.env ?? {}) };
  const cwd = options.cwd ?? process.cwd();
  const timeoutMs = options.timeoutMs ?? DEFAULT_INSTALL_TIMEOUT_MS;
  const before = await getAgentProviderInstallStatus(provider, { env });
  const command = commandForStatus(spec, before);

  if (!command) {
    return {
      provider,
      status: "skipped",
      command: null,
      before,
      after: before,
    };
  }

  let commandResult: AgentProviderInstallCommandResult;
  try {
    commandResult = await (options.commandRunner ?? runShellInstallCommand)(
      command,
      {
        cwd,
        env,
        ...(options.signal ? { signal: options.signal } : {}),
        timeoutMs,
      },
    );
  } catch {
    const after = await getAgentProviderInstallStatus(provider, { env });
    return {
      provider,
      status: "failed",
      command,
      before,
      after,
      failureReason: "install_start_failed",
    };
  }

  const after = await getAgentProviderInstallStatus(provider, { env });
  if (commandResult.canceled) {
    return {
      provider,
      status: "failed",
      command,
      before,
      after,
      failureReason: "install_canceled",
      commandResult,
    };
  }
  if (commandResult.timedOut) {
    return {
      provider,
      status: "failed",
      command,
      before,
      after,
      failureReason: "install_timed_out",
      commandResult,
    };
  }
  if (commandResult.code !== 0) {
    return {
      provider,
      status: "failed",
      command,
      before,
      after,
      failureReason: "install_command_failed",
      commandResult,
    };
  }
  if (!after.cli.installed || !after.adapter.installed) {
    return {
      provider,
      status: "failed",
      command,
      before,
      after,
      failureReason: "post_install_probe_failed",
      commandResult,
    };
  }

  return {
    provider,
    status: "succeeded",
    command,
    before,
    after,
    commandResult,
  };
}
