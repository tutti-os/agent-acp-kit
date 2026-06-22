import { execFileSync } from "node:child_process";
import { platform, tmpdir } from "node:os";

// System proxy injection.
//
// The standalone ACP agents we spawn (e.g. `claude`) only honor the
// HTTP(S)_PROXY environment variables — they do NOT read the macOS system proxy.
// The Claude desktop app works around this by resolving the OS proxy via
// Electron's session.resolveProxy() (Chromium/SystemConfiguration) and injecting
// HTTPS_PROXY/HTTP_PROXY into the spawned process. Without it, a child agent
// connects directly and, from a restricted region, gets `403 Request not
// allowed` from the upstream API while the app keeps working.
//
// We mirror that behavior here by reading the same SystemConfiguration data via
// `scutil --proxy` and injecting equivalent env vars. To stay faithful to the
// app we: skip SOCKS entries (downstream HTTP agents don't speak SOCKS), use the
// same default NO_PROXY, and never override a proxy the user/session already set.

const PROXY_KEYS = ["HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY"] as const;

// noProxyDefault matches the value the Claude desktop app injects.
const noProxyDefault = "localhost,127.0.0.1,::1,.local";

// ScutilProxyReader returns the raw output of `scutil --proxy`, or undefined when
// it is unavailable (non-macOS, or the command failing/timing out). It is
// injectable for tests; the default reads the macOS system proxy and is a no-op
// on other platforms.
export type ScutilProxyReader = () => string | undefined;

export function mergeProcessEnv(
  baseEnv: NodeJS.ProcessEnv,
  overrides?: Record<string, string>,
  readScutilProxy: ScutilProxyReader = runScutilProxy,
): NodeJS.ProcessEnv {
  const env = {
    ...baseEnv,
    ...(overrides ?? {}),
  };
  return injectSystemProxyEnv(env, readScutilProxy);
}

// injectSystemProxyEnv adds HTTPS_PROXY/HTTP_PROXY/NO_PROXY derived from the
// macOS system proxy, but only for keys not already present (case-insensitive)
// in env, so explicit user/session settings always win.
export function injectSystemProxyEnv(
  env: NodeJS.ProcessEnv,
  readScutilProxy: ScutilProxyReader = runScutilProxy,
): NodeJS.ProcessEnv {
  const proxyEnv = systemProxyEnv(readScutilProxy);
  if (!proxyEnv) {
    return env;
  }
  const present = new Set(
    Object.keys(env)
      .filter((key) => env[key] !== undefined)
      .map((key) => key.toUpperCase()),
  );
  const result = { ...env };
  for (const key of PROXY_KEYS) {
    const value = proxyEnv[key];
    if (!value || value.trim() === "") {
      continue;
    }
    if (present.has(key)) {
      continue;
    }
    result[key] = value;
  }
  return result;
}

function systemProxyEnv(
  readScutilProxy: ScutilProxyReader,
): Record<string, string> | undefined {
  const output = readScutilProxy();
  if (output === undefined) {
    return undefined;
  }
  return parseScutilProxy(output);
}

// runScutilProxy reads the macOS system proxy configuration. The result is
// memoized for the lifetime of the process: the system proxy is static (the same
// assumption the Claude desktop app makes), and this keeps the blocking exec off
// the hot path when many short-lived agents are spawned in sequence. It is a
// no-op on non-macOS platforms, where proxies are conventionally driven by env
// vars.
let cachedScutilProxy: { value: string | undefined } | undefined;

function runScutilProxy(): string | undefined {
  if (!cachedScutilProxy) {
    cachedScutilProxy = { value: readScutilProxyUncached() };
  }
  return cachedScutilProxy.value;
}

function readScutilProxyUncached(): string | undefined {
  if (platform() !== "darwin") {
    return undefined;
  }
  try {
    return execFileSync("scutil", ["--proxy"], {
      encoding: "utf8",
      timeout: 2_000,
    });
  } catch {
    return undefined;
  }
}

// parseScutilProxy turns `scutil --proxy` output into proxy env vars.
//
// Example input:
//
//   <dictionary> {
//     HTTPSEnable : 1
//     HTTPSProxy : 127.0.0.1
//     HTTPSPort : 7890
//     ...
//   }
//
// SOCKS entries are intentionally ignored, and PAC (ProxyAutoConfig) is not
// resolved — scutil only exposes the PAC URL, not the per-URL result, so we
// leave those to the user's explicit env. Returns undefined when no usable proxy
// is configured (direct connection).
export function parseScutilProxy(
  output: string,
): Record<string, string> | undefined {
  const fields: Record<string, string> = {};
  for (const line of output.split("\n")) {
    const idx = line.indexOf(":");
    if (idx === -1) {
      continue;
    }
    fields[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }

  const proxyUrl = (enableKey: string, hostKey: string, portKey: string) => {
    if (fields[enableKey] !== "1") {
      return undefined;
    }
    const host = fields[hostKey];
    const port = fields[portKey];
    if (!host || !port) {
      return undefined;
    }
    return `http://${joinHostPort(host, port)}`;
  };

  // Prefer the HTTPS entry (the upstream API is HTTPS); fall back to HTTP. Both
  // env vars point at the same proxy, mirroring the Claude app.
  const url =
    proxyUrl("HTTPSEnable", "HTTPSProxy", "HTTPSPort") ??
    proxyUrl("HTTPEnable", "HTTPProxy", "HTTPPort");
  if (!url) {
    return undefined;
  }

  return {
    HTTPS_PROXY: url,
    HTTP_PROXY: url,
    NO_PROXY: noProxyDefault,
  };
}

// joinHostPort mirrors Go's net.JoinHostPort: bracket IPv6 literals (which
// contain ":") so the host:port is unambiguous.
function joinHostPort(host: string, port: string): string {
  return host.includes(":") ? `[${host}]:${port}` : `${host}:${port}`;
}

export function resolveTempDir(env?: Record<string, string | undefined>) {
  return (
    env?.TMPDIR?.trim() ||
    env?.TEMP?.trim() ||
    env?.TMP?.trim() ||
    process.env.TMPDIR?.trim() ||
    process.env.TEMP?.trim() ||
    process.env.TMP?.trim() ||
    tmpdir()
  );
}
