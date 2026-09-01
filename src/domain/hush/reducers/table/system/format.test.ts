import { describe, expect, test } from "bun:test";

import { encodedBytes } from "../../shared/text.ts";
import { formatDfResult } from "./df.ts";
import { formatDuResult } from "./du.ts";
import { formatPsResult } from "./ps.ts";
import { formatStatResult } from "./stat.ts";
import { formatSystemctlResult } from "./systemctl.ts";

const DARWIN_DF = [
  "Filesystem      Size    Used   Avail Capacity iused ifree %iused  Mounted on",
  "/dev/disk3s5   460Gi   147Gi   290Gi    34%    1.7M  3.0G    0%   /System/Volumes/Data",
  "",
].join("\n");

const DARWIN_STAT = [
  '  File: "package.json"',
  "  Size: 2527         FileType: Regular File",
  "  Mode: (0644/-rw-r--r--)         Uid: (  501/yogeshprasad)  Gid: (   20/   staff)",
  "Device: 1,15   Inode: 32125206    Links: 1",
  "Access: Mon Aug 24 01:55:42 2026",
  "Modify: Sun Aug 23 05:26:48 2026",
  "Change: Sun Aug 23 05:26:48 2026",
  " Birth: Fri Aug 21 19:55:14 2026",
  "",
].join("\n");

const SYSTEMCTL_STATUS = [
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
].join("\n");

