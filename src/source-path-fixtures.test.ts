import { expect, test } from "bun:test";
import { sourcePathFromGlob } from "./source-path-fixtures.ts";

test("normalizes a Windows glob path for repository ownership controls", () => {
  expect(sourcePathFromGlob("cli\\output\\streams.ts")).toBe("cli/output/streams.ts");
});
