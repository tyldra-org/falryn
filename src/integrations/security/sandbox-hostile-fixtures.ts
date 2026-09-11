import { dlopen, FFIType, ptr } from "bun:ffi";
import { Resolver } from "node:dns/promises";
/** Executed as an untrusted source or compiled child by the qualification suite. */
import { fstatSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const input = JSON.parse(process.argv.at(-1) ?? "{}") as {
  root: string;
  outside: string;
  tcpPort: number;
  dnsPort: number;
  parent: number;
  descriptor: number;
  descriptorInode: number;
  debugTarget: number;
};
const results: Record<string, string> = {};
function attempt(name: string, effect: () => unknown): void {
  try {
    effect();
    results[name] = "allowed";
  } catch {
    results[name] = "denied";
  }
}
async function attemptAsync(name: string, effect: () => Promise<unknown>): Promise<void> {
  try {
    await effect();
    results[name] = "allowed";
  } catch {
    results[name] = "denied";
  }
}
attempt("inside", () => writeFileSync(join(input.root, "inside"), "ok"));
attempt("read", () => readFileSync(join(input.outside, "sentinel")));
attempt("mountAlias", () =>
  readFileSync(
    `/System/Volumes/Data${input.outside.replace(/^\/var\//, "/private/var/")}/sentinel`,
  ),
);
attempt("write", () => writeFileSync(join(input.outside, "written"), "bad"));
attempt("hiddenHome", () => readFileSync(join(input.outside, ".config", "credential")));
attempt("symlink", () => readFileSync(join(input.root, "escape", "sentinel")));
attempt("delete", () => unlinkSync(join(input.outside, "delete")));
attempt("rename", () => renameSync(join(input.outside, "rename"), join(input.root, "stolen")));
attempt("child", () => {
  const child = Bun.spawnSync(["/bin/sh", "-c", "exit 0"], {
    env: {},
    stdout: "ignore",
    stderr: "ignore",
  });
  if (child.exitCode !== 0) throw new Error("child-denied");
});
attempt("daemon", () => {
  const child = Bun.spawnSync(["/bin/sh", "-c", "(sleep 0.01 </dev/null >/dev/null 2>&1 &)"], {
    env: {},
    stdout: "ignore",
    stderr: "ignore",
    detached: true,
  });
  if (child.exitCode !== 0) throw new Error("daemon-denied");
});
attempt("signal", () => process.kill(input.parent, 0));
results.environment = process.env.FALRYN_SANDBOX_PARENT_SECRET === undefined ? "denied" : "allowed";
results.explicitEnvironment =
  process.env.SANDBOX_FIXTURE_PUBLIC === "deliberate" ? "allowed" : "denied";
attempt("descriptor", () => {
  if (fstatSync(input.descriptor).ino !== input.descriptorInode)
    throw new Error("different-descriptor");
});
attempt("listen", () => {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") });
  server.stop(true);
});
await attemptAsync("tcp", () =>
  fetch(`http://127.0.0.1:${input.tcpPort}/`, { signal: AbortSignal.timeout(1_000) }).then(
    async (response) => {
      if ((await response.text()) !== "sandbox-positive-control") throw new Error("wrong-server");
    },
  ),
);
await attemptAsync("proxy", () =>
  fetch("http://sandbox-fixture.invalid/", {
    proxy: `http://127.0.0.1:${input.tcpPort}`,
    signal: AbortSignal.timeout(1_000),
  }).then(async (response) => {
    if ((await response.text()) !== "sandbox-positive-control") throw new Error("wrong-proxy");
  }),
);
await attemptAsync("dns", async () => {
  const resolver = new Resolver({ timeout: 200, tries: 1 });
  resolver.setServers([`127.0.0.1:${input.dnsPort}`]);
  const result = await resolver.resolve4("sandbox-fixture.test");
  if (result[0] !== "127.0.0.1") throw new Error("wrong-dns-answer");
});
attempt("parentArguments", () => {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    sysctl: {
      args: [FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr, FFIType.ptr, FFIType.u64],
      returns: FFIType.i32,
    },
  });
  try {
    const query = new Int32Array([1, 49, input.debugTarget]);
    const output = new Uint8Array(64 * 1_024);
    const length = new BigUint64Array([BigInt(output.byteLength)]);
    if (libc.symbols.sysctl(ptr(query), 3, ptr(output), ptr(length), null, 0) !== 0)
      throw new Error("parent-arguments-denied");
    if (
      !new TextDecoder()
        .decode(output)
        .includes("FALRYN_SANDBOX_PROBE_SECRET=fixture-read-forbidden")
    )
      throw new Error("no-credential-bytes");
  } finally {
    libc.close();
  }
});
attempt("debug", () => {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    ptrace: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    if (libc.symbols.ptrace(10, input.debugTarget, null, 0) !== 0) throw new Error("debug-denied");
  } finally {
    libc.close();
  }
});
attempt("ptrace", () => {
  const libc = dlopen("/usr/lib/libSystem.B.dylib", {
    ptrace: { args: [FFIType.i32, FFIType.i32, FFIType.ptr, FFIType.i32], returns: FFIType.i32 },
  });
  try {
    if (libc.symbols.ptrace(0, 0, null, 0) !== 0) throw new Error("ptrace-denied");
  } finally {
    libc.close();
  }
});
console.log(JSON.stringify(results));
