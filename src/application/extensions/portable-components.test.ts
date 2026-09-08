import { expect, test } from "bun:test";
import { markdownMetadata } from "./portable-components.ts";

test("rejects duplicate keys, cyclic aliases and non-object frontmatter", () => {
  for (const yaml of ["name: one\nname: two", "x: &x [*x]", "[one, two]"]) {
    const bytes = new TextEncoder().encode(`---\n${yaml}\n---\nbody`);
    expect(() => markdownMetadata(bytes, true)).toThrow();
  }
  expect(
    markdownMetadata(
      new TextEncoder().encode("---\nname: good\ndescription: |\n  One\n  Two\n---\nbody"),
      true,
    ),
  ).toEqual({ name: "good", description: "One\nTwo\n" });
});
