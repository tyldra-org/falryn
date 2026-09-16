import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHostCommandRunner } from "./host-commands.ts";
import { inspectEnvironmentSource } from "./host-environment-preparation.ts";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
const supported = process.platform !== "win32" && Bun.which("zsh") !== null;
const interpreter = process.platform === "darwin" ? "/bin/zsh" : "/usr/bin/zsh";
async function fixture(script: string, exports = ["VALUE", "EMPTY", "REMOVED", "PATH"]) {
  const root = await mkdtemp(join(tmpdir(), "falryn env "));
  roots.push(root);
  await writeFile(join(root, "env.zsh"), script);
  const inspect = () =>
    inspectEnvironmentSource({
      root,
      cwd: root,
      commands: createHostCommandRunner(),
      preparation: { interpreter, exports, required: true },
    });
  return { root, inspect };
}

test.skipIf(!supported)(
  "capture supports zero and 64 declared exports within the argument bound",
  async () => {
    for (const count of [0, 64]) {
      const names = Array.from({ length: count }, (_, index) => `VALUE_${index}`);
      const f = await fixture(names.map((name) => `export ${name}=value`).join("\n") || ":", names);
      const source = await f.inspect();
      if (source.kind !== "source") throw new Error(source.code);
      const result = await source.run({}, new AbortController().signal);
      expect(result.kind).toBe("prepared");
      if (result.kind === "prepared") expect(Object.keys(result.delta.set)).toHaveLength(count);
    }
  },
);

test.skipIf(!supported)(
  "Zsh captures only declared exports with exact framing and never reads user rc files",
  async () => {
    const f = await fixture(
      'export VALUE=$\'space = and\\nnewline\'; export EMPTY=""; unset REMOVED; export PATH="/prepared"; print diagnostic-secret; print diagnostic-secret >&2; alias invented=echo; function extra() { :; }',
    );
    for (const file of [".zshrc", ".zprofile", ".zshenv", ".zlogin"])
      await writeFile(join(f.root, file), 'print rc-loaded > "$HOME/rc-loaded"\nexit 9');
    const source = await f.inspect();
    expect(source.kind).toBe("source");
    if (source.kind !== "source") throw new Error(source.code);
    expect(
      await readFile(join(f.root, "rc-loaded")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
    const result = await source.run(
      { HOME: f.root, PATH: "/usr/bin:/bin", REMOVED: "old" },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      kind: "prepared",
      delta: {
        set: { VALUE: "space = and\nnewline", EMPTY: "", PATH: "/prepared" },
        unset: ["REMOVED"],
      },
    });
    expect(JSON.stringify(result)).not.toContain("diagnostic-secret");
    expect(
      await readFile(join(f.root, "rc-loaded")).then(
        () => true,
        () => false,
      ),
    ).toBe(false);
  },
);

test.skipIf(!supported)(
  "source replacement, early exit, diagnostic overflow and cancellation never return partial exports",
  async () => {
    for (const script of [
      "export VALUE=secret; exit 0",
      "export VALUE=secret; return 1",
      "repeat 70000; do print x >&2; done",
    ]) {
      const f = await fixture(script);
      const source = await f.inspect();
      if (source.kind !== "source") throw new Error(source.code);
      const result = await source.run({ PATH: "/usr/bin:/bin" }, new AbortController().signal);
      expect(result.kind).toBe("failed");
      expect(JSON.stringify(result)).not.toContain("secret");
    }
    const f = await fixture("export VALUE=old");
    const source = await f.inspect();
    if (source.kind !== "source") throw new Error(source.code);
    await writeFile(join(f.root, "env.zsh"), "export VALUE=new");
    expect(await source.current()).toBe(false);
    expect((await source.run({}, new AbortController().signal)).kind).toBe("failed");
    const fresh = await f.inspect();
    if (fresh.kind !== "source") throw new Error(fresh.code);
    expect((await fresh.run({}, AbortSignal.abort())).kind).toBe("failed");
  },
);

test.skipIf(!supported)(
  "a symlink outside the selected root is unavailable without executing it",
  async () => {
    const a = await fixture("export VALUE=a");
    const b = await fixture("export VALUE=b");
    await rm(join(a.root, "env.zsh"));
    await symlink(join(b.root, "env.zsh"), join(a.root, "env.zsh"));
    expect((await a.inspect()).kind).toBe("unavailable");
  },
);
