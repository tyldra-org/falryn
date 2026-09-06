import { chmod, cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HUSH_PROJECTION_CASES } from "./corpus.ts";

export async function createFixtureCommands(root: string): Promise<string> {
  const bin = join(root, "bin");
  await mkdir(bin, { recursive: true });
  await cp(
    join(import.meta.dir, "../../fixtures/hush-projection-command"),
    join(bin, "hush-projection-command"),
    { recursive: true },
  );
  const source = join(import.meta.dir, "../../fixtures", "hush-projection-command.ts");
  const fixtureSource = (await readFile(source, "utf8")).replace(
    /^#![^\n]+/u,
    `#!${process.execPath}`,
  );
  await Promise.all(
    [
      "hush-cloud-output.ts",
      "hush-http-output.ts",
      "hush-infra-output.ts",
      "hush-network-output.ts",
    ].map(async (name) => {
      await writeFile(
        join(bin, name),
        await readFile(join(import.meta.dir, "../../fixtures", name)),
      );
    }),
  );
  await Promise.all(
    [...new Set(HUSH_PROJECTION_CASES.map((fixture) => fixture.executable))]
      .filter((executable) => executable !== "bash")
      .map(async (executable) => {
        const target = join(bin, executable);
        await writeFile(target, fixtureSource);
        await chmod(target, 0o755);
      }),
  );
  return bin;
}
