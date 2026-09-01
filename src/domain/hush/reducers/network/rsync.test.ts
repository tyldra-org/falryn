import { describe, expect, test } from "bun:test";

import { formatRsyncOutput } from "./rsync.ts";

describe("Hush rsync formatting", () => {
  test("keeps every path, transfer counter, deletion, and total", () => {
    const paths = Array.from({ length: 80 }, (_, index) => `src/module-${index}.ts`);
    const lines = ["sending incremental file list"];
    for (const [index, path] of paths.entries()) {
      lines.push(
        path,
        `          ${1_024 + index} 100%    1.00MB/s    0:00:00 (xfr#${index + 1}, to-chk=${79 - index}/80)`,
      );
    }
    lines.push(
      "deleting src/obsolete.ts",
      "sent 85,040 bytes  received 1,024 bytes  172,128.00 bytes/sec",
      "total size is 85,040  speedup is 0.99",
    );
    const formatted = formatRsyncOutput(lines.join("\n"));
    expect(formatted).toContain("path\tbytes\t%\trate\telapsed\txfr\tremaining");
    expect(formatted).toContain("src/module-0.ts\t1024\t100\t1.00MB/s\t0:00:00\t1\t79/80");
    expect(formatted).toContain("src/module-79.ts\t1103\t100\t1.00MB/s\t0:00:00\t80\t0/80");
    expect(formatted).toContain("delete src/obsolete.ts");
    expect(formatted).toContain("sent=85040B received=1024B rate=172128.00B/s");
    expect(formatted).toContain("total=85040B speedup=0.99");
    expect(formatted).not.toContain("omitted");
  });

  test("keeps dry-run itemization and created-directory facts", () => {
    const formatted = formatRsyncOutput(
      [
        "building file list ... done",
        "created directory backup",
        ">f+++++++++ src/new.ts",
        "*deleting   src/old.ts",
        "sent 736 bytes  received 42 bytes  1,556.00 bytes/sec",
        "total size is 784  speedup is 1.01",
      ].join("\n"),
    );
    expect(formatted).toContain("created-dir backup");
    expect(formatted).toContain(">f+++++++++ src/new.ts");
    expect(formatted).toContain("*deleting   src/old.ts");
  });

  test("declines partial output without both terminal summaries", () => {
    expect(formatRsyncOutput("sending incremental file list\nsrc/a.ts")).toBeNull();
  });
});
