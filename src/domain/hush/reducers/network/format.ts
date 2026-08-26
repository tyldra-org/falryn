/** Command-aware network formatting with exact fallback for unknown shapes. */

import { compactDuplicateRuns, compactJsonWhitespace, shortestText } from "../../text-format.ts";
import { formatPingOutput } from "./ping.ts";
import { formatRsyncOutput } from "./rsync.ts";

export function formatNetworkOutput(text: string, commandTokens: readonly string[]): string | null {
  const executable = commandTokens[0]?.split(/[\\/]/u).at(-1);
  switch (executable) {
    case "ping":
      return formatPingOutput(text);
    case "rsync":
      return formatRsyncOutput(text);
    case "ssh": {
      const json = compactJsonWhitespace(text);
      return shortestText(text, compactDuplicateRuns(text), ...(json === null ? [] : [json]));
    }
    default:
      return null;
  }
}
