import { describe, expect, test } from "bun:test";

import { formatPathListing } from "./format.ts";

describe("Hush find listing format", () => {
  test("groups a large shared-extension tree without omitting any path", () => {
    const names = Array.from(
      { length: 30 },
      (_, index) => `feature-${index.toString().padStart(2, "0")}`,
    );
    const source = names.map((name) => `corpus/src/domain/${name}.ts`).join("\n");

    expect(formatPathListing(`${source}\n`, ["find", "corpus", "-type", "f"])).toBe(
      ["30 files (*.ts)", "./", "src/", ` domain/ ${names.join(" ")}`].join("\n"),
    );
  });

  test("keeps unsafe filenames line-oriented and exact", () => {
    expect(
      formatPathListing("corpus/with space.ts\ncorpus/other.ts\n", [
        "find",
        "corpus",
        "-type",
        "f",
      ]),
    ).toBe("with space.ts\nother.ts");
  });
});
