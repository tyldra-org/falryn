/** Birth-identity probes for reconciliation. These functions never signal or adopt a process. */
import { closeSync, openSync, readSync } from "node:fs";
import type {
  ProcessIdentityPort,
  ProcessIdentityProbe,
} from "../../domain/process/process-identity.ts";

const UNAVAILABLE = { kind: "unavailable" } as const;
const VANISHED = { kind: "vanished" } as const;
const MAX_STAT_BYTES = 16 * 1_024;

/** Only bounded kernel procfs records; synchronous reads avoid yielding before the child birth probe. */
function boundedFile(path: string): string {
  const file = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(MAX_STAT_BYTES + 1);
    const bytesRead = readSync(file, buffer, 0, buffer.length, 0);
    if (bytesRead > MAX_STAT_BYTES) throw new Error("process identity exceeds bound");
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    closeSync(file);
  }
}

/** /proc/<pid>/stat field 22, parsed after the final command-name parenthesis. */
export function parseLinuxProcessIdentity(
  stat: string,
  pid: number,
  boot: string,
): ProcessIdentityProbe {
  if (stat.length > MAX_STAT_BYTES || !/^[a-f0-9-]{36}$/.test(boot)) return UNAVAILABLE;
  const start = stat.indexOf(" (");
  const end = stat.lastIndexOf(")");
  if (start < 1 || end < start || stat.slice(0, start) !== String(pid)) return UNAVAILABLE;
  const fields = stat
    .slice(end + 1)
    .trim()
    .split(/\s+/);
  const ticks = fields[19];
  if (ticks === undefined || !/^[0-9]{1,20}$/.test(ticks)) return UNAVAILABLE;
  return { kind: "present", identity: { platform: "linux", pid, birth: `${boot}:${ticks}` } };
}

function inspectLinux(pid: number): ProcessIdentityProbe {
  let boot: string;
  try {
    boot = boundedFile("/proc/sys/kernel/random/boot_id").trim();
  } catch {
    return UNAVAILABLE;
  }
  try {
    return parseLinuxProcessIdentity(boundedFile(`/proc/${pid}/stat`), pid, boot);
  } catch (error) {
    return error !== null && typeof error === "object" && "code" in error && error.code === "ENOENT"
      ? VANISHED
      : UNAVAILABLE;
  }
}

/** Darwin's public proc_bsdinfo ABI: 136 bytes; pid at 12; start seconds/useconds at 120/128. */
async function inspectDarwin(pid: number): Promise<ProcessIdentityProbe> {
  const { dlopen, ptr, read } = await import("bun:ffi");
  const library = dlopen("/usr/lib/libproc.dylib", {
    proc_pidinfo: { args: ["i32", "i32", "u64", "ptr", "i32"], returns: "i32" },
    __error: { args: [], returns: "ptr" },
    sysctlbyname: { args: ["ptr", "ptr", "ptr", "ptr", "u64"], returns: "i32" },
  });
  try {
    const query = (target: number): { birth: string } | "vanished" | "unavailable" => {
      const bytes = new Uint8Array(136);
      const size = library.symbols.proc_pidinfo(target, 3, 0, ptr(bytes), bytes.byteLength);
      if (size !== bytes.byteLength) {
        const errno = library.symbols.__error();
        return errno !== null && read.i32(errno) === 3 ? "vanished" : "unavailable";
      }
      const view = new DataView(bytes.buffer);
      if (view.getUint32(12, true) !== target) return "unavailable";
      const seconds = view.getBigUint64(120, true);
      const micros = view.getBigUint64(128, true);
      if (seconds === 0n || micros >= 1_000_000n) return "unavailable";
      return { birth: `${seconds}.${micros}` };
    };
    const name = new TextEncoder().encode("kern.bootsessionuuid\0");
    const bootBytes = new Uint8Array(64);
    const bootLength = new BigUint64Array([BigInt(bootBytes.byteLength)]);
    if (library.symbols.sysctlbyname(ptr(name), ptr(bootBytes), ptr(bootLength), null, 0) !== 0)
      return UNAVAILABLE;
    const boot = new TextDecoder()
      .decode(bootBytes.subarray(0, Number(bootLength[0]) - 1))
      .toLowerCase();
    if (!/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(boot)) return UNAVAILABLE;
    const target = query(pid);
    if (typeof target === "string") return target === "vanished" ? VANISHED : UNAVAILABLE;
    return {
      kind: "present",
      identity: { platform: "darwin", pid, birth: `${boot}:${target.birth}` },
    };
  } finally {
    library.close();
  }
}

export function createHostProcessIdentityPort(platform = process.platform): ProcessIdentityPort {
  return {
    async inspect(pid) {
      if (!Number.isSafeInteger(pid) || pid < 1 || pid > 2_147_483_647) return UNAVAILABLE;
      try {
        if (platform === "linux") return await inspectLinux(pid);
        if (platform === "darwin") return await inspectDarwin(pid);
        return UNAVAILABLE;
      } catch {
        return UNAVAILABLE;
      }
    },
  };
}
