import { describe, expect, it } from "vitest";

import { choosePermissionOutcome } from "../../src/transports/acp/acp-permissions.js";

describe("choosePermissionOutcome", () => {
  it("prefers durable approval semantics only for explicit full access", () => {
    expect(
      choosePermissionOutcome([
        { optionId: "approve" },
        { optionId: "session", kind: "allow_always" },
      ], { semantic: "full-access" }),
    ).toBe("session");
    expect(choosePermissionOutcome([{ optionId: "deny", kind: "reject_once" }]))
      .toBeNull();
  });

  it("never auto-approves a request without an explicit permissive policy", () => {
    const options = [{ optionId: "session", kind: "allow_always" }];
    expect(choosePermissionOutcome(options)).toBeNull();
    expect(choosePermissionOutcome(options, { semantic: "ask-before-write" }))
      .toBeNull();
    expect(choosePermissionOutcome(options, { semantic: "locked-down" }))
      .toBeNull();
    expect(choosePermissionOutcome(options, { semantic: "auto" })).toBeNull();
    expect(choosePermissionOutcome(options, { semantic: "accept-edits" }))
      .toBeNull();
  });
});
