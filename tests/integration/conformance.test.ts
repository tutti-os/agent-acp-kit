import { describe, expect, it } from "vitest";

import { createFakeProvider } from "../../src/index.js";
import { assertProviderConformance } from "../../src/testing/index.js";

describe("provider conformance helpers", () => {
  it("validates a provider through detect, launch, parser, and runtime facade", async () => {
    const result = await assertProviderConformance({
      provider: createFakeProvider(),
      runInput: {
        runId: "run_conformance",
        cwd: "/tmp",
        prompt: "hello",
        provider: "fake",
        runtimeKind: "local-agent",
        runtimeProvider: "fake",
      },
    });

    expect(result).toEqual({
      providerId: "fake",
      checks: ["detect", "launch-plan", "parser", "runtime-facade"],
    });
  });
});
