import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFixtureCommands } from "./fixture-commands.ts";

test("installed command fixtures resolve their family modules outside the checkout", async () => {
  const root = await mkdtemp(join(tmpdir(), "falryn-fixture-modules-"));
  try {
    const bin = await createFixtureCommands(root);
    const command = Bun.spawn(
      [
        process.execPath,
        join(bin, "wc"),
        "-l",
        "-w",
        "-c",
        "src/domain/hush/reducers/log/format.ts",
      ],
      { cwd: root, stdout: "pipe", stderr: "pipe" },
    );
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(command.stdout).text(),
      new Response(command.stderr).text(),
      command.exited,
    ]);
    expect(exitCode).toBe(0);
    expect(stderr).toBe("");
    expect(stdout.trim()).toBe("127     384    3268 src/domain/hush/reducers/log/format.ts");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
