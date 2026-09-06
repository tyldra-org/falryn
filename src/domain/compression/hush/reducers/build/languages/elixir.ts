/** Elixir build output parsing. */

import { buildLines } from "../shared.ts";

export function formatElixirBuild(text: string): string | null {
  let files: string | undefined;
  let app: string | undefined;
  for (const line of buildLines(text)) {
    const compiling = /^Compiling (\d+) files? \(.+\)$/u.exec(line);
    if (compiling !== null) {
      files = compiling[1];
      continue;
    }
    const generated = /^Generated (\S+) app$/u.exec(line);
    if (generated !== null) {
      app = generated[1];
      continue;
    }
    return null;
  }
  return files === undefined || app === undefined ? null : `ok mix ${app} ${files} files`;
}
