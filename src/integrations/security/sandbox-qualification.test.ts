import { expect, test } from "bun:test";
import { createSocket } from "node:dgram";
import { closeSync, fstatSync, openSync } from "node:fs";
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { duration } from "../../domain/foundation/index.ts";
import { OFFLINE_SANDBOX_NETWORK, SINGLE_PROCESS_SANDBOX } from "../../domain/security/sandbox.ts";
import { createHostProcessCapturePort } from "../process/host-process-capture.ts";
import { createHostSandbox } from "./host-sandbox.ts";

const qualifiedTest = createHostSandbox().probe().status === "available" ? test : test.skip;
qualifiedTest(
  "source and compiled hostile children obey filesystem, network, process and injection boundaries",
  async () => {
    const directory = await mkdtemp(join(tmpdir(), "falryn-sandbox-qualification-"));
    const root = join(directory, 'admitted "λ"');
    const outside = join(directory, "outside");
    const dns = createSocket("udp4");
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("sandbox-positive-control"),
    });
    let descriptor: number | undefined;
    let debugTarget: Bun.Subprocess | undefined;
    const previous = process.env.FALRYN_SANDBOX_PARENT_SECRET;
    try {
      await mkdir(root);
      await mkdir(join(outside, ".config"), { recursive: true });
      await writeFile(join(outside, "sentinel"), "fixture-secret");
      await writeFile(join(outside, ".config", "credential"), "fixture-credential");
      await symlink(outside, join(root, "escape"));
      descriptor = openSync(join(outside, "sentinel"), "r");
      process.env.FALRYN_SANDBOX_PARENT_SECRET = "must-not-inherit";
      dns.on("message", (query, peer) => {
        const header = Buffer.from(query.subarray(0, 12));
        header.writeUInt16BE(0x8180, 2);
        header.writeUInt16BE(1, 6);
        const answer = Buffer.from([0xc0, 0x0c, 0, 1, 0, 1, 0, 0, 0, 1, 0, 4, 127, 0, 0, 1]);
        dns.send(Buffer.concat([header, query.subarray(12), answer]), peer.port, peer.address);
      });
      await new Promise<void>((resolve) => dns.bind(0, "127.0.0.1", resolve));
      const source = join(root, "hostile.ts");
      await copyFile(join(import.meta.dir, "sandbox-hostile-fixtures.ts"), source);
      const compiled = join(root, "hostile");
      const build = Bun.spawn(
        [process.execPath, "build", source, "--compile", "--outfile", compiled],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const debugSource = join(directory, "debug-target.c");
      const debugBinary = join(directory, "debug-target");
      await writeFile(debugSource, "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n");
      const compiler = Bun.spawn(["/usr/bin/clang", debugSource, "-o", debugBinary], {
        stdout: "ignore",
        stderr: "pipe",
      });
      expect(await compiler.exited).toBe(0);
      const sandbox = createHostSandbox({
        policy: () => ({
          generation: 1,
          mode: "strict",
          authority: "user",
          boundary: {
            readRoots: [],
            writeRoots: [root],
            network: OFFLINE_SANDBOX_NETWORK,
            processes: SINGLE_PROCESS_SANDBOX,
            lifecyclePaths: [],
          },
        }),
      });
      for (const distribution of ["source", "compiled"] as const) {
        for (const mode of ["strict", "off"] as const) {
          await writeFile(join(outside, "delete"), "keep");
          await writeFile(join(outside, "rename"), "keep");
          debugTarget = Bun.spawn([debugBinary], {
            env: { FALRYN_SANDBOX_PROBE_SECRET: "fixture-read-forbidden" },
            stdout: "ignore",
            stderr: "ignore",
          });
          const capture = createHostProcessCapturePort(mode === "strict" ? { sandbox } : {});
          const result = await capture.run({
            executable: distribution === "source" ? process.execPath : compiled,
            argv: [
              ...(distribution === "source" ? [source] : []),
              JSON.stringify({
                root,
                outside,
                tcpPort: server.port,
                dnsPort: dns.address().port,
                parent: process.pid,
                descriptor,
                descriptorInode: fstatSync(descriptor).ino,
                debugTarget: debugTarget.pid,
              }),
            ],
            cwd: root,
            environment: { PATH: "/usr/bin:/bin", SANDBOX_FIXTURE_PUBLIC: "deliberate" },
            timeoutMs: duration(5_000),
            maxOutputBytes: 16_384,
          });
          debugTarget.kill("SIGKILL");
          await debugTarget.exited;
          debugTarget = undefined;
          expect(result.ok).toBe(true);
          if (!result.ok) continue;
          if (result.value.exit.exitCode !== 0) console.error(result.value.stderr.inlineText);
          expect(result.value.exit.exitCode).toBe(0);
          const expected = mode === "strict" ? "denied" : "allowed";
          // This host refuses sibling debugger attachment in both modes. This is
          // coverage of the hostile attempt, not proof of sandbox-specific denial.
          expect(JSON.parse(result.value.stdout.inlineText ?? "null")).toEqual({
            inside: "allowed",
            read: expected,
            mountAlias: expected,
            write: expected,
            hiddenHome: expected,
            symlink: expected,
            delete: expected,
            rename: expected,
            child: expected,
            daemon: expected,
            signal: expected,
            environment: "denied",
            explicitEnvironment: "allowed",
            descriptor: "denied",
            listen: expected,
            tcp: expected,
            proxy: expected,
            dns: expected,
            debug: "denied",
            parentArguments: expected,
            ptrace: expected,
          });
          expect(result.value.sandbox).toMatchObject({ effectiveMode: mode, state: "terminated" });
        }
      }
    } finally {
      server.stop(true);
      dns.close();
      if (debugTarget) {
        debugTarget.kill("SIGKILL");
        await debugTarget.exited;
      }
      if (descriptor !== undefined) closeSync(descriptor);
      if (previous === undefined) delete process.env.FALRYN_SANDBOX_PARENT_SECRET;
      else process.env.FALRYN_SANDBOX_PARENT_SECRET = previous;
      await rm(directory, { recursive: true, force: true });
    }
  },
  30_000,
);

