import { formatDfResult } from "./df.ts";
import { formatDuResult } from "./du.ts";
import { formatPsResult } from "./ps.ts";
import { formatStatResult } from "./stat.ts";
import { formatSystemctlResult } from "./systemctl.ts";

export const SYSTEM_TABLE_EXECUTABLES = ["df", "du", "ps", "stat", "systemctl"] as const;

type SystemTableExecutable = (typeof SYSTEM_TABLE_EXECUTABLES)[number];

export function isSystemTableExecutable(executable: string): executable is SystemTableExecutable {
  return SYSTEM_TABLE_EXECUTABLES.some((candidate) => candidate === executable);
}

export function formatSystemTableResult(
  executable: SystemTableExecutable,
  source: string,
): string | null {
  switch (executable) {
    case "df":
      return formatDfResult(source);
    case "du":
      return formatDuResult(source);
    case "ps":
      return formatPsResult(source);
    case "stat":
      return formatStatResult(source);
    case "systemctl":
      return formatSystemctlResult(source);
  }
}
