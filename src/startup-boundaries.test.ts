/**
 * The startup closure stays light.
 *
 * Every Falryn invocation evaluates the modules `src/main.ts` reaches through
 * static imports before it parses an argument, and a standalone executable
 * parses all of that source each time. The provider SDKs, the MCP client and
 * the terminal UI are large and most invocations never use them, so they load
 * through dynamic imports and the release build splits them into chunks.
 * A static import of any of them would silently add tens of milliseconds to
 * every command, so this test fails on one.
 */

import { expect, test } from "bun:test";
import { join } from "node:path";

const ENTRY = join(import.meta.dir, "main.ts");

/** Packages that must stay behind a dynamic import. */
const DEFERRED = [
  "node_modules/openai/",
  "node_modules/@anthropic-ai/sdk/",
  "node_modules/@google/genai/",
  "node_modules/@modelcontextprotocol/client/",
  "node_modules/@opentui/",
  "node_modules/react/",
];

test("the startup closure reaches no provider SDK, MCP client or terminal UI package", async () => {
  const built = await Bun.build({
    entrypoints: [ENTRY],
    target: "bun",
    // Bun resolves OpenTUI's platform packages at bundle time; an external keeps the
    // dynamic import in place without needing every platform's optional package.
    external: ["@opentui/*"],
    metafile: true,
    write: false,
  } as Bun.BuildConfig & { metafile: true });
  expect(built.success).toBe(true);
  const inputs = (built as unknown as { metafile: Metafile }).metafile.inputs;
  const start = Object.keys(inputs).find((path) => path.endsWith("src/main.ts"));
  expect(start).toBeDefined();

  const reached = new Set<string>([start as string]);
  const pending = [start as string];
  while (pending.length > 0) {
    const current = pending.pop() as string;
    for (const edge of inputs[current]?.imports ?? []) {
      if (
        edge.kind === "dynamic-import" ||
        reached.has(edge.path) ||
        inputs[edge.path] === undefined
      )
        continue;
      reached.add(edge.path);
      pending.push(edge.path);
    }
  }
  const offenders = [...reached].filter((path) =>
    DEFERRED.some((deferred) => path.includes(deferred)),
  );
  expect(offenders.slice(0, 5)).toEqual([]);
}, 60_000);

type Metafile = {
  readonly inputs: Record<
    string,
    { readonly imports: readonly { readonly path: string; readonly kind: string }[] }
  >;
};
