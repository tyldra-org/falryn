import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { processBirthIdentitySchema } from "../../domain/process/process-identity.ts";
import {
  createHostProcessIdentityPort,
  parseLinuxProcessIdentity,
} from "./host-process-identity.ts";

const boot = "12345678-1234-1234-1234-123456789abc";

describe("host process birth identity", () => {
  test("Linux stat parsing tolerates spaces and parentheses in command names", () => {
    const fields = ["S", ...Array.from({ length: 18 }, () => "0"), "123456", "0", "0"];
    expect(
      parseLinuxProcessIdentity(`42 (command (odd) name) ${fields.join(" ")}`, 42, boot),
    ).toEqual({
      kind: "present",
      identity: { platform: "linux", pid: 42, birth: `${boot}:123456` },
    });
    expect(parseLinuxProcessIdentity(`41 (command) ${fields.join(" ")}`, 42, boot).kind).toBe(
      "unavailable",
    );
    expect(parseLinuxProcessIdentity("42 (command) S 1 2", 42, boot).kind).toBe("unavailable");
  });

  test("invalid identifiers and unsupported Windows ownership fail closed", async () => {
    const host = createHostProcessIdentityPort();
    for (const pid of [-1, 0, 1.5, Number.NaN, 2_147_483_648])
      expect((await host.inspect(pid)).kind).toBe("unavailable");
    expect((await createHostProcessIdentityPort("win32").inspect(process.pid)).kind).toBe(
      "unavailable",
    );
  });

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "the current process has stable native birth evidence",
    async () => {
      const host = createHostProcessIdentityPort();
      const first = await host.inspect(process.pid);
      expect(first.kind).toBe("present");
      if (first.kind !== "present") throw new Error("native birth probe unavailable");
      expect(processBirthIdentitySchema.safeParse(first.identity).success).toBe(true);
      expect(await host.inspect(process.pid)).toEqual(first);
    },
  );

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "a reaped child is vanished, never a live PID-only handle",
    async () => {
      const child = Bun.spawn([process.execPath, "-e", "setTimeout(() => {}, 30000)"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      try {
        const host = createHostProcessIdentityPort();
        expect((await host.inspect(child.pid)).kind).toBe("present");
        child.kill();
        await child.exited;
        expect((await host.inspect(child.pid)).kind).toBe("vanished");
      } finally {
        child.kill();
        await child.exited;
      }
    },
  );

  test.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
    "a standalone executable retains native birth probing and closes the FFI handle",
    async () => {
      const directory = await mkdtemp(join(tmpdir(), "falryn-compiled-identity-"));
      try {
        const entry = join(directory, "probe.ts");
        const binary = join(directory, "probe");
        const source = fileURLToPath(new URL("./host-process-identity.ts", import.meta.url));
        await writeFile(
          entry,
          `import { createHostProcessIdentityPort } from ${JSON.stringify(source)};
const host = createHostProcessIdentityPort();
const first = await host.inspect(process.pid);
const second = await host.inspect(process.pid);
console.log(JSON.stringify({ first, second }));
`,
        );
        const built = Bun.spawnSync(
          [process.execPath, "build", entry, "--compile", "--outfile", binary],
          {
            stdout: "pipe",
            stderr: "pipe",
            timeout: 30_000,
          },
        );
        expect({ exitCode: built.exitCode, stderr: built.stderr.toString() }).toMatchObject({
          exitCode: 0,
        });
        const ran = Bun.spawnSync([binary], { stdout: "pipe", stderr: "pipe", timeout: 5_000 });
        expect(ran.exitCode).toBe(0);
        expect(ran.stderr.toString()).toBe("");
        const result = JSON.parse(ran.stdout.toString());
        expect(result.first.kind).toBe("present");
        expect(processBirthIdentitySchema.safeParse(result.first.identity).success).toBe(true);
        expect(result.second).toEqual(result.first);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
    40_000,
  );
});