describe("system table formats", () => {
  test("normalizes complete Darwin and Linux df schemas without dropping rows", () => {
    expect(formatDfResult(DARWIN_DF)).toBe(
      [
        "filesystem\tsize\tused\tavail\tcapacity\tiused\tifree\tiused%\tmounted",
        "/dev/disk3s5\t460Gi\t147Gi\t290Gi\t34%\t1.7M\t3.0G\t0%\t/System/Volumes/Data",
        "",
      ].join("\n"),
    );
    expect(
      formatDfResult(
        [
          "Filesystem      Size  Used Avail Use% Mounted on",
          "/dev/sda1       100G   40G   60G  40% /",
          "tmpfs             8G     0    8G   0% /run",
          "",
        ].join("\n"),
      ),
    ).toBe(
      [
        "filesystem\tsize\tused\tavail\tuse%\tmounted",
        "/dev/sda1\t100G\t40G\t60G\t40%\t/",
        "tmpfs\t8G\t0\t8G\t0%\t/run",
        "",
      ].join("\n"),
    );
  });

  test("keeps already-minimal du output exact and normalizes only redundant spacing", () => {
    expect(formatDuResult("319M\t.\n")).toBe("319M\t.\n");
    expect(formatDuResult("319M    .\n12K    ./src\n")).toBe("319M\t.\n12K\t./src\n");
  });

  test("maps ps headers to the correct values while retaining command text", () => {
    expect(formatPsResult("  PID  PPID STAT COMM\n49114 41183 Ss   bun\n")).toBe(
      "PID\tPPID\tSTAT\tCOMM\n49114\t41183\tSs\tbun\n",
    );
    expect(
      formatPsResult(
        "USER       PID %CPU %MEM      VSZ    RSS   TT  STAT STARTED      TIME COMMAND\n" +
          "yogesh   49114  1.2  0.3 41000000  81920 s001  S+   10:30AM   0:01.23 bun run dev --watch\n",
      ),
    ).toContain("0:01.23\tbun run dev --watch");
  });

  test("compacts Darwin stat below RTK while retaining device and birth facts", () => {
    const formatted = formatStatResult(DARWIN_STAT);
    expect(formatted).toBe(
      [
        '"package.json" 2527B Regular File mode=0644/-rw-r--r-- uid=501/yogeshprasad gid=20/staff dev=1,15 inode=32125206 links=1',
        "times year=2026",
        "atime=Mon Aug 24 01:55:42",
        "mtime=Sun Aug 23 05:26:48",
        "ctime=Sun Aug 23 05:26:48",
        "birth=Fri Aug 21 19:55:14",
        "",
      ].join("\n"),
    );
    expect(formatted).toContain("dev=1,15 inode=32125206 links=1");
    expect(formatted).toContain("birth=Fri Aug 21 19:55:14");
    expect(encodedBytes(formatted ?? "")).toBeLessThanOrEqual(249);
  });

  test("compacts a complete GNU stat shape without dropping blocks or exact times", () => {
    const source = [
      "  File: package.json",
      "  Size: 2527      Blocks: 8          IO Block: 4096   regular file",
      "Device: 0,44     Inode: 32125206    Links: 1",
      "Access: (0644/-rw-r--r--)  Uid: ( 1000/ yogesh)   Gid: ( 1000/ yogesh)",
      "Access: 2026-08-24 01:55:42.000000000 -0700",
      "Modify: 2026-08-23 05:26:48.000000000 -0700",
      "Change: 2026-08-23 05:26:48.000000000 -0700",
      " Birth: 2026-08-21 19:55:14.000000000 -0700",
      "",
    ].join("\n");
    const formatted = formatStatResult(source);
    expect(formatted).toContain("2527B regular file blocks=8 io=4096");
    expect(formatted).toContain("dev=0,44 inode=32125206 links=1");
    expect(formatted).toContain("birth=2026-08-21 19:55:14.000000000 -0700");
  });

  test("removes only validated systemctl status indentation", () => {
    expect(formatSystemctlResult(SYSTEMCTL_STATUS)).toBe(
      [
        "● falryn.service - Falryn agent",
        "Loaded: loaded (/etc/systemd/system/falryn.service; enabled; preset: enabled)",
        "Active: active (running) since Mon 2026-08-24 10:00:00 PDT; 2h 30min ago",
        "Main PID: 736 (falryn)",
        "Tasks: 8 (limit: 1024)",
        "Memory: 42.0M",
        "CPU: 1.234s",
        "CGroup: /system.slice/falryn.service",
        "└─736 /usr/local/bin/falryn",
        "",
      ].join("\n"),
    );
  });

  test("retains every df, du, ps, and systemctl row without an item-count cap", () => {
    const dfRows = Array.from(
      { length: 80 },
      (_, index) => `/dev/disk${index + 1} 100G 40G 60G 40% /mnt/${index + 1}`,
    );
    const duRows = Array.from({ length: 80 }, (_, index) => `4K\t./item-${index + 1}`);
    const psRows = Array.from(
      { length: 80 },
      (_, index) => `${index + 1} 1 S process-${index + 1}`,
    );
    const cgroupRows = Array.from(
      { length: 80 },
      (_, index) => `             ├─${index + 1} /usr/bin/worker-${index + 1}`,
    );
    const df = formatDfResult(
      ["Filesystem Size Used Avail Use% Mounted on", ...dfRows, ""].join("\n"),
    );
    const du = formatDuResult([...duRows, ""].join("\n"));
    const ps = formatPsResult(["PID PPID STAT COMM", ...psRows, ""].join("\n"));
    const systemctl = formatSystemctlResult(
      [
        "● falryn.service - Falryn agent",
        " Loaded: loaded (/etc/systemd/system/falryn.service; enabled)",
        " Active: active (running)",
        " CGroup: /system.slice/falryn.service",
        ...cgroupRows,
        "",
      ].join("\n"),
    );

    expect(df).toContain("/dev/disk80\t100G\t40G\t60G\t40%\t/mnt/80");
    expect(du).toContain("4K\t./item-80");
    expect(ps).toContain("80\t1\tS\tprocess-80");
    expect(systemctl).toContain("├─80 /usr/bin/worker-80");
    expect(df?.split("\n")).toHaveLength(82);
    expect(du?.split("\n")).toHaveLength(81);
    expect(ps?.split("\n")).toHaveLength(82);
    expect(systemctl?.split("\n")).toHaveLength(85);
  });

  test("refuses ambiguous system shapes instead of inventing columns or hierarchy", () => {
    expect(
      formatDfResult(DARWIN_DF.replace("/System/Volumes/Data", "/Volumes/My Data")),
    ).toBeNull();
    expect(formatDuResult("4K\t./left\tright\n")).toBeNull();
    expect(formatPsResult("STARTED PID\nMon Aug 24 10:00:00 736\n")).toBeNull();
    expect(formatPsResult("PID PPID STAT COMM\n736 1 S\n")).toBeNull();
    expect(formatStatResult(DARWIN_STAT.replace("Device: 1,15", "device 1,15"))).toBeNull();
    expect(
      formatSystemctlResult(SYSTEMCTL_STATUS.replace("     Memory: 42.0M", "     continuation")),
    ).toBeNull();
  });
});
