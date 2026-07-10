import { describe, expect, it } from "vitest";

import { choosePermissionOutcome } from "../../src/transports/acp/acp-permissions.js";

describe("choosePermissionOutcome", () => {
  it("prefers durable approval semantics and supports provider aliases", () => {
    expect(
      choosePermissionOutcome([
        { optionId: "approve" },
        { optionId: "session", kind: "allow_always" },
      ]),
    ).toBe("session");
    expect(choosePermissionOutcome([{ optionId: "allow" }])).toBe("allow");
    expect(choosePermissionOutcome([{ optionId: "approve" }])).toBe("approve");
    expect(choosePermissionOutcome([{ optionId: "deny", kind: "reject_once" }]))
      .toBeNull();
  });
});
