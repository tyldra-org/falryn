import { expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { externalHookFixture, hookFixtureEnvelope } from "../../domain/extensions/hook-fixtures.ts";
import { hookRegistrationSchema } from "../../domain/extensions/hook-handlers.ts";
import { decodeHookResponse, encodeHookInput } from "../../domain/extensions/hook-protocol.ts";

const golden = {
  version: 1 as const,
  invocationId: "golden:1",
  contribution: { packageId: "package:1", contributionId: "hook:1", generation: 7 },
  envelope: hookFixtureEnvelope(),
};
const expected =
  '{"version":1,"invocationId":"golden:1","decision":{"kind":"observe","annotations":{"fixture":"reviewed"}}}';
const python = Bun.which("python3") ?? Bun.which("python");
test.each([
  ["Bun", process.execPath, fileURLToPath(new URL("./hook-command-fixtures.ts", import.meta.url))],
  ["Python", python, fileURLToPath(new URL("./hook-command-fixture.py", import.meta.url))],
])(
  "%s exchanges the same v1 golden document over stdin/stdout EOF",
  async (_name, executable, entrypoint) => {
    if (executable === null)
      throw new Error("python3 is required for the language-neutral golden fixture");
    const process = Bun.spawn([executable, entrypoint], {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
      env: {},
      timeout: 5000,
    });
    process.stdin.write(encodeHookInput(golden));
    process.stdin.end();
    const [stdout, stderr, status] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    expect(status).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toBe(expected);
    expect(
      decodeHookResponse(
        new TextEncoder().encode(stdout),
        golden,
        hookRegistrationSchema.parse(externalHookFixture),
      ),
    ).toEqual({ kind: "observe", annotations: { fixture: "reviewed" } });
  },
);
