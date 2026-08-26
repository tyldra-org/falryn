/** Hush package, test, build, and diagnostics behavior. */

import { describe, expect, test } from "bun:test";
import { artifactId } from "../artifact.ts";
import { reduceHush } from "../index.ts";
import { argv, report } from "./fixtures.ts";

describe("Hush package, test, build, and diagnostics", () => {
  test("removes a successful Bun typecheck echo but preserves it on unexplained failure", () => {
    const command = argv("/usr/bin/bun", ["run", "typecheck"]);
    const successful = reduceHush({
      command,
      capture: report("", { stderr: "$ tsc --noEmit\n" }),
    });
    expect(successful.ok).toBe(true);
    if (!successful.ok) {
      throw new Error("expected a Hush result");
    }
    expect(successful.value.reducerId).toBe("bun.typecheck");
    expect(successful.value.reducedText).toBe("");

    const failed = reduceHush({
      command,
      capture: report("", { stderr: "$ tsc --noEmit\n", exitCode: 1 }),
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      throw new Error("expected a Hush result");
    }
    expect(failed.value.reducedText).toBe("stderr:\n$ tsc --noEmit\n");
  });

  test("keeps unknown and partial lint output exact", () => {
    const unknown = "opaque lint fact\nsecond fact\n";
    const exact = reduceHush({
      command: argv("/usr/bin/eslint", ["src"]),
      capture: report(unknown, { exitCode: 1 }),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("expected an exact Hush result");
    expect(exact.value.reducerId).toBe("js.lint");
    expect(exact.value.reducedText).toBe(unknown);

    const partial = reduceHush({
      command: argv("/usr/bin/eslint", ["src"]),
      capture: report("/workspace/src/a.ts\n  1:1 error Missing value no-undef\n", {
        truncated: true,
        artifact: true,
        exitCode: 1,
      }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Hush result");
    expect(partial.value.reducedText).toBe(
      "/workspace/src/a.ts\n  1:1 error Missing value no-undef\n",
    );
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });

  test("keeps unknown and partial build output exact", () => {
    const unknown = "custom build fact\nsecond terminal fact\n";
    const exact = reduceHush({
      command: argv("/usr/bin/next", ["build"]),
      capture: report(unknown),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("expected an exact Hush result");
    expect(exact.value.reducerId).toBe("js.build");
    expect(exact.value.reducedText).toBe(unknown);

    const partial = reduceHush({
      command: argv("/usr/bin/cargo", ["build", "--release"]),
      capture: report("Compiling falryn v0.3.0\n", {
        truncated: true,
        artifact: true,
      }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Hush result");
    expect(partial.value.reducedText).toBe("Compiling falryn v0.3.0\n");
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });

  test("summarizes successful tests without a fixed test-count cap", () => {
    const output = [
      "tests/test_hush.py::test_complete PASSED",
      "tests/test_hush.py::test_budget PASSED",
      "2 passed in 0.12s",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report(`${output}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("python.test");
    expect(reduced.value.reducedText).toBe("2 passed 0.12s");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps unknown and partial test output exact", () => {
    const unknown = "opaque runner fact\nsecond fact\n";
    const exact = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report(unknown),
    });
    expect(exact.ok).toBe(true);
    if (!exact.ok) throw new Error("expected an exact Hush result");
    expect(exact.value.reducedText).toBe(unknown);

    const partial = reduceHush({
      command: argv("/usr/bin/pytest"),
      capture: report("test_complete PASSED\n", { truncated: true, artifact: true }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Hush result");
    expect(partial.value.reducedText).toBe("test_complete PASSED\n");
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });
});
