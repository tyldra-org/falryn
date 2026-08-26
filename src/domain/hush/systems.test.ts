/** Hush containers, infrastructure, system, and network commands behavior. */

import { describe, expect, test } from "bun:test";
import { artifactId } from "../artifact.ts";
import { DEFAULT_HUSH_REDUCED_BYTES, reduceHush } from "../index.ts";
import { argv, encoder, report } from "./fixtures.ts";

describe("Hush containers, infrastructure, system, and network commands", () => {
  test("keeps arbitrary and partial container output exact", () => {
    const applicationOutput = "application-owned output\nsecond exact line\n";
    const run = reduceHush({
      command: argv("/usr/bin/docker", ["run", "falryn:dev"]),
      capture: report(applicationOutput),
    });
    expect(run.ok).toBe(true);
    if (!run.ok) throw new Error("expected an exact container result");
    expect(run.value.reducerId).toBe("container.operation");
    expect(run.value.reducedText).toBe(applicationOutput);

    const partial = reduceHush({
      command: argv("/usr/bin/docker", ["inspect", "falryn-dev"]),
      capture: report('[{"Id":"sha256:736"}]\n', {
        truncated: true,
        artifact: true,
      }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial container result");
    expect(partial.value.reducerId).toBe("container.table");
    expect(partial.value.reducedText).toBe('[{"Id":"sha256:736"}]\n');
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });

  test("keeps arbitrary Kubernetes logs and partial tables exact", () => {
    const applicationOutput = "ready\nready\nrequest=req-736 status=ok\n";
    const logs = reduceHush({
      command: argv("/usr/bin/kubectl", ["logs", "falryn-api"]),
      capture: report(applicationOutput),
    });
    expect(logs.ok).toBe(true);
    if (!logs.ok) throw new Error("expected exact Kubernetes logs");
    expect(logs.value.reducerId).toBe("kubernetes.log");
    expect(logs.value.reducedText).toBe(applicationOutput);

    const partial = reduceHush({
      command: argv("/usr/bin/oc", ["get", "pods"]),
      capture: report("NAME   READY\nfalryn 1/1\n", {
        truncated: true,
        artifact: true,
      }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected a partial Kubernetes result");
    expect(partial.value.reducerId).toBe("kubernetes.table");
    expect(partial.value.reducedText).toBe("NAME   READY\nfalryn 1/1\n");
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));
  });

  test("keeps partial cloud output and unrecognized infrastructure output exact", () => {
    const cloudSource = '{\n  "Reservations": [\n    {"InstanceId":"i-0736"}\n';
    const cloud = reduceHush({
      command: argv("/usr/bin/aws", ["ec2", "describe-instances"]),
      capture: report(cloudSource, { truncated: true, artifact: true }),
    });
    expect(cloud.ok).toBe(true);
    if (!cloud.ok) throw new Error("expected partial cloud output");
    expect(cloud.value.reducerId).toBe("cloud.aws");
    expect(cloud.value.reducedText).toBe(cloudSource);
    expect(cloud.value.truncated).toBe(true);
    expect(cloud.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));

    const sopsSource = "provider:\n  name: falryn\n  key_ref: local/provider\n";
    const sops = reduceHush({
      command: argv("/usr/bin/sops", ["config.yaml"]),
      capture: report(sopsSource),
    });
    expect(sops.ok).toBe(true);
    if (!sops.ok) throw new Error("expected exact SOPS output");
    expect(sops.value.reducerId).toBe("infra.operation");
    expect(sops.value.reducedText).toBe(sopsSource);
  });

  test("keeps partial and failed network command output exact", () => {
    const partialSource = [
      "PING example.test (192.0.2.80): 56 data bytes",
      "64 bytes from 192.0.2.80: icmp_seq=0 ttl=57 time=12.345 ms",
    ].join("\n");
    const partial = reduceHush({
      command: argv("/sbin/ping", ["-c", "3", "example.test"]),
      capture: report(partialSource, { truncated: true, artifact: true }),
    });
    expect(partial.ok).toBe(true);
    if (!partial.ok) throw new Error("expected partial ping output");
    expect(partial.value.reducerId).toBe("network.command");
    expect(partial.value.reducedText).toBe(partialSource);
    expect(partial.value.truncated).toBe(true);
    expect(partial.value.expansion.stdoutArtifact).toBe(artifactId.from("cap-1.stdout"));

    const failureSource = "ssh: connect to host example.test port 22: Connection refused\n";
    const failure = reduceHush({
      command: argv("/usr/bin/ssh", ["example.test", "falryn", "status"]),
      capture: report("", { stderr: failureSource, exitCode: 255 }),
    });
    expect(failure.ok).toBe(true);
    if (!failure.ok) throw new Error("expected failed ssh output");
    expect(failure.value.reducerId).toBe("network.command");
    expect(failure.value.reducedText).toBe(`stderr:\n${failureSource}`);
  });

  test("journalctl shares stable fields while retaining every event fact", () => {
    const output = [
      "Aug 24 10:00:00 falryn-host falryn[736]: INFO session started session=demo",
      "Aug 24 10:00:01 falryn-host falryn[736]: INFO context engine ready reducers=82",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:02 falryn-host falryn[736]: INFO waiting for provider",
      "Aug 24 10:00:03 falryn-host falryn[736]: WARN reducer fallback command=unknown",
      "Aug 24 10:00:04 falryn-host falryn[736]: ERROR capture unavailable id=cap-42",
      "Aug 24 10:00:05 falryn-host falryn[736]: INFO request complete tokens=219",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/journalctl", ["-u", "falryn", "-n", "20"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("transform.log");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toContain("Aug 24 10:00 falryn-host falryn[736]");
    expect(reduced.value.reducedText).toContain("00 [I] session started session=demo");
    expect(reduced.value.reducedText).toContain("02 [I] waiting for provider ×3");
    expect(reduced.value.reducedText).toContain("03 [W] reducer fallback command=unknown");
    expect(reduced.value.reducedText).toContain("04 [E] capture unavailable id=cap-42");
    expect(reduced.value.reducedText).toContain("05 [I] request complete tokens=219");
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeLessThan(
      encoder.encode(output).byteLength,
    );
  });

  test("journal log projection keeps an unrecognized tail exact", () => {
    const output = "function example() {\n  return 736;\n}\n";
    const reduced = reduceHush({
      command: argv("/usr/bin/tail", ["-n", "3", "src/example.ts"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("files.tail");
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("psql retains every cell while removing validated table presentation", () => {
    const output = [
      " id | task                   | status  | token_savings",
      "----+------------------------+---------+--------------",
      "  1 | Optimize nested JSON   | done    |            32",
      "  2 | Preserve database rows | active  |             0",
      "  3 | Verify model context   | pending |            18",
      "(3 rows)",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/opt/homebrew/bin/psql", ["-c", "select * from work_items"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe(
      [
        "id\ttask\tstatus\ttoken_savings",
        "1\tOptimize nested JSON\tdone\t32",
        "2\tPreserve database rows\tactive\t0",
        "3\tVerify model context\tpending\t18",
        "",
      ].join("\n"),
    );
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("psql keeps failures and malformed result shapes exact", () => {
    const malformed = " id | task\n----+-----\n  1 | one\n(2 rows)\n";
    const malformedResult = reduceHush({
      command: argv("psql", ["-c", "select * from work_items"]),
      capture: report(malformed),
    });
    expect(malformedResult.ok).toBe(true);
    if (!malformedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(malformedResult.value.reducedText).toBe(malformed);
    expect(malformedResult.value.strategy).toBe("passthrough");

    const failure = "psql: error: connection to server failed\n";
    const failedResult = reduceHush({
      command: argv("psql", ["-c", "select 1"]),
      capture: report("", { stderr: failure, exitCode: 2 }),
    });
    expect(failedResult.ok).toBe(true);
    if (!failedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(failedResult.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(failedResult.value.omissions).toEqual([]);
  });

  test("sqlite3 retains every cell while removing validated table presentation", () => {
    const output = [
      "id  task           status",
      "--  -------------  ------",
      "1   Optimize JSON  done  ",
      "2   Preserve rows  active",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(output),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(reduced.value.strategy).toBe("specialized");
    expect(reduced.value.reducedText).toBe(
      "id\ttask\tstatus\n1\tOptimize JSON\tdone\n2\tPreserve rows\tactive\n",
    );
    expect(reduced.value.truncated).toBe(false);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("sqlite3 keeps compact modes, malformed shapes, and failures exact", () => {
    const list = "id|task\n1|Optimize JSON\n";
    const listed = reduceHush({
      command: argv("sqlite3", ["-header", "-list", ":memory:", "select 1"]),
      capture: report(list),
    });
    expect(listed.ok).toBe(true);
    if (!listed.ok) {
      throw new Error("expected a hush result");
    }
    expect(listed.value.reducedText).toBe(list);

    const malformed = "id  task\n--  ----\n1   one\n2 unexpected\n";
    const malformedResult = reduceHush({
      command: argv("sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(malformed),
    });
    expect(malformedResult.ok).toBe(true);
    if (!malformedResult.ok) {
      throw new Error("expected a hush result");
    }
    expect(malformedResult.value.reducedText).toBe(malformed);
    expect(malformedResult.value.strategy).toBe("passthrough");

    const failure = "Error: in prepare, no such table: missing\n";
    const failed = reduceHush({
      command: argv("sqlite3", [":memory:", "select * from missing"]),
      capture: report("", { stderr: failure, exitCode: 1 }),
    });
    expect(failed.ok).toBe(true);
    if (!failed.ok) {
      throw new Error("expected a hush result");
    }
    expect(failed.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(failed.value.omissions).toEqual([]);
  });

  test("sqlite3 keeps requested-pattern output exact instead of presentation-compacting it", () => {
    const output = [
      "id  task           status",
      "--  -------------  ------",
      "1   Optimize JSON  done  ",
      "2   Preserve rows  active",
      "",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("sqlite3", ["-header", "-column", ":memory:", "select 1"]),
      capture: report(output),
      importantPatterns: ["active"],
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toBe(output);
    expect(reduced.value.strategy).toBe("passthrough");
  });

  test("minifies structured JSON without changing its values", () => {
    const document = {
      account: "falryn",
      enabled: true,
      nested: { message: "spaces inside strings stay intact", values: [1, 2, 3] },
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/jq", [".", "fixture.json"]),
      capture: report(`${JSON.stringify(document, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.command");
    expect(JSON.parse(reduced.value.reducedText)).toEqual(document);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("projects the JSON helper as a complete key/type structure without values", () => {
    const manyFields = Object.fromEntries(
      Array.from({ length: 480 }, (_, index) => [
        `field-${index.toString().padStart(3, "0")}`,
        `private-${index}-`.repeat(6),
      ]),
    );
    const document = {
      serviceName: "falryn-private-value".repeat(8),
      enabled: true,
      targets: [
        { os: "darwin-private", arch: "arm64-private" },
        { os: "linux-private", arch: "x64-private" },
      ],
      metadata: { owner: "owner-private", nested: { marker: "deep-private" } },
      ports: [3000, 3001, 3002],
      manyFields,
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/json", ["config.json"]),
      capture: report(`${JSON.stringify(document, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("data.json");
    expect(reduced.value.reducedText).toContain("serviceName string");
    expect(reduced.value.reducedText).toContain("enabled boolean");
    expect(reduced.value.reducedText).toContain("targets[2]:");
    expect(reduced.value.reducedText).toContain("arch string");
    expect(reduced.value.reducedText).toContain("ports integer[3]");
    expect(reduced.value.reducedText).toContain("field-000 string");
    expect(reduced.value.reducedText).toContain("field-479 string");
    expect(reduced.value.reducedText).not.toContain("falryn-private-value");
    expect(reduced.value.reducedText).not.toContain("darwin-private");
    expect(reduced.value.reducedText).not.toContain("3000");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
  });

  test("keeps every curl JSON value while stripping only the transfer meter", () => {
    const body = {
      status: "ok",
      requestId: "req-736",
      result: { reducers: 81, complete: true },
    };
    const progress = [
      "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current",
      "                                 Dload  Upload   Total   Spent    Left  Speed",
      "100   102  100   102    0     0   1020      0 --:--:-- --:--:-- --:--:--  1020",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/curl", ["https://example.test/status"]),
      capture: report(`${JSON.stringify(body, null, 2)}\n`, { stderr: `${progress}\n` }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("network.curl");
    expect(JSON.parse(reduced.value.reducedText)).toEqual(body);
    expect(reduced.value.reducedText).not.toContain("% Total");
    expect(reduced.value.reducedText).not.toContain("1020");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains long curl text beyond the generic budget without line sampling", () => {
    const lines = Array.from(
      { length: 600 },
      (_, index) => `response-row-${index.toString().padStart(3, "0")} complete server context`,
    );
    const reduced = reduceHush({
      command: argv("/usr/bin/curl", ["https://example.test/long"]),
      capture: report(`${lines.join("\n")}\n`, {
        stderr: "  % Total    % Received % Xferd  Average Speed   Time    Time     Time  Current\n",
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last");
    expect(reduced.value.reducedText).not.toContain("% Total");
    expect(encoder.encode(reduced.value.reducedText).byteLength).toBeGreaterThan(
      DEFAULT_HUSH_REDUCED_BYTES,
    );
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("summarizes a wget download without losing its result facts", () => {
    const stderr = [
      "--2026-08-23 12:00:00--  https://example.test/releases/falryn.tar.gz",
      "Resolving example.test... 192.0.2.80",
      "Connecting to example.test|192.0.2.80|:443... connected.",
      "HTTP request sent, awaiting response... 200 OK",
      "Length: 1536 (1.5K) [application/gzip]",
      "Saving to: 'falryn.tar.gz'",
      "     0K .                                                     100% 1.50M=0.001s",
      "2026-08-23 12:00:00 (1.50 MB/s) - 'falryn.tar.gz' saved [1536/1536]",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/releases/falryn.tar.gz"]),
      capture: report("", { stderr: `${stderr}\n` }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("network.wget");
    expect(reduced.value.reducedText).toBe(
      "200 example.test/releases/falryn.tar.gz->falryn.tar.gz 1.5KB",
    );
    expect(reduced.value.omissions).toEqual([]);
  });

  test("retains every wget stdout line instead of applying RTK's line sample", () => {
    const lines = Array.from({ length: 40 }, (_, index) => `body-line-${index}`);
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["-O", "-", "https://example.test/data.txt"]),
      capture: report(`${lines.join("\n")}\n`, {
        stderr: "     0K .......... 100% 1.50M=0.001s\n",
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain(lines[0] ?? "missing-first");
    expect(reduced.value.reducedText).toContain(lines.at(-1) ?? "missing-last");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.omissions).toEqual([]);
    expect(reduced.value.truncated).toBe(false);
  });

  test("retains wget failures while removing only their transfer meter", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/missing"]),
      capture: report("", {
        stderr: [
          "HTTP request sent, awaiting response... 404 Not Found",
          "     0K .......... 100% 1.50M=0.001s",
          "ERROR 404: Not Found.",
          "",
        ].join("\n"),
        exitCode: 8,
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("404 Not Found");
    expect(reduced.value.reducedText).toContain("ERROR 404: Not Found.");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.exit.exitCode).toBe(8);
    expect(reduced.value.omissions).toEqual([]);
  });

  test("keeps a wget redirect chain instead of collapsing multiple responses", () => {
    const reduced = reduceHush({
      command: argv("/usr/bin/wget", ["https://example.test/latest"]),
      capture: report("", {
        stderr: [
          "HTTP request sent, awaiting response... 302 Found",
          "Location: https://cdn.example.test/falryn.tar.gz [following]",
          "HTTP request sent, awaiting response... 200 OK",
          "Length: 1536 (1.5K) [application/gzip]",
          "Saving to: 'falryn.tar.gz'",
          "     0K .......... 100% 1.50M=0.001s",
          "",
        ].join("\n"),
      }),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducedText).toContain("302 Found");
    expect(reduced.value.reducedText).toContain(
      "Location: https://cdn.example.test/falryn.tar.gz [following]",
    );
    expect(reduced.value.reducedText).toContain("200 OK");
    expect(reduced.value.reducedText).not.toContain("100%");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("normalizes aligned tables while retaining every cell", () => {
    const table = [
      "CONTAINER ID   IMAGE          STATUS          NAMES",
      "abc123         falryn:dev     Up 2 minutes    falryn-dev",
      "def456         postgres:17    Up 2 minutes    falryn-db",
    ].join("\n");
    const reduced = reduceHush({
      command: argv("/usr/bin/docker", ["ps"]),
      capture: report(`${table}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("container.table");
    expect(reduced.value.reducedText).toContain("ID\tIMAGE\tSTATUS\tNAME");
    expect(reduced.value.reducedText).toContain("abc123\tfalryn:dev\tUp 2 minutes\tfalryn-dev");
    expect(reduced.value.reducedText).toContain("def456\tpostgres:17\tUp 2 minutes\tfalryn-db");
    expect(reduced.value.omissions).toEqual([]);
  });

  test("compacts complete system command results without dropping decision facts", () => {
    const cases = [
      {
        executable: "df",
        argv: ["-h", "."],
        output: [
          "Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on",
          "/dev/disk3s5   460Gi   147Gi   290Gi    34%    1.7M  3.0G    0%   /System/Volumes/Data",
          "",
        ].join("\n"),
        markers: ["filesystem\tsize\tused", "/System/Volumes/Data"],
      },
      {
        executable: "du",
        argv: ["-sh", "."],
        output: "319M\t.\n",
        markers: ["319M\t."],
      },
      {
        executable: "ps",
        argv: ["-p", "49114", "-o", "pid,ppid,state,comm"],
        output: "  PID  PPID STAT COMM\n49114 41183 Ss   bun\n",
        markers: ["PID\tPPID\tSTAT\tCOMM", "49114\t41183\tSs\tbun"],
      },
      {
        executable: "stat",
        argv: ["-x", "package.json"],
        output: [
          '  File: "package.json"',
          "  Size: 2527         FileType: Regular File",
          "  Mode: (0644/-rw-r--r--)         Uid: (  501/yogeshprasad)  Gid: (   20/   staff)",
          "Device: 1,15   Inode: 32125206    Links: 1",
          "Access: Mon Aug 24 01:55:42 2026",
          "Modify: Sun Aug 23 05:26:48 2026",
          "Change: Sun Aug 23 05:26:48 2026",
          " Birth: Fri Aug 21 19:55:14 2026",
          "",
        ].join("\n"),
        markers: ["dev=1,15 inode=32125206 links=1", "birth=Fri Aug 21 19:55:14"],
      },
      {
        executable: "systemctl",
        argv: ["status", "falryn"],
        output: [
          "● falryn.service - Falryn agent",
          "     Loaded: loaded (/etc/systemd/system/falryn.service; enabled; preset: enabled)",
          "     Active: active (running) since Mon 2026-08-24 10:00:00 PDT; 2h 30min ago",
          "   Main PID: 736 (falryn)",
          "      Tasks: 8 (limit: 1024)",
          "     Memory: 42.0M",
          "        CPU: 1.234s",
          "     CGroup: /system.slice/falryn.service",
          "             └─736 /usr/local/bin/falryn",
          "",
        ].join("\n"),
        markers: ["Active: active (running)", "Main PID: 736", "└─736 /usr/local/bin/falryn"],
      },
    ] as const;

    for (const fixture of cases) {
      const reduced = reduceHush({
        command: argv(`/usr/bin/${fixture.executable}`, fixture.argv),
        capture: report(fixture.output),
      });
      expect(reduced.ok).toBe(true);
      if (!reduced.ok) {
        throw new Error(`expected a ${fixture.executable} Hush result`);
      }
      expect(reduced.value.reducerId).toBe("system.table");
      expect(reduced.value.omissions).toEqual([]);
      expect(reduced.value.truncated).toBe(false);
      expect(new TextEncoder().encode(reduced.value.reducedText).byteLength).toBeLessThanOrEqual(
        new TextEncoder().encode(fixture.output).byteLength,
      );
      for (const marker of fixture.markers) {
        expect(reduced.value.reducedText).toContain(marker);
      }
    }
  });

  test("keeps failed, ambiguous, and caller-pattern system output exact", () => {
    const ambiguous = "STARTED PID\nMon Aug 24 10:00:00 736\n";
    const ps = reduceHush({
      command: argv("/bin/ps", ["-o", "lstart,pid"]),
      capture: report(ambiguous),
    });
    expect(ps.ok).toBe(true);
    if (!ps.ok) {
      throw new Error("expected a ps Hush result");
    }
    expect(ps.value.reducedText).toBe(ambiguous);
    expect(ps.value.strategy).toBe("passthrough");

    const failure = "stat: missing: stat: No such file or directory\n";
    const stat = reduceHush({
      command: argv("/usr/bin/stat", ["missing"]),
      capture: report("", { stderr: failure, exitCode: 1 }),
    });
    expect(stat.ok).toBe(true);
    if (!stat.ok) {
      throw new Error("expected a stat Hush result");
    }
    expect(stat.value.reducedText).toBe(`stderr:\n${failure}`);
    expect(stat.value.omissions).toEqual([]);

    const df = "Filesystem Size Used Avail Use% Mounted on\n/dev/sda1 100G 40G 60G 40% /\n";
    const patterned = reduceHush({
      command: argv("/bin/df", ["-h", "."]),
      capture: report(df),
      importantPatterns: ["/dev/sda1"],
    });
    expect(patterned.ok).toBe(true);
    if (!patterned.ok) {
      throw new Error("expected a df Hush result");
    }
    expect(patterned.value.reducedText).toBe(df);
  });

  test("renders AWS caller identity in a compact model-readable form", () => {
    const identity = {
      Account: "123456789012",
      Arn: "arn:aws:iam::123456789012:user/falryn",
      UserId: "AIDAEXAMPLE",
    };
    const reduced = reduceHush({
      command: argv("/usr/bin/aws", ["sts", "get-caller-identity"]),
      capture: report(`${JSON.stringify(identity, null, 2)}\n`),
    });
    expect(reduced.ok).toBe(true);
    if (!reduced.ok) {
      throw new Error("expected a hush result");
    }
    expect(reduced.value.reducerId).toBe("cloud.aws");
    expect(reduced.value.reducedText).toBe("account=123456789012 user=falryn id=AIDAEXAMPLE");
    expect(reduced.value.omissions).toEqual([]);
  });
});
