import { describe, expect, it } from "vitest";

import { isTuttiAgentProviderCatalog } from "../../src/tutti/contracts.js";

function catalog() {
  return {
    schemaVersion: 2,
    source: "tutti-cli",
    defaultProviderId: "codex",
    providers: [{
      providerId: "codex",
      displayName: "Codex",
      availability: { status: "available", reasonCode: "", detail: "" },
      runtimeSupported: true,
    }],
  };
}

describe("Tutti browser-safe contracts", () => {
  it("accepts a catalog whose default resolves to one unique provider", () => {
    expect(isTuttiAgentProviderCatalog(catalog())).toBe(true);
    expect(isTuttiAgentProviderCatalog({
      ...catalog(),
      defaultProviderId: "",
      providers: [],
    })).toBe(true);
  });

  it("rejects duplicate providers and missing defaults", () => {
    const valid = catalog();
    expect(isTuttiAgentProviderCatalog({
      ...valid,
      providers: [...valid.providers, ...valid.providers],
    })).toBe(false);
    expect(isTuttiAgentProviderCatalog({
      ...valid,
      defaultProviderId: "missing",
    })).toBe(false);
    expect(isTuttiAgentProviderCatalog({
      ...valid,
      defaultProviderId: "",
    })).toBe(false);
  });
});
