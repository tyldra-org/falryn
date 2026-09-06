import type { ProjectionCase } from "../../hush-projection-case.ts";

export const LOG_CASES: readonly ProjectionCase[] = [
  {
    id: "log-journalctl",
    projection: "log",
    executable: "journalctl",
    argv: ["-u", "falryn", "-n", "20"],
    baseline: "rtk-log",
    requiredMarkers: [
      "Aug 24 10:00 falryn-host falryn[736]",
      "00 [I] session started session=demo",
      "01 [I] context engine ready reducers=82",
      "02 [I] waiting for provider ×3",
      "03 [W] reducer fallback command=unknown",
      "04 [E] capture unavailable id=cap-42",
      "05 [I] request complete tokens=219",
    ],
    forbiddenMarkers: ["Log Summary", "omitted", "…"],
  },
];
