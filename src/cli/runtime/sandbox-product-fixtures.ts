/** A source/compiled consumer of the production headless composition, with only the provider and human decision supplied by the fixture. */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CONFIGURATION_FILE_NAME } from "../../config/index.ts";
import { createStaticEnvironment, streamId } from "../../domain/foundation/index.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { createDeterministicProviderAdapter } from "../../providers/index.ts";
import type { GlobalOptions } from "../options.ts";
import { createRecordingCliStreams } from "../output/streams.ts";
import { runCoding } from "./coding-run.ts";
import { openProductArtifactSession } from "./product-artifact-session.ts";
import { createServiceProvider } from "./services.ts";

const inputSchema = z.object({
  home: z.string(),
  executable: z.string(),
  mode: z.enum(["strict", "off", "degraded"]),
});
export async function sandboxProductJourney(input: z.infer<typeof inputSchema>) {
  const root = join(input.home, "workspace");
  const config = join(input.home, "config");
  await mkdir(root, { recursive: true });
  await mkdir(config, { recursive: true });
  const outside = join(input.home, "outside");
  await writeFile(outside, "outside-secret");
  await writeFile(
    join(config, CONFIGURATION_FILE_NAME),
    JSON.stringify({
      schemaVersion: 1,
      tools: { sandbox: { version: 1, mode: input.mode, readRoots: [], writeRoots: [] } },
    }),
  );
  const globals: GlobalOptions = {
    format: "json",
    color: "never",
    quiet: false,
    verbose: false,
    nonInteractive: true,
    workspace: root,
    addDirs: [],
    profile: null,
    timeoutMs: null,
    help: false,
    version: false,
  };
  const services = createServiceProvider(globals, {
    home: localPath(input.home),
    currentDirectory: localPath(root),
    environment: createStaticEnvironment({
      FALRYN_STATE_DIR: join(input.home, "state"),
      FALRYN_CONFIG_DIR: config,
    }),
  });
  const requests: string[] = [];
  const result = await runCoding(
    services,
    { promptParts: ["run the isolation fixture"] },
    {
      input: createRecordingCliStreams({ stdin: null }).input,
      globals,
      toolConfirmation: {
        resolve: async (request) => ({ kind: "confirmed", confirmationId: request.confirmationId }),
      },
      providerAdapter: createDeterministicProviderAdapter({
        onRequest: (request) => requests.push(JSON.stringify(request)),
        script: (_request, index) =>
          index === 0
            ? {
                kind: "tool",
                name: "run_process",
                toolCallId: "sandbox-product",
                argumentFragments: [
                  JSON.stringify({
                    executable: input.executable,
                    argv: [
                      "-e",
                      `try { require("node:fs").readFileSync(${JSON.stringify(outside)}); console.log("outside-allowed"); } catch { console.log("outside-denied"); }`,
                    ],
                    outputMode: "raw",
                  }),
                ],
              }
            : { kind: "text", text: "Fixture complete." },
      }),
      identities: {
        sessionId: "sandbox-product",
        turnId: "sandbox-turn",
        traceId: "sandbox-trace",
      },
    },
  );
  const session = await openProductArtifactSession(services());
  if (session === null) throw new Error("sandbox-fixture-store-unavailable");
  try {
    const events = await session.eventStore.readFrom(
      { streamId: streamId.from("live-turn:sandbox-product"), afterSequence: null },
      100,
    );
    if (!events.ok) throw new Error("sandbox-fixture-replay-failed");
    return {
      result,
      requests,
      receipts: events.value.flatMap((event) =>
        event.kind === "capability.invocation.completed" ? (event.payload.sandbox ?? []) : [],
      ),
    };
  } finally {
    await session.close();
  }
}
if (import.meta.main)
  console.log(
    JSON.stringify(
      await sandboxProductJourney(inputSchema.parse(JSON.parse(process.argv.at(-1) ?? "{}"))),
    ),
  );
