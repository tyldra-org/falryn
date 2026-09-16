import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { hookHealthSnapshotSchema } from "../../domain/tools/hook-health.ts";
import { qualifiedHookPython } from "../../integrations/extensions/host-hook-command.ts";
import { reduceTranscript } from "../../presentation/transcript/reducer.ts";
import { nativeProductJourney } from "../runtime/native-product-fixtures.ts";
import { pythonHookFixture } from "./package-hook-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
const canary = "sk-hook-product-canary-private-abcdef012345";
const catalogSchema = z.object({
  page: z.object({
    entries: z.array(
      z.object({
        hookHealth: hookHealthSnapshotSchema.optional(),
      }),
    ),
  }),
});

test.skipIf(!qualifiedHookPython()).each(["pre", "post"])(
  "%s hook quarantine survives product reopen; inspection and replay do not reset it",
  async (point) => {
    const root = await temporaryRoot("falryn-hook-health-");
    const extra = pythonHookFixture();
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      {
        declarations: extra.declarations.filter(
          (d) => d.id === (point === "pre" ? "first" : "post"),
        ),
        files: {
          "hook.py": `import sys\nsys.stderr.write(${JSON.stringify(canary)})\nprint(${JSON.stringify(canary)})`,
        },
      },
    );
    const inspect = async () =>
      (
        await fixture.invoke(["extension", "catalog"], { action: "catalog" }, catalogSchema)
      ).page.entries.flatMap((e) => (e.hookHealth ? [e.hookHealth] : []));
    let capturedGeneration = "";
    for (let attempt = 1; attempt <= 4; attempt++) {
      const journey = await nativeProductJourney({
        home: root,
        environment: fixture.environment,
        name: fixture.name,
      });
      expect(journey.result.payload?.stage).toBe(
        point === "pre" ? "attempt-failed" : "attempt-completed",
      );
      if (point === "post") expect(journey.requests[1]).toContain('\\"answer\\":42');
      if (!journey.events?.ok) throw new Error("missing history");
      const failures = journey.events.value.flatMap((e) =>
        e.kind === "history.recorded" &&
        e.payload.type === "gate" &&
        e.payload.decision.startsWith("failed:")
          ? [e.payload]
          : [],
      );
      expect(failures).toHaveLength(1);
      const evidence = failures[0]?.hook?.failureEvidence;
      expect(evidence?.health.failures).toBe(Math.min(attempt, 3));
      if (attempt === 1) capturedGeneration = evidence?.health.generation ?? "";
      expect(evidence?.health.generation).toBe(capturedGeneration);
      expect(evidence?.sourceIdentity).not.toBeNull();
      expect(failures[0]?.decision).toBe(
        attempt === 4 ? "failed:hook-quarantined" : "failed:invalid-hook-response",
      );
      if (attempt === 4) expect(evidence?.handlerFacts).toBeNull();
      else
        expect(evidence?.handlerFacts).toMatchObject({
          kind: "process",
          transport: "settled",
          exitCode: 0,
          response: "invalid",
          stderrBytes: Buffer.byteLength(canary),
        });
      const before = await inspect();
      const projection = reduceTranscript(journey.events.value);
      expect(
        projection.blocks.some((b) => b.kind === "notice" && b.summary.text.includes("failed:")),
      ).toBe(true);
      expect(reduceTranscript(journey.events.value)).toEqual(projection);
      expect(await inspect()).toEqual(before);
      if (attempt === 1) {
        const command = [
          process.execPath,
          "run",
          new URL("../../main.ts", import.meta.url).pathname,
        ];
        const exported = Bun.spawnSync(
          [
            ...command,
            "export",
            "--session",
            String(journey.result.payload?.sessionId),
            "--write",
            "--name",
            "hook-proof",
            "--format",
            "jsonl",
          ],
          { cwd: root, env: fixture.environment, stdout: "pipe", stderr: "pipe" },
        );
        expect(exported.exitCode).toBe(0);
        const lines = exported.stdout.toString().trim().split("\n");
        const terminal = z
          .object({ payload: z.object({ bundle: z.object({ path: z.string() }) }) })
          .parse(JSON.parse(lines.at(-1) ?? "null"));
        const bytes = await readFile(terminal.payload.bundle.path, "utf8");
        expect(bytes).toContain("failureEvidence");
        expect(bytes).toContain("invalid-hook-response");
        expect(bytes).not.toContain(canary);
        expect(exported.stdout.toString()).not.toContain(canary);
        const human = Bun.spawnSync(
          [
            ...command,
            "extension",
            "catalog",
            "--input",
            join(root, "request.json"),
            "--format",
            "human",
            "--no-color",
          ],
          { cwd: root, env: fixture.environment, stdout: "pipe", stderr: "pipe" },
        );
        expect(human.exitCode).toBe(0);
        expect(human.stdout.toString()).toContain("degraded");
        expect(human.stdout.toString()).not.toContain(canary);
        expect(await inspect()).toEqual(before);
      }
      expect(
        JSON.stringify({
          result: journey.result,
          requests: journey.requests,
          events: journey.events,
          projection,
          before,
        }),
      ).not.toContain(canary);
    }
    expect((await inspect())[0]).toMatchObject({ status: "quarantined", failures: 3 });
    const intent = {
      operationId: randomUUID(),
      packageId: "fixture",
      expectedRevision: 1,
      nativeActivation: {
        scope: "user",
        expectedRevision: 1,
        contributions: [fixture.contribution, ...fixture.extraContributions],
      },
    };
    const preview = await fixture.invoke(["package", "enable"], intent, packageReceiptSchema);
    expect(preview.status).toBe("preview");
    expect((await inspect())[0]?.status).toBe("quarantined");
    const confirmed = { ...intent, confirmation: preview.confirmation };
    expect(
      (await fixture.invoke(["package", "enable"], confirmed, packageReceiptSchema)).status,
    ).toBe("completed");
    const reset = (await inspect())[0];
    expect(reset).toMatchObject({ status: "healthy", failures: 0 });
    expect(reset?.generation).not.toBe(capturedGeneration);
    await nativeProductJourney({
      home: root,
      environment: fixture.environment,
      name: fixture.name,
    });
    expect((await inspect())[0]?.failures).toBe(1);
    const replay = await fixture.invoke(
      ["package", "enable"],
      confirmed,
      packageReceiptSchema,
      "jsonl",
    );
    expect(replay.dataEffect).toBe("none");
    expect((await inspect())[0]?.failures).toBe(1);
  },
  60000,
);
