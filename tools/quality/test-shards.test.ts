import { afterEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  FILE_COST_MS,
  failingTestFiles,
  KNOWN_FLAKES_FILE,
  type KnownFlake,
  MAX_KNOWN_FLAKES,
  MAX_RETRIED_FILES,
  parseKnownFlakes,
  retryArguments,
  retryPlan,
  retrySummary,
  shardArguments,
  shardSummary,
  shardWeights,
  testRetries,
  testShardCount,
  testShardSelection,
} from "./test-shards.ts";

const RUNNER = join(import.meta.dir, "test-shards.ts");
const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

test("shard count follows the cores, bounded, and honours a valid override only", () => {
  expect(testShardCount(undefined, 8)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount(undefined, 16)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount(undefined, 2)).toEqual({ ok: true, shards: 1 });
  expect(testShardCount(undefined, 1)).toEqual({ ok: true, shards: 1 });
  expect(testShardCount("", 8)).toEqual({ ok: true, shards: 4 });
  expect(testShardCount("6", 2)).toEqual({ ok: true, shards: 6 });
  for (const bad of ["0", "17", "2.5", "four"]) expect(testShardCount(bad, 8).ok).toBe(false);
});

test("a CI job selects one shard, and retries are on unless explicitly off", () => {
  expect(testShardSelection(undefined)).toEqual({ ok: true, value: null });
  expect(testShardSelection("2/3")).toEqual({ ok: true, value: { shard: 2, shards: 3 } });
  for (const bad of ["0/3", "4/3", "1/17", "2", "a/b"])
    expect(testShardSelection(bad).ok).toBe(false);
  expect(testRetries(undefined)).toEqual({ ok: true, value: 1 });
  expect(testRetries("0")).toEqual({ ok: true, value: 0 });
  expect(testRetries("2").ok).toBe(false);
});

test("shards balance by recorded duration plus a fixed cost for every tracked file", () => {
  const recorded = JSON.stringify({
    version: 1,
    files: { "src/a.test.ts": 4000, "src/gone.test.ts": 9 },
  });
  expect(shardWeights(recorded, ["src/a.test.ts", "src/new.test.ts"])).toEqual({
    version: 1,
    files: { "src/a.test.ts": 4000 + FILE_COST_MS, "src/new.test.ts": FILE_COST_MS },
  });
  for (const unreadable of [
    null,
    "not json",
    "{}",
    JSON.stringify({ files: { "src/a.test.ts": -1 } }),
  ])
    expect(shardWeights(unreadable, ["src/a.test.ts"]).files).toEqual({
      "src/a.test.ts": FILE_COST_MS,
    });
});

test("every shard balances by the weights and leaves compiled suites to the smoke runs", () => {
  expect(shardArguments(2, 4, ["--only-failures"], "/tmp/weights.json")).toEqual([
    "test",
    "--shard=2/4",
    "--timings=/tmp/weights.json",
    "--path-ignore-patterns=**/*.compiled.test.ts",
    "--only-failures",
  ]);
  expect(shardArguments(1, 1, [], "/tmp/weights.json")).toEqual([
    "test",
    "--path-ignore-patterns=**/*.compiled.test.ts",
  ]);
  // A retry names its file exactly, so a filter cannot widen it to similar names.
  expect(retryArguments("src/a.test.ts", ["--bail"])).toEqual([
    "test",
    "--bail",
    "./src/a.test.ts",
  ]);
});

test("failing files are read from local and GitHub Actions output alike", () => {
  const local = [
    "src/a.test.ts:",
    "(pass) ok",
    "(fail) bad [1ms]",
    "src/b.test.ts:",
    "(pass) fine",
  ];
  expect(failingTestFiles(local.join("\n"))).toEqual({
    files: ["src/a.test.ts"],
    attributed: true,
  });
  const actions = [
    "::group::src/c.test.tsx:",
    "# Unhandled error between tests",
    "::endgroup::",
    "::group::src/d.test.ts:",
    "(fail) late [2ms]",
    "::endgroup::",
  ];
  expect(failingTestFiles(actions.join("\r\n"))).toEqual({
    files: ["src/c.test.tsx", "src/d.test.ts"],
    attributed: true,
  });
  // A failure outside any file cannot be repeated by rerunning one file.
  expect(failingTestFiles("(fail) before any file").attributed).toBe(false);
  // Bun's closing recap repeats failures after the last file; it must not be read.
  const recap = [
    "::group::src/a.test.ts:",
    "(fail) bad [1ms]",
    "::endgroup::",
    "::group::src/z.test.ts:",
    "::endgroup::",
    "1 test failed:",
    "(fail) bad [1ms]",
  ];
  expect(failingTestFiles(recap.join("\n"))).toEqual({
    files: ["src/a.test.ts"],
    attributed: true,
  });
  expect(
    failingTestFiles(
      ["src/a.test.ts:", "(fail) bad", "src/z.test.ts:", "2 tests failed:", "(fail) bad"].join(
        "\n",
      ),
    ),
  ).toEqual({ files: ["src/a.test.ts"], attributed: true });
  expect(failingTestFiles("::group::src/e.test.ts:\n::endgroup::\n(fail) x").attributed).toBe(
    false,
  );
});

