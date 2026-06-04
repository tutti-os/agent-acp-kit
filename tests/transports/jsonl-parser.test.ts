import { describe, expect, it } from "vitest";

import { createJsonlParser } from "../../src/transports/jsonl/jsonl-parser.js";

describe("createJsonlParser", () => {
  it("emits complete json objects across chunk boundaries", () => {
    const messages: Array<{ value: number }> = [];
    const parser = createJsonlParser<{ value: number }>((message) => {
      messages.push(message);
    });

    parser.feed('{"value":1}\n{"va');
    parser.feed('lue":2}\n');
    parser.flush();

    expect(messages).toEqual([{ value: 1 }, { value: 2 }]);
  });
});
