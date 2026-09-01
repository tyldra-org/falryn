import { describe, expect, test } from "bun:test";

import { formatPulumi } from "./pulumi.ts";

describe("Hush Pulumi formatting", () => {
  test("keeps stack, URL, every resource, and summary", () => {
    const formatted = formatPulumi(
      [
        "Previewing update (dev)",
        "View in Browser: https://app.pulumi.com/falryn/dev/previews/736",
        "@ previewing update...",
        "    + pulumi:pulumi:Stack falryn-dev create",
        "    + aws:s3/bucket:Bucket artifacts create",
        "Resources:",
        "    + 2 to create",
      ].join("\n"),
      ["pulumi", "preview"],
    );
    expect(formatted).toContain("preview dev");
    expect(formatted).toContain("https://app.pulumi.com/falryn/dev/previews/736");
    expect(formatted).toContain("aws:s3/bucket:Bucket artifacts create");
    expect(formatted).toContain("+2 to create");
  });

  test("normalizes a complete stack list", () => {
    expect(
      formatPulumi("NAME    LAST UPDATE    RESOURCE COUNT\ndev*    2 minutes ago  4", [
        "pulumi",
        "stack",
        "ls",
      ]),
    ).toBe("NAME\tLAST UPDATE\tRESOURCE COUNT\ndev*\t2 minutes ago\t4");
  });
});
