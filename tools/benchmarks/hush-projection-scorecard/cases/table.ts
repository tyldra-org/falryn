import type { ProjectionCase } from "../../hush-projection-case.ts";

export const TABLE_CASES: readonly ProjectionCase[] = [
  {
    id: "system-df",
    projection: "table",
    executable: "df",
    argv: ["-h", "."],
    rtkArgv: ["df", "-h", "."],
    requiredMarkers: [
      "filesystem\tsize\tused\tavail\tcapacity\tiused\tifree\tiused%\tmounted",
      "/dev/disk3s5\t460Gi\t147Gi\t290Gi\t34%\t1.7M\t3.0G\t0%\t/System/Volumes/Data",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-du",
    projection: "table",
    executable: "du",
    argv: ["-sh", "."],
    rtkArgv: ["du", "-sh", "."],
    requiredMarkers: ["319M\t."],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-ps",
    projection: "table",
    executable: "ps",
    argv: ["-p", "49114", "-o", "pid,ppid,state,comm"],
    rtkArgv: ["ps", "-p", "49114", "-o", "pid,ppid,state,comm"],
    requiredMarkers: ["PID\tPPID\tSTAT\tCOMM", "49114\t41183\tSs\tbun"],
    forbiddenMarkers: ["PPID STAT", "omitted", "…"],
  },
  {
    id: "system-stat",
    projection: "table",
    executable: "stat",
    argv: ["-x", "package.json"],
    rtkArgv: ["stat", "-x", "package.json"],
    requiredMarkers: [
      '"package.json" 2527B Regular File',
      "dev=1,15 inode=32125206 links=1",
      "birth=Fri Aug 21 19:55:14",
    ],
    forbiddenMarkers: ["omitted", "…"],
  },
  {
    id: "system-systemctl",
    projection: "table",
    executable: "systemctl",
    argv: ["status", "falryn"],
    rtkArgv: ["systemctl", "status", "falryn"],
    requiredMarkers: [
      "● falryn.service - Falryn agent",
      "Active: active (running)",
      "Main PID: 736 (falryn)",
      "└─736 /usr/local/bin/falryn",
    ],
    forbiddenMarkers: ["     Loaded", "omitted", "…"],
  },
];
