/** Hush files and search behavior. */

import { describe, expect, test } from "bun:test";
import { artifactId } from "../artifact.ts";
import { DEFAULT_HUSH_REDUCED_BYTES, reduceHush } from "../index.ts";
import { argv, encoder, report } from "./fixtures.ts";

describe("Hush files and search", () => {
  test("groups rg matches by path without sampling any match", () => {
    const lines = [
      "src/a.ts:1:one",
      "src/a.ts:2:two",
      "src/a.ts:3:three",
      "src/a.ts:4:four",
      "src/a.ts:5:five",
      "src/a.ts:6:six",
      "src/a.ts:7:seven",
      "src/a.ts:8:eight",
      "src/a.ts:9:nine",
      "src/b.ts:1:keep",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/opt/homebrew/bin/rg", ["reduceHush"]),
      capture: report(lines, { artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("search");
    expect(reduced.value.reducerId).toBe("files.rg");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toContain("  8 eight");
    expect(reduced.value.reducedText).toContain("  9 nine");
    expect(reduced.value.reducedText).toContain("src/b.ts:\n  1 keep");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("external diff removes only validated context while retaining every changed line", () => {
    const diff = [
      "--- before.ts\t2026-08-23 06:16:58",
      "+++ after.ts\t2026-08-23 06:16:58",
      "@@ -1,3 +1,3 @@",
      " export function mode() {",
      '-  return "sample";',
      '+  return "complete";',
      " }",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/diff", ["-u", "before.ts", "after.ts"]),
      capture: report(diff, { exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.diff");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.fidelity).toBe("deterministic-reduction");
    expect(reduced.value.reducedText).toBe(
      [
        "before.ts -> after.ts",
        "@@ -1,3 +1,3 @@",
        '-  return "sample";',
        '+  return "complete";',
      ].join("\n"),
    );
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.exit.exitCode).toBe(1);
  });

  test("wc removes only redundant single-file presentation", () => {
    const output = "     127     384    3268 src/domain/hush/reducers/log/format.ts\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.count");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe("127 384 3268\n");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("wc retains every multi-file count and exact total", () => {
    const output = [
      "     127     384    3268 src/domain/hush/reducers/log/format.ts",
      "      51     196    2115 src/domain/hush/reducers/log/reduce.ts",
      "     178     580    5383 total",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", [
        "src/domain/hush/reducers/log/format.ts",
        "src/domain/hush/reducers/log/reduce.ts",
      ]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(
      ["127L 384W 3268B format.ts", "51L 196W 2115B reduce.ts", "Σ 178L 580W 5383B", ""].join("\n"),
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("wc keeps failures exact instead of inventing counts", () => {
    const output = "wc: missing.ts: open: No such file or directory\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/wc", ["-l", "missing.ts"]),
      capture: report("", { stderr: output, exitCode: 1 }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(`stderr:\n${output}`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("makes find paths relative without sampling any entry", () => {
    const paths = ["corpus/docs/README.md", "corpus/src/main.ts", "corpus/src/domain/hush.ts"];
    const reduced = reduceHush({
      command: argv("/usr/bin/find", ["corpus", "-type", "f"]),
      capture: report(`${paths.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.find");
    expect(reduced.value.reducedText).toBe("docs/README.md\nsrc/main.ts\nsrc/domain/hush.ts");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps every entry when an important pattern is requested", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `file-${index}.ts`).join("\n");
    const reduced = reduceHush({
      command: argv("/bin/ls"),
      capture: report(`${lines}\nkeep-me.ts\n`),
      importantPatterns: ["keep-me.ts"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.family).toBe("listing");
    expect(reduced.value.reducedText).toContain("keep-me.ts");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("compacts long ls metadata without dropping an entry", () => {
    const lines = Array.from(
      { length: 80 },
      (_, index) =>
        `-rw-r--r--  1 user  staff  128 Aug 23 12:00 module-${String(index).padStart(2, "0")}.ts`,
    );
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-lahiF", "workspace"]),
      capture: report(`${lines.join("\n")}\n`, { artifact: true }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.ls");
    expect(reduced.value.reducedText).toStartWith("files 644 (80):\n");
    for (let index = 0; index < 80; index += 1) {
      expect(reduced.value.reducedText).toContain(
        `module-${String(index).padStart(2, "0")}.ts 128B`,
      );
    }
    expect(reduced.value.reducedText).not.toContain("user  staff");
    expect(reduced.value.reducedText).not.toContain("Aug 23 12:00");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeLessThan(
      encoder.encode(lines.join("\n")).byteLength,
    );
    expect(reduced.value.expansion.stdoutArtifact).toEqual(artifactId.from("cap-1.stdout"));
  });

  test("passes through a small ls result exactly", () => {
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-1", "workspace"]),
      capture: report("README.md\npackage.json\n"),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe("README.md\npackage.json\n");
  });

  test("keeps recursive ls output exact instead of sampling sections", () => {
    const lines = Array.from({ length: 60 }, (_, index) => `file-${index}.ts`);
    lines[0] = "workspace:";
    lines[20] = "workspace/src:";
    lines[40] = "workspace/tests:";
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-R", "workspace"]),
      capture: report(`${lines.join("\n")}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("workspace:");
    expect(reduced.value.reducedText).toContain("workspace/src:");
    expect(reduced.value.reducedText).toContain("workspace/tests:");
    expect(reduced.value.reducedText).toBe(`${lines.join("\n")}\n`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps efficient single-line ls formats exact", () => {
    const line = Array.from({ length: 120 }, (_, index) => `file ${index}.ts`).join(", ");
    const reduced = reduceHush({
      command: argv("/bin/ls", ["-m", "workspace"]),
      capture: report(`${line}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.ls");
    expect(reduced.value.strategy).toBe("passthrough");
    expect(reduced.value.fidelity).toBe("exact");
    expect(reduced.value.reducedText).toBe(`${line}\n`);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("does not impose the generic default byte cap on ls", () => {
    const output = `${Array.from(
      { length: 1_000 },
      (_, index) => `long-filename-${String(index).padStart(4, "0")}.ts`,
    ).join("\n")}\n`;
    expect(encoder.encode(output).byteLength).toBeGreaterThan(DEFAULT_HUSH_REDUCED_BYTES);

    const reduced = reduceHush({
      command: argv("/bin/ls", ["-1", "workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("preserves complete tree structure instead of applying the generic line cap", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `|-- file-${index}.ts`);
    const output = ["workspace", ...lines, "", "0 directories, 40 files", ""].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/tree", ["workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tree");
    expect(reduced.value.reducedText).toContain("file-39.ts");
    expect(reduced.value.reducedText).not.toContain("directories");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("does not impose the generic default byte cap on tree", () => {
    const lines = Array.from(
      { length: 1_000 },
      (_, index) => `|-- long-tree-entry-${String(index).padStart(4, "0")}.ts`,
    );
    const output = ["workspace", ...lines, "", "0 directories, 1000 files", ""].join("\n");
    expect(encoder.encode(output).byteLength).toBeGreaterThan(DEFAULT_HUSH_REDUCED_BYTES);

    const reduced = reduceHush({
      command: argv("/usr/bin/tree", ["workspace"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("long-tree-entry-0999.ts");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
  });
});
