import { describe, expect, it } from "vitest";

import { StderrBuffer } from "../../src/process/stderr-buffer.js";

describe("StderrBuffer", () => {
  it("keeps only the configured tail", () => {
    const buffer = new StderrBuffer(8);
    buffer.append("1234");
    buffer.append("567890");

    expect(buffer.tail()).toBe("34567890");
  });

  it("can be cleared", () => {
    const buffer = new StderrBuffer();
    buffer.append("oops");
    buffer.clear();

    expect(buffer.tail()).toBe("");
  });
});
