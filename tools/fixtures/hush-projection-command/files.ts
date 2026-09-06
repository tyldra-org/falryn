import { readFileSync } from "node:fs";

export function wcOutput(argv: readonly string[]): string {
  const signature = argv.join("\0");
  if (signature === ["-l", "-w", "-c", "src/domain/hush/reducers/log/format.ts"].join("\0")) {
    return "     127     384    3268 src/domain/hush/reducers/log/format.ts";
  }
  if (
    signature ===
    ["src/domain/hush/reducers/log/format.ts", "src/domain/hush/reducers/log/reduce.ts"].join("\0")
  ) {
    return [
      "     127     384    3268 src/domain/hush/reducers/log/format.ts",
      "      51     196    2115 src/domain/hush/reducers/log/reduce.ts",
      "     178     580    5383 total",
    ].join("\n");
  }
  throw new Error(`unsupported wc fixture arguments: ${argv.join(" ")}`);
}

export function psqlOutput(argv: readonly string[]): string {
  if (argv.includes("-x") || argv.includes("--expanded")) {
    return [
      "-[ RECORD 1 ]----------------",
      "id     | 101",
      "task   | Investigate latency",
      "status | active",
      "-[ RECORD 2 ]----------------",
      "id     | 102",
      "task   | Verify recovery",
      "status | done",
      "(2 rows)",
    ].join("\n");
  }
  return [
    " id | task                   | status  | token_savings",
    "----+------------------------+---------+--------------",
    "  1 | Optimize nested JSON   | done    |            32",
    "  2 | Preserve database rows | active  |             0",
    "  3 | Verify model context   | pending |            18",
    "(3 rows)",
  ].join("\n");
}

export function sqliteOutput(argv: readonly string[]): string {
  if (argv.includes("-line")) {
    return [
      "    id = 1",
      "  task = Optimize JSON",
      "status = done",
      "",
      "    id = 2",
      "  task = Preserve rows",
      "status = active",
    ].join("\n");
  }
  if (argv.includes("-box")) {
    return [
      "┌────┬───────────────┬────────┐",
      "│ id │     task      │ status │",
      "├────┼───────────────┼────────┤",
      "│ 1  │ Optimize JSON │ done   │",
      "│ 2  │ Preserve rows │ active │",
      "└────┴───────────────┴────────┘",
    ].join("\n");
  }
  return [
    "id  task           status",
    "--  -------------  ------",
    "1   Optimize JSON  done  ",
    "2   Preserve rows  active",
  ].join("\n");
}

export function runSedFixture(argv: readonly string[]): void {
  const printOnly = argv.includes("-n");
  const operands = argv.filter((argument) => argument !== "-n");
  const program = operands[0];
  const path = operands[1];
  if (program === undefined) {
    process.stderr.write("sed: missing command\n");
    process.exit(2);
  }
  const source = path === undefined ? readFileSync(0, "utf8") : readFileSync(path, "utf8");
  if (!printOnly) {
    process.stdout.write(source);
    return;
  }
  const range = /^(\d+)(?:,(\d+))?p$/u.exec(program);
  if (range === null) {
    process.stderr.write(`sed: unsupported fixture command: ${program}\n`);
    process.exit(2);
  }
  const start = Number.parseInt(range[1] ?? "1", 10);
  const end = Number.parseInt(range[2] ?? range[1] ?? "1", 10);
  const lines = source.split("\n");
  if (source.endsWith("\n")) {
    lines.pop();
  }
  const selected = lines.slice(Math.max(0, start - 1), end).join("\n");
  if (selected.length > 0) {
    process.stdout.write(`${selected}\n`);
  }
}

export function runDiffFixture(argv: readonly string[]): void {
  if (argv.join("\0") !== ["-u", "diff-before.ts", "diff-after.ts"].join("\0")) {
    process.stderr.write(`diff: unsupported fixture arguments: ${argv.join(" ")}\n`);
    process.exit(2);
  }
  process.stdout.write(
    [
      "--- diff-before.ts\t2026-08-23 06:16:58",
      "+++ diff-after.ts\t2026-08-23 06:16:58",
      "@@ -1,5 +1,6 @@",
      " export function project() {",
      '-  const mode = "sample";',
      '+  const mode = "complete";',
      "   const marker = 736;",
      "+  const exact = true;",
      "-  return mode;",
      '+  return exact ? mode : "sample";',
      " }",
      "",
    ].join("\n"),
  );
}