test("failing files are read from colour-forced output, where Bun marks failures with a cross", () => {
  // FORCE_COLOR makes Bun write "\u2717 name" for a failure and wrap lines in colour codes.
  const coloured = [
    "\u001b[0m",
    "src/a.test.ts:",
    "\u001b[0m\u001b[32m\u2713\u001b[0m fine \u001b[0m\u001b[2m[0.10ms\u001b[0m\u001b[2m]\u001b[0m",
    "\u001b[0m\u001b[31m\u2717\u001b[0m\u001b[0m\u001b[1m bad\u001b[0m \u001b[0m\u001b[2m[0.36ms\u001b[0m\u001b[2m]\u001b[0m",
    "src/b.test.ts:",
    "\u001b[31m\u2717\u001b[0m worse",
    "\u001b[0m\u001b[1m2 tests failed:\u001b[0m",
    "\u001b[31m\u2717\u001b[0m bad",
  ];
  expect(failingTestFiles(coloured.join("\n"))).toEqual({
    files: ["src/a.test.ts", "src/b.test.ts"],
    attributed: true,
  });
  // A coloured failure outside any file is still unattributed.
  expect(failingTestFiles("\u001b[31m\u2717\u001b[0m before any file").attributed).toBe(false);
});

test("the known-flake registry fails closed on malformed, duplicate or stale entries", () => {
  const entry = { path: "src/a.test.ts", issue: 1201, symptom: "busy close under load" };
  const doc = (files: unknown[]) => JSON.stringify({ version: 1, files });
  const exists = (path: string) => path === "src/a.test.ts";
  expect(parseKnownFlakes(null, exists)).toEqual({ ok: true, value: new Map() });
  expect(parseKnownFlakes(doc([entry]), exists)).toEqual({
    ok: true,
    value: new Map([["src/a.test.ts", { issue: 1201, symptom: "busy close under load" }]]),
  });
  for (const bad of [
    "{",
    JSON.stringify({ version: 2, files: [] }),
    doc([{ ...entry, issue: 0 }]),
    doc([{ ...entry, symptom: " " }]),
    doc([{ ...entry, path: "../outside.test.ts" }]),
    doc([{ ...entry, owner: "someone" }]),
    doc([entry, entry]),
    doc([{ ...entry, path: "src/gone.test.ts" }]),
    doc(Array.from({ length: MAX_KNOWN_FLAKES + 1 }, () => entry)),
  ])
    expect(parseKnownFlakes(bad, exists).ok).toBe(false);
  const stale = parseKnownFlakes(doc([{ ...entry, path: "src/gone.test.ts" }]), exists);
  expect(stale).toEqual({
    ok: false,
    reason: `${KNOWN_FLAKES_FILE} lists src/gone.test.ts, which does not exist; remove the entry`,
  });
});

test("only a few registered flaky files are retried; any other failure fails at once", () => {
  const output = (...files: string[]) => ({
    output: files.map((file) => `${file}:\n(fail) t`).join("\n"),
  });
  const flake: KnownFlake = { issue: 1201, symptom: "busy close" };
  const known = new Map([
    ["src/a.test.ts", flake],
    ["src/b.test.ts", flake],
  ]);
  expect(retryPlan([], 1, known)).toEqual({ kind: "none" });
  expect(
    retryPlan([output("src/b.test.ts"), output("src/a.test.ts", "src/b.test.ts")], 1, known),
  ).toEqual({ kind: "retry", files: ["src/a.test.ts", "src/b.test.ts"] });
  // A failure that is not registered is never retried, even beside a known flake.
  expect(retryPlan([output("src/a.test.ts", "src/new.test.ts")], 1, known)).toEqual({
    kind: "refused",
    reason: `src/new.test.ts is not a known flake. Fix the failure; if it is a flake, it needs an owning issue and an entry in ${KNOWN_FLAKES_FILE} first`,
  });
  expect(retryPlan([output("src/a.test.ts")], 0, known)).toMatchObject({ kind: "refused" });
  expect(retryPlan([{ output: "error: crashed" }], 1, known)).toMatchObject({ kind: "refused" });
  const many = Array.from({ length: MAX_RETRIED_FILES + 1 }, (_, index) => `src/${index}.test.ts`);
  const all = new Map(many.map((file) => [file, flake]));
  expect(retryPlan([output(...many)], 1, all)).toMatchObject({ kind: "refused" });
});

