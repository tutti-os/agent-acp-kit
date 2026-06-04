import { describe, expect, it } from "vitest";

import { redactSecrets } from "../../src/core/redaction.js";

describe("redactSecrets", () => {
  it("replaces each configured secret everywhere it appears", () => {
    expect(
      redactSecrets("token=abc123 and again abc123", ["abc123"]),
    ).toBe("token=[REDACTED] and again [REDACTED]");
  });

  it("ignores empty secret values", () => {
    expect(redactSecrets("hello world", [""])).toBe("hello world");
  });
});
