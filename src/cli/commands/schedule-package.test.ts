import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { contributionDeclarationSchema } from "../../domain/extensions/manifest.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
for (const change of ["disable", "revoke", "uninstall", "update"] as const)
  test.skipIf(createHostSandbox().probe().status !== "available")(
    `qualified package schedule binds inertly, runs explicitly and stops admission after ${change}`,
    async () => {
      const root = await temporaryRoot("schedule-package-");
      const command = [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname];
      const fixture = await prepareNativeCliFixture(command, root, {
        files: {},
        declarations: [
          contributionDeclarationSchema.parse({
            kind: "schedule",
            namespace: "fixture",
            id: "heartbeat",
            description: "Inert workspace inspection",
            authority: {
              effects: ["observation"],
              permissions: [],
              roots: [],
              destinations: [],
              secretReferences: [],
              localData: [],
            },
            schedule: {
              version: 1,
              timing: { trigger: { kind: "interval", everyMs: 1000 } },
              target: {
                kind: "action",
                capability: "builtin:workspace/stat_path@1",
                input: { path: "." },
              },
            },
          }),
        ],
      });
      const response = z.object({ ok: z.literal(true), value: z.record(z.string(), z.unknown()) });
      const listed = await fixture.invoke(
        ["schedule", "list"],
        { operation: "list" },
        z.object({
          ok: z.literal(true),
          value: z.object({
            entries: z.array(z.object({ id: z.string(), revision: z.number(), state: z.string() })),
          }),
        }),
      );
      expect(listed.value.entries).toHaveLength(1);
      const schedule = listed.value.entries[0];
      if (!schedule) throw new Error("schedule missing");
      expect(schedule.state).toBe("disabled");
      const historySchema = z.object({
        ok: z.literal(true),
        value: z.object({
          attempts: z.array(z.object({ terminal: z.object({ status: z.string() }).nullable() })),
        }),
      });
      expect(
        (
          await fixture.invoke(
            ["schedule", "history"],
            { operation: "history", id: schedule.id },
            historySchema,
          )
        ).value.attempts,
      ).toEqual([]);
      let enableRevision = schedule.revision;
      if (change === "disable") {
        const edited = await fixture.invoke(
          ["schedule", "update"],
          {
            operation: "update",
            id: schedule.id,
            expectedRevision: schedule.revision,
            definition: {
              version: 1,
              timing: { trigger: { kind: "interval", everyMs: 1100 } },
              target: {
                kind: "action",
                capability: "builtin:workspace/stat_path@1",
                input: { path: "." },
              },
            },
          },
          response,
        );
        expect(edited.value).toMatchObject({ state: "disabled", generation: 2 });
        enableRevision = Number(edited.value.revision);
      }
      await fixture.invoke(
        ["schedule", "enable"],
        { operation: "enable", id: schedule.id, expectedRevision: enableRevision },
        response,
      );
      const host = () =>
        Bun.spawn([...command, "schedule", "host", "--timeout", "1800", "--format", "json"], {
          cwd: root,
          env: fixture.environment,
          stdout: "pipe",
          stderr: "pipe",
        });
      await host().exited;
      const ran = await fixture.invoke(
        ["schedule", "history"],
        { operation: "history", id: schedule.id },
        historySchema,
        "jsonl",
      );
      expect(ran.value.attempts.length).toBeGreaterThan(0);
      expect(ran.value.attempts.every((attempt) => attempt.terminal?.status === "succeeded")).toBe(
        true,
      );
      if (change === "revoke") {
        const revoke = { action: "revoke", expiresAt: null };
        const schema = z.object({
          trust: z.object({ confirmation: z.string().nullable(), status: z.string() }),
        });
        const preview = await fixture.invoke(
          ["extension", "trust", fixture.source],
          revoke,
          schema,
        );
        expect(
          (
            await fixture.invoke(
              ["extension", "trust", fixture.source],
              { ...revoke, confirmation: preview.trust.confirmation },
              schema,
            )
          ).trust.status,
        ).toBe("applied");
      } else {
        if (change === "update") {
          const path = join(fixture.source, "plugin.json");
          const manifest = JSON.parse(await readFile(path, "utf8"));
          manifest.description = "A replacement package generation";
          await writeFile(path, JSON.stringify(manifest));
        }
        const request = {
          packageId: "fixture",
          operationId: randomUUID(),
          expectedRevision: 1,
          ...(change === "update" ? { sourcePath: fixture.source } : {}),
        };
        const preview = await fixture.invoke(["package", change], request, packageReceiptSchema);
        expect(
          (
            await fixture.invoke(
              ["package", change],
              { ...request, confirmation: preview.confirmation },
              packageReceiptSchema,
            )
          ).status,
        ).toBe("completed");
      }
      await host().exited;
      const after = await fixture.invoke(
        ["schedule", "history"],
        { operation: "history", id: schedule.id },
        historySchema,
      );
      expect(after.value.attempts.length).toBe(ran.value.attempts.length);
      expect(
        (
          await fixture.invoke(
            ["schedule", "inspect"],
            { operation: "inspect", id: schedule.id },
            response,
          )
        ).value,
      ).toMatchObject({ availability: "unavailable" });
    },
    60000,
  );
