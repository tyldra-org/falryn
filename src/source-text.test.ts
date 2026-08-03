/**
 * Every source file is text.
 *
 * This exists because it failed. `src/tui/text-cache.ts` used a NUL as a cache
 * key separator and wrote it as a literal byte rather than as `\0`. The runtime
 * behavior was correct and every test passed — but Git classifies any file
 * containing a NUL as binary, so a 149-line module showed up in `git diff` as
 * `Bin 0 -> 5216 bytes`, appeared in no review, and would have appeared in no
 * future one either. `git blame`, `git log -p`, and the merge driver all stop
 * working on it at the same moment.
 *
 * The failure is invisible in the editor, invisible in the test suite, and
 * invisible in the pull request — which is exactly the shape of thing that needs
 * a control rather than attention. A control character in source is either a
 * mistake or something that belongs in an escape sequence; there is no third
 * case, so the rule can be absolute.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

const SOURCE_ROOT = dirname(import.meta.path);

/**
 * Control characters no source file may contain as a raw byte.
 *
 * Tab, newline, and carriage return are excluded: the first two are ordinary
 * whitespace and the third is what a Windows checkout produces. Everything else
 * in C0, plus DEL, is either invisible or actively hostile — a NUL makes the
 * file binary, an escape byte makes the file able to move a reviewer's cursor,
 * and a vertical tab in a string literal is a bug nobody can see.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is this control's whole purpose, and the rule's own reasoning — that one in a pattern is usually a mistake — is exactly why this check exists.
const FORBIDDEN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Names the character so a failure says what to look for, not only where. */
function describeByte(code: number): string {
  return `U+${code.toString(16).toUpperCase().padStart(4, "0")}`;
}

async function sourceFiles(): Promise<readonly string[]> {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const files: string[] = [];
  for await (const entry of glob.scan({ cwd: SOURCE_ROOT })) {
    files.push(entry);
  }
  return files.sort();
}

describe("a source file", () => {
  test("contains no raw control character", async () => {
    // Reported with the file, the offset, and the character, because "something
    // in the tree is binary" is not a thing anyone can act on.
    const offenders: string[] = [];
    for (const file of await sourceFiles()) {
      const source = await readFile(join(SOURCE_ROOT, file), "utf8");
      if (!FORBIDDEN.test(source)) {
        continue;
      }
      const at = source.search(FORBIDDEN);
      offenders.push(`${file}:${at} ${describeByte(source.charCodeAt(at))}`);
    }
    expect(offenders).toEqual([]);
  });

  test("is readable as UTF-8 at all", async () => {
    // A file that is not valid UTF-8 fails the check above by decoding to
    // replacement characters rather than by containing a control byte, so the
    // bytes are checked directly.
    const undecodable: string[] = [];
    for (const file of await sourceFiles()) {
      const bytes = await readFile(join(SOURCE_ROOT, file));
      try {
        new TextDecoder("utf-8", { fatal: true }).decode(bytes);
      } catch {
        undecodable.push(file);
      }
    }
    expect(undecodable).toEqual([]);
  });

  test("catches a control character rather than passing by construction", async () => {
    // The control has to be able to fail. A NUL and an escape byte are the two
    // that actually happen: the first from a separator written as a byte, the
    // second from a colour code pasted out of a terminal.
    expect(FORBIDDEN.test("const key = `a\u0000b`;")).toBe(true);
    expect(FORBIDDEN.test("const red = '\u001b[31m';")).toBe(true);
    // And it must not fire on ordinary source, including the escapes that are
    // the correct way to write both of the above.
    expect(FORBIDDEN.test("const key = `a\\0b`;\n\tconst x = 1;\r\n")).toBe(false);
  });
});
