/** Deterministic ping, rsync, and ssh output for the Hush scorecard. */

export function networkFixtureOutput(executable: string, args: readonly string[]): string | null {
  if (executable === "ping") return pingOutput(args);
  if (executable === "rsync") return rsyncOutput(args);
  if (executable === "ssh") return sshOutput(args);
  return null;
}

function pingOutput(args: readonly string[]): string {
  const target = args.at(-1);
  if (target === "example.test") {
    return [
      "PING example.test (192.0.2.80): 56 data bytes",
      "64 bytes from 192.0.2.80: icmp_seq=0 ttl=57 time=12.345 ms",
      "64 bytes from 192.0.2.80: icmp_seq=1 ttl=57 time=13.210 ms",
      "64 bytes from 192.0.2.80: icmp_seq=2 ttl=57 time=11.980 ms",
      "--- example.test ping statistics ---",
      "3 packets transmitted, 3 packets received, 0.0% packet loss",
      "round-trip min/avg/max/stddev = 11.980/12.512/13.210/0.516 ms",
    ].join("\n");
  }
  if (target === "linux.example.test") {
    return [
      "PING linux.example.test (192.0.2.81) 56(84) bytes of data.",
      "64 bytes from 192.0.2.81: icmp_seq=1 ttl=56 time=18.2 ms",
      "Request timeout for icmp_seq 2",
      "64 bytes from 192.0.2.81: icmp_seq=3 ttl=56 time=19.1 ms",
      "--- linux.example.test ping statistics ---",
      "3 packets transmitted, 2 received, 33.3333% packet loss, time 2002ms",
      "rtt min/avg/max/mdev = 18.200/18.650/19.100/0.450 ms",
    ].join("\n");
  }
  throw new Error(`unsupported ping fixture arguments: ${args.join(" ")}`);
}

function rsyncOutput(args: readonly string[]): string {
  if (args.includes("--delete")) {
    return [
      "building file list ... done",
      "created directory backup",
      ">f+++++++++ src/new.ts",
      ">f.st...... src/changed.ts",
      "*deleting   src/obsolete.ts",
      "sent 736 bytes  received 42 bytes  1,556.00 bytes/sec",
      "total size is 784  speedup is 1.01",
    ].join("\n");
  }
  return [
    "sending incremental file list",
    "src/",
    "src/context.ts",
    "          4,096 100%    4.00MB/s    0:00:00 (xfr#1, to-chk=1/3)",
    "src/hush.ts",
    "          8,192 100%    8.00MB/s    0:00:00 (xfr#2, to-chk=0/3)",
    "sent 12,736 bytes  received 84 bytes  25,640.00 bytes/sec",
    "total size is 12,288  speedup is 0.96",
  ].join("\n");
}

function sshOutput(args: readonly string[]): string {
  if (args.includes("--json")) {
    return JSON.stringify(
      {
        host: "example.test",
        status: "ready",
        session: "req-736",
        context: { reducers: 82, complete: true },
      },
      null,
      2,
    );
  }
  if (args.includes("status")) {
    return ["host example.test", "status ready", "session req-736", "reducers 82"].join("\n");
  }
  return ["connected example.test", "remote command: ok"].join("\n");
}