test("a known flake that passes alone is named with its issue; a repeat failure fails", () => {
  const flake: KnownFlake = { issue: 1201, symptom: "busy close" };
  const pass = { file: "src/a.test.ts", passed: true, flake };
  expect(retrySummary([pass])).toEqual({
    passed: true,
    flaky: [pass],
    lines: [
      "KNOWN FLAKE src/a.test.ts (#1201): failed in its shard, passed when run alone",
      "the run passes on known flakes; their issues own the fix",
    ],
  });
  const mixed = retrySummary([pass, { file: "src/b.test.ts", passed: false, flake }]);
  expect(mixed.passed).toBe(false);
  expect(mixed.lines).toContain(
    "FAILED src/b.test.ts (known flake #1201): failed again when run alone",
  );
});

test("one failing shard fails the run and is named", () => {
  const passed = { exitCode: 0, seconds: 100, ran: "Ran 10 tests across 2 files" };
  expect(
    shardSummary(
      [
        { shard: 2, ...passed },
        { shard: 1, exitCode: 1, seconds: 90, ran: null },
      ],
      2,
      101,
    ),
  ).toEqual([
    "shard 1/2 failed (exit 1) in 90s",
    "shard 2/2 passed in 100s — Ran 10 tests across 2 files",
    "1 of 2 shards failed after 101s: 1",
  ]);
  expect(shardSummary([{ shard: 1, ...passed }], 1, 100).at(-1)).toBe(
    "all 1 shards passed in 100s",
  );
  expect(shardSummary([{ shard: 2, ...passed }], 3, 100).at(-1)).toBe("shard 2 passed in 100s");
});

/** Runs the real runner, as a CI shard job does, over fixture test files. */
async function runner(
  files: Record<string, string>,
  known: readonly { readonly path: string; readonly issue: number; readonly symptom: string }[],
  environment: Record<string, string> = {},
) {
  const root = await mkdtemp(join(tmpdir(), "falryn-test-shards-"));
  roots.push(root);
  const registry = { [KNOWN_FLAKES_FILE]: JSON.stringify({ version: 1, files: known }) };
  for (const [name, source] of Object.entries({ ...files, ...registry })) {
    await mkdir(dirname(join(root, name)), { recursive: true });
    await writeFile(join(root, name), source);
  }
  const summary = join(root, "summary.md");
  const child = Bun.spawn([process.execPath, RUNNER], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      FALRYN_TEST_SHARD: "1/1",
      GITHUB_ACTIONS: "true",
      GITHUB_STEP_SUMMARY: summary,
      ...environment,
    },
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ]);
  const report = await readFile(summary, "utf8").catch(() => "");
  return { exitCode, output: stderr + stdout, report };
}

const HEADER = `import { expect, test } from "bun:test";\nimport { existsSync, writeFileSync } from "node:fs";\n`;
/** Fails on its first run in a directory and passes afterwards. */
const FLAKY = `${HEADER}test("flaky", () => { if (!existsSync("ran")) { writeFileSync("ran", ""); expect(1).toBe(2); } });\n`;
const BROKEN = `${HEADER}test("broken", () => { expect(1).toBe(2); });\n`;

// Each case spawns the runner, which spawns `bun test` up to twice per run.
const RUNNER_JOURNEY = 30_000;
const REGISTERED = [{ path: "src/flaky.test.ts", issue: 1201, symptom: "fails on first run" }];

test(
  "the real runner keeps a known flake's pass green and reports it with its issue",
  async () => {
    const run = await runner({ "src/flaky.test.ts": FLAKY }, REGISTERED);
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain(
      "KNOWN FLAKE src/flaky.test.ts (#1201): failed in its shard, passed when run alone",
    );
    expect(run.output).toContain(
      "::warning file=src/flaky.test.ts,title=Known flaky test (#1201)::",
    );
    expect(run.report).toContain("- \u0060src/flaky.test.ts\u0060 (#1201): fails on first run");
  },
  RUNNER_JOURNEY,
);

test(
  "the real runner fails an unregistered flake, a repeat failure and a stale registry",
  async () => {
    // The case a blanket retry would hide: a new flake, possibly introduced by the change.
    const unregistered = await runner({ "src/flaky.test.ts": FLAKY }, []);
    expect(unregistered.exitCode).toBe(1);
    expect(unregistered.output).toContain("src/flaky.test.ts is not a known flake");
    expect(unregistered.report).toBe("");
    const broken = await runner({ "src/broken.test.ts": BROKEN }, [
      { path: "src/broken.test.ts", issue: 1202, symptom: "always fails" },
    ]);
    expect(broken.exitCode).toBe(1);
    expect(broken.output).toContain(
      "FAILED src/broken.test.ts (known flake #1202): failed again when run alone",
    );
    const disabled = await runner({ "src/flaky.test.ts": FLAKY }, REGISTERED, {
      FALRYN_TEST_RETRIES: "0",
    });
    expect(disabled.exitCode).toBe(1);
    expect(disabled.output).toContain("not retrying: retries are disabled");
    const stale = await runner({ "src/other.test.ts": BROKEN }, REGISTERED);
    expect(stale.exitCode).toBe(2);
    expect(stale.output).toContain("lists src/flaky.test.ts, which does not exist");
  },
  RUNNER_JOURNEY,
);
