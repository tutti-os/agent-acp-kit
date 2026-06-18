import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";

import { resolveTempDir } from "../../src/process/env.js";

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
