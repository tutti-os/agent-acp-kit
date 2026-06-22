import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import {
  injectSystemProxyEnv,
  mergeProcessEnv,
  parseScutilProxy,
  resolveTempDir,
} from "../../src/process/env.js";

// Real-world `scutil --proxy` output with Clash Verge system proxy enabled
// (HTTP/HTTPS/SOCKS all pointing at 127.0.0.1:7890).
const scutilProxyEnabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
    2 : *.local
  }
  HTTPEnable : 1
  HTTPPort : 7890
  HTTPProxy : 127.0.0.1
  HTTPSEnable : 1
  HTTPSPort : 7890
  HTTPSProxy : 127.0.0.1
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 1
  SOCKSPort : 7890
  SOCKSProxy : 127.0.0.1
}`;

const scutilProxyDisabled = `<dictionary> {
  ExceptionsList : <array> {
    0 : 127.0.0.1
    1 : localhost
  }
  HTTPEnable : 0
  HTTPSEnable : 0
  ProxyAutoConfigEnable : 0
  SOCKSEnable : 0
}`;

function withProcessTempEnv(
  env: Partial<Record<"TMPDIR" | "TEMP" | "TMP", string>>,
  run: () => void,
) {
  const previous = {
    TMPDIR: process.env.TMPDIR,
    TEMP: process.env.TEMP,
    TMP: process.env.TMP,
  };

  delete process.env.TMPDIR;
  delete process.env.TEMP;
  delete process.env.TMP;
  Object.assign(process.env, env);

  try {
    run();
  } finally {
    for (const key of ["TMPDIR", "TEMP", "TMP"] as const) {
      if (previous[key] === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = previous[key];
      }
    }
  }
}

describe("resolveTempDir", () => {
  it("prefers run env temp variables over process env", () => {
    withProcessTempEnv({ TMPDIR: "/process-tmpdir" }, () => {
      expect(
        resolveTempDir({
          TMPDIR: "/run-tmpdir",
          TEMP: "/run-temp",
          TMP: "/run-tmp",
        }),
      ).toBe("/run-tmpdir");
      expect(resolveTempDir({ TEMP: "/run-temp", TMP: "/run-tmp" })).toBe(
        "/run-temp",
      );
      expect(resolveTempDir({ TMP: "/run-tmp" })).toBe("/run-tmp");
    });
  });

  it("falls back from run env to process env and then OS temp", () => {
    withProcessTempEnv({ TEMP: "/process-temp" }, () => {
      expect(resolveTempDir({ TMPDIR: " " })).toBe("/process-temp");
    });
    withProcessTempEnv({}, () => {
      expect(resolveTempDir({ TMPDIR: " ", TEMP: "", TMP: "\t" })).toBe(tmpdir());
    });
  });
});

describe("parseScutilProxy", () => {
  it("derives HTTP(S)_PROXY/NO_PROXY from an enabled system proxy", () => {
    expect(parseScutilProxy(scutilProxyEnabled)).toEqual({
      HTTPS_PROXY: "http://127.0.0.1:7890",
      HTTP_PROXY: "http://127.0.0.1:7890",
      NO_PROXY: "localhost,127.0.0.1,::1,.local",
    });
  });

  it("returns undefined when no proxy is enabled", () => {
    expect(parseScutilProxy(scutilProxyDisabled)).toBeUndefined();
  });

  it("falls back to the HTTP entry when HTTPS is disabled", () => {
    const out = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : 10.0.0.2
  HTTPPort : 3128
  HTTPSEnable : 0
  SOCKSEnable : 0
}`;
    const got = parseScutilProxy(out);
    expect(got?.HTTP_PROXY).toBe("http://10.0.0.2:3128");
    expect(got?.HTTPS_PROXY).toBe("http://10.0.0.2:3128");
  });

  it("ignores SOCKS-only configurations", () => {
    const out = `<dictionary> {
  HTTPEnable : 0
  HTTPSEnable : 0
  SOCKSEnable : 1
  SOCKSProxy : 127.0.0.1
  SOCKSPort : 7890
}`;
    expect(parseScutilProxy(out)).toBeUndefined();
  });
});

describe("injectSystemProxyEnv", () => {
  const readEnabled = () => scutilProxyEnabled;

  it("injects the system proxy into the spawned env", () => {
    const env = injectSystemProxyEnv({ PATH: "/usr/bin:/bin" }, readEnabled);
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.HTTP_PROXY).toBe("http://127.0.0.1:7890");
    expect(env.NO_PROXY).toBe("localhost,127.0.0.1,::1,.local");
  });

  it("never overrides a proxy the user/session already set (case-insensitive)", () => {
    const env = injectSystemProxyEnv(
      { PATH: "/usr/bin:/bin", https_proxy: "http://user-set:1080" },
      readEnabled,
    );
    expect(env.https_proxy).toBe("http://user-set:1080");
    // Must not have appended a conflicting upper-case HTTPS_PROXY.
    expect(env.HTTPS_PROXY).toBeUndefined();
  });

  it("leaves env untouched when scutil is unavailable", () => {
    const env = injectSystemProxyEnv({ PATH: "/usr/bin:/bin" }, () => undefined);
    expect(env.HTTPS_PROXY).toBeUndefined();
    expect(env.HTTP_PROXY).toBeUndefined();
    expect(env.NO_PROXY).toBeUndefined();
  });

  it("is applied through mergeProcessEnv at the spawn chokepoint", () => {
    const env = mergeProcessEnv(
      { PATH: "/usr/bin:/bin" },
      { FOO: "bar" },
      readEnabled,
    );
    expect(env.FOO).toBe("bar");
    expect(env.HTTPS_PROXY).toBe("http://127.0.0.1:7890");
  });
});
