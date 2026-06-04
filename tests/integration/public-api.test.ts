import { describe, expect, it } from "vitest";

import * as runtime from "../../src/index.js";
import * as testing from "../../src/testing/index.js";

describe("public api", () => {
  it("exports the package facade, official providers, and core helpers", () => {
    expect(runtime.createLocalAgentRuntime).toBeTypeOf("function");
    expect(runtime.createCodexProvider).toBeTypeOf("function");
    expect(runtime.codexProvider.id).toBe("codex");
    expect(runtime.createClaudeProvider).toBeTypeOf("function");
    expect(runtime.claudeProvider.id).toBe("claude");
    expect(runtime.createHermesProvider).toBeTypeOf("function");
    expect(runtime.hermesProvider.id).toBe("hermes");
    expect(runtime.createKimiProvider).toBeTypeOf("function");
    expect(runtime.kimiProvider.id).toBe("kimi");
    expect(runtime.createKiroProvider).toBeTypeOf("function");
    expect(runtime.kiroProvider.id).toBe("kiro");
    expect(runtime.fakeProvider.id).toBe("fake");
    expect(runtime.createGenericAcpProvider).toBeTypeOf("function");
    expect(runtime.normalizeMcpServerConfigs).toBeTypeOf("function");
    expect("createRuntimeControlPlane" in runtime).toBe(false);
    expect("inferRuntimeKind" in runtime).toBe(false);
    expect("spawnSupervisedProcess" in runtime).toBe(false);
    expect("runAcpTransport" in runtime).toBe(false);
  });

  it("exports testing helpers through the testing subpath", () => {
    expect(testing.assertProviderConformance).toBeTypeOf("function");
    expect(testing.createFakeRuntimeProvider).toBeTypeOf("function");
    expect(testing.createFakeAcpPeer).toBeTypeOf("function");
  });
});