qualifiedTest(
  "source and compiled strict children terminate on cancellation, deadline and crash",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "falryn-sandbox-lifecycle-"));
    try {
      const source = join(root, "lifecycle.ts");
      const compiled = join(root, "lifecycle");
      await writeFile(
        source,
        'if (process.argv.at(-1) === "crash") process.exit(7); setInterval(() => {}, 100);',
      );
      const build = Bun.spawn(
        [process.execPath, "build", source, "--compile", "--outfile", compiled],
        { stdout: "ignore", stderr: "pipe" },
      );
      expect(await build.exited).toBe(0);
      const sandbox = createHostSandbox({
        policy: () => ({
          generation: 1,
          mode: "strict",
          authority: "user",
          boundary: {
            readRoots: [root],
            writeRoots: [],
            network: OFFLINE_SANDBOX_NETWORK,
            processes: SINGLE_PROCESS_SANDBOX,
            lifecyclePaths: [],
          },
        }),
      });
      const capture = createHostProcessCapturePort({ sandbox });
      for (const distribution of ["source", "compiled"] as const) {
        for (const cause of ["cancel", "timeout", "crash"] as const) {
          const controller = new AbortController();
          const timer = cause === "cancel" ? setTimeout(() => controller.abort(), 200) : undefined;
          try {
            const result = await capture.run({
              executable: distribution === "source" ? process.execPath : compiled,
              argv: [...(distribution === "source" ? [source] : []), cause],
              cwd: root,
              environment: {},
              signal: controller.signal,
              timeoutMs: duration(cause === "timeout" ? 200 : 2_000),
              maxOutputBytes: 1_024,
            });
            expect(result.ok).toBe(true);
            if (!result.ok) continue;
            expect(result.value.sandbox?.state).toBe("terminated");
            if (cause === "crash") expect(result.value.exit.exitCode).toBe(7);
            else
              expect(result.value.stop.kind).toBe(cause === "cancel" ? "cancelled" : "timed-out");
            const pid = result.value.sandbox?.pid;
            expect(typeof pid).toBe("number");
            if (typeof pid === "number") expect(() => process.kill(pid, 0)).toThrow();
          } finally {
            if (timer !== undefined) clearTimeout(timer);
          }
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  30_000,
);
