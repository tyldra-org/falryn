import { describe, expect, test } from "bun:test";

import { main } from "./main.ts";

describe("application bootstrap", () => {
  test("completes without an error", () => {
    expect(main()).toBeUndefined();
  });
});
