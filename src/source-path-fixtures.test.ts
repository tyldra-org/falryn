import { expect, test } from "bun:test";
import { sourcePathFromGlob } from "./source-path-fixtures.ts";

test("normalizes a Windows glob path for repository ownership controls", () => {
  expect(sourcePathFromGlob("cli\\streams.ts")).toBe("cli/streams.ts");
});
