import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { cp, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { fixtureSigner } from "../../application/extensions/evaluation-fixtures.ts";
import {
  openProductStoreOrThrow,
  removeTemporaryRoots,
  temporaryRoot,
} from "../../data/fixtures.ts";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { packageHealthResultSchema } from "../../domain/extensions/package-health.ts";
import { RECOVERY_CHOICES } from "../../domain/security/package-standing.ts";
import { localPath } from "../../domain/workspace/index.ts";
import { nativeHealthFixture } from "../../integrations/extensions/package-health-fixtures.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { nativeProductJourney, nativePromptJourney } from "../runtime/native-product-fixtures.ts";
import { journeyCertificate, trustJourney } from "./ecosystem-trust-journey-fixtures.ts";

afterEach(removeTemporaryRoots);
const suite = journeyCertificate === null ? describe.skip : describe;
const sandboxed = createHostSandbox().probe().status === "available";
const skill = new TextEncoder().encode(
  "---\nname: review\ndescription: Review changes.\n---\nReview.\n",
);
const declarative = (id: string, version = "1.0.0") => ({
  id,
  version,
  extension: { version: 1 },
  files: { "skills/review/SKILL.md": skill },
});

/** The tool text the scripted model received back after its one native tool call. */
function toolText(journey: Awaited<ReturnType<typeof nativeProductJourney>>) {
  const continuation = z
    .object({
      messages: z.array(
        z.object({ role: z.string(), parts: z.array(z.object({ text: z.string().optional() })) }),
      ),
    })
    .parse(JSON.parse(journey.requests[1] ?? "null"));
  return continuation.messages
    .filter((message) => message.role === "tool")
    .flatMap((message) => message.parts.map((part) => part.text ?? ""))
    .join("\n");
}

/** Wait until the store records a live governed child for this package, so a change lands mid-run. */
/** The tool result settlements a headless turn recorded durably. */
function settlements(journey: Awaited<ReturnType<typeof nativeProductJourney>>) {
  if (!journey.events?.ok) throw new Error("no events");
  return journey.events.value.flatMap((event) => {
    const payload = (event as { payload?: Record<string, unknown> }).payload;
    return payload?.type === "result" ? [payload] : [];
  });
}

async function running(root: string, packageId: string) {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    // Through the product's own store, so the test opens no second driver connection.
    const store = await openProductStoreOrThrow(localPath(join(root, "state")));
    try {
      const rows = store.read(
        "SELECT record_json FROM package_health_attempts WHERE package_id = $packageId AND pending = 1",
        { packageId },
      );
      if (
        rows.ok &&
        rows.value.some((row) => JSON.parse(String(row.record_json)).result?.pid != null)
      )
        return;
    } finally {
      await store.close();
    }
    await Bun.sleep(50);
  }
  throw new Error("no running attempt");
}

suite("ecosystem trust journey with native execution (#1279)", () => {
  test.skipIf(!sandboxed)(
    "a revocation that lands while a curated package runs stops it at its next boundary, and every surface and the exported session agree",
    async () => {
      const root = await temporaryRoot("falryn-trust-journey-native-");
      const j = await trustJourney(root);
      try {
        const native = async (id: string, mode: string) => {
          // One peer binary serves both protocols: a health contribution and a native tool.
          const directory = join(root, `peer-${id}`);
          await mkdir(join(directory, "tool"), { recursive: true });
          const check = await nativeHealthFixture(directory, mode, "");
          const tool = await nativeHealthFixture(join(directory, "tool"), mode, "", true);
          return {
            id,
            extension: {
              version: 1,
              contributions: [
                { ...check.declaration, id: `${id}-health` },
                { ...tool.declaration, id: `${id}-answer` },
              ],
            },
            files: { "health-peer": check.bytes },
            declareFiles: true,
          };
        };
        const curated = await j.serve(await native("curated", "slow"));
        const unverified = await j.serve(await native("unverified", "healthy"));
        await j.publish("example", [
          { listingId: "tools/curated", identity: curated },
          { listingId: "tools/unverified", identity: unverified },
        ]);
        const names = new Map<string, string>();
        const contributions = new Map<string, string>();
        const signer = fixtureSigner();
        for (const id of ["curated", "unverified"]) {
          const installed = await j.acquire("install", id, {
            sourceId: "example",
            listingId: `tools/${id}`,
            packageVersion: "1.0.0",
          });
          if (id === "curated")
            expect((await j.refresh(id, signer)).trust?.trust.state).toBe("curated");
          expect((await j.approve(id)).trust?.trust.eligible).toBe(true);
          const listed = (await j.inspect(id)).contributions;
          const healthDigest = listed.find((entry) => entry.id === `${id}-health`)?.identityDigest;
          const toolDigest = listed.find((entry) => entry.id === `${id}-answer`)?.identityDigest;
          if (healthDigest === undefined || toolDigest === undefined)
            throw new Error("no contribution");
          contributions.set(id, healthDigest);
          const scope = {
            action: "scope",
            packageId: id,
            scope: "user",
            request: {
              operationId: randomUUID(),
              expectedRevision: 0,
              packageIdentity: installed.currentDigest,
              choice: { enabled: true, preferred: false, explicitOnly: false },
            },
          };
          const scoped = await j.cli(["extension", "scope"], scope);
          const token = z
            .object({ receipt: z.object({ confirmation: z.string() }) })
            .parse(scoped.payload);
          expect(
            (
              await j.cli(["extension", "scope"], {
                ...scope,
                request: { ...scope.request, confirmation: token.receipt.confirmation },
              })
            ).payload,
          ).toMatchObject({ status: "applied" });
          const enabled = packageReceiptSchema.parse(
            await j.confirmed(
              ["package", "enable"],
              {
                packageId: id,
                operationId: randomUUID(),
                expectedRevision: 1,
                nativeActivation: {
                  scope: "user",
                  expectedRevision: 0,
                  contributions: [toolDigest],
                },
              },
              (preview) => packageReceiptSchema.safeParse(preview).data?.confirmation,
            ),
          );
          expect(enabled).toMatchObject({ status: "completed", activation: "enabled" });
        }
        for (const entry of await j.catalog()) {
          if (!entry.contribution.localId.endsWith("-answer")) continue;
          const id = entry.contribution.localId.replace("-answer", "");
          expect(entry.availability).toBe("available");
          names.set(id, entry.binding?.actionId.split("/").at(-1)?.split("@")[0] ?? "");
        }

        // 3. Both packages run: an explicit health check and one native tool call in a headless turn.
        const health = (id: string) => ({
          packageId: id,
          operationId: randomUUID(),
          expectedRevision: 1,
          health: { contribution: contributions.get(id) },
        });
        const confirmedHealth = (request: ReturnType<typeof health>) =>
          j.confirmed(
            ["package", "health"],
            request,
            (preview) => packageReceiptSchema.safeParse(preview).data?.confirmation,
          );
        for (const id of ["curated", "unverified"]) {
          const checked = packageReceiptSchema.parse(await confirmedHealth(health(id)));
          expect(packageHealthResultSchema.parse(checked.data)).toMatchObject({
            state: "healthy",
            terminated: true,
            cleanup: "removed",
          });
          const turn = await nativeProductJourney({
            home: root,
            environment: j.environment,
            name: names.get(id) ?? "",
          });
          expect(toolText(turn)).toContain('"answer":42');
        }

        // 4a. A hold that lands after the tool was disclosed denies the call with its reason.
        const hold = async (action: "quarantine" | "release") => {
          const receipt = packageReceiptSchema.parse(
            await j.confirmed(
              ["package", action],
              {
                packageId: "curated",
                operationId: randomUUID(),
                expectedRevision: 1,
                ...(action === "quarantine" ? { reason: "policy" } : {}),
              },
              (preview) => packageReceiptSchema.safeParse(preview).data?.confirmation,
            ),
          );
          expect(receipt.status).toBe("completed");
        };
        const denied = await nativeProductJourney(
          { home: root, environment: j.environment, name: names.get("curated") ?? "" },
          { beforeFirstRequest: () => hold("quarantine") },
        );
        expect(denied.requests[0]).toContain(names.get("curated") ?? "@@");
        // The durable settlement records the refusal; whether the model continues depends on
        // fallback order, which is not part of this journey.
        expect(settlements(denied)).toContainEqual(
          expect.objectContaining({
            status: "unavailable",
            effect: "none",
            reason: "ecosystem-trust-quarantined",
          }),
        );
        await hold("release");
        // Release grants nothing: the package needs its own fresh approval again.
        expect(await j.standing("curated")).toMatchObject({ state: "unapproved" });
        expect((await j.approve("curated")).trust?.trust.eligible).toBe(true);

        // 4b. A signed revocation lands while a curated attempt is running.
        const request = health("curated");
        const preview = packageReceiptSchema.parse(
          (await j.cli(["package", "health"], request)).payload,
        );
        const attempt = j.cli(["package", "health"], {
          ...request,
          confirmation: preview.confirmation,
        });
        await running(root, "curated");
        await j.refresh("curated", signer, {
          advisory: { sequence: 2, status: "revoked" },
          curation: false,
        });
        const stopped = packageReceiptSchema.parse((await attempt).payload);
        expect(packageHealthResultSchema.parse(stopped.data)).toMatchObject({
          state: "failed",
          code: "stale-health-authority",
          terminated: true,
          cleanup: "removed",
        });
        // No new attempt is admitted, and every surface states the same reason.
        const refused = await j.cli(["package", "health"], health("curated"));
        expect(refused.code).not.toBe(0);
        expect(refused.errors).toContain("ecosystem-trust-revoked");
        const catalog = await j.catalog();
        expect(
          catalog.find((entry) => entry.contribution.localId === "curated-answer"),
        ).toMatchObject({ enabled: false, reason: "ecosystem-trust-revoked" });
        expect(
          catalog.find((entry) => entry.contribution.localId === "unverified-answer")?.availability,
        ).toBe("available");
        expect(await j.standing("curated")).toMatchObject({
          state: "revoked",
          reason: "ecosystem-trust-revoked",
        });
        // The next turn never offers the revoked tool; the unverified package's tool still runs.
        const withheld = await nativeProductJourney({
          home: root,
          environment: j.environment,
          name: names.get("unverified") ?? "",
        });
        expect(withheld.requests[0]).toContain(names.get("unverified") ?? "@@");
        expect(withheld.requests[0]).not.toContain(names.get("curated") ?? "@@");
        expect(toolText(withheld)).toContain('"answer":42');

        // 7. The session that was denied exports, imports elsewhere and replays without effects.
        const sessionId = denied.result.payload?.sessionId;
        if (sessionId === undefined) throw new Error("no session");
        const exported = await j.cli([
          "export",
          "--session",
          sessionId,
          "--write",
          "--name",
          "trust-journey",
        ]);
        expect(exported.code).toBe(0);
        const elsewhere = await temporaryRoot("falryn-trust-journey-import-");
        const other = await trustJourney(elsewhere);
        try {
          // A second machine that has used Falryn before: it already has a product database.
          await nativePromptJourney({
            home: elsewhere,
            environment: other.environment,
            prompt: "Hello.",
          });
          await cp(join(root, "exports"), join(elsewhere, "exports"), { recursive: true });
          const imported = await other.cli(["import", "trust-journey"]);
          expect(imported.code).toBe(0);
          const replayed = await other.cli(["replay", sessionId]);
          expect(replayed.code).toBe(0);
          expect(replayed.payload).toMatchObject({ effectFree: true });
          // The refusal and its reason travel with the session's tool result.
          expect(JSON.stringify(replayed.payload)).toContain("ecosystem-trust-quarantined");
          const notInstalled = await other.cli(["extension", "notices", "--installed", "curated"]);
          expect(notInstalled.payload).toMatchObject({ status: "failed", code: "not-installed" });
        } finally {
          other.stop();
        }
      } finally {
        j.stop();
      }
    },
    // Two governed children, four headless turns and dozens of CLI dispatches; hosted macOS is slower.
    180_000,
  );
});

suite("ecosystem trust journey (#1279)", () => {
  test("a curated and an unverified listed package keep separate, agreeing trust from discovery to offline recovery", async () => {
    const j = await trustJourney(await temporaryRoot("falryn-trust-journey-"));
    try {
      // 1. Discover: one source lists both packages; claims stay unverified catalog claims.
      const curated = await j.serve(declarative("curated"));
      const unverified = await j.serve(declarative("unverified"));
      await j.publish("example", [
        { listingId: "tools/curated", identity: curated },
        { listingId: "tools/unverified", identity: unverified },
      ]);
      const listed = await j.cli(["extension", "listing"], {
        operation: "list",
        query: { text: "review" },
      });
      expect(JSON.stringify(listed.payload)).toContain("tools/curated");
      expect(JSON.stringify(listed.payload)).toContain("tools/unverified");
      const shown = await j.cli(["extension", "listing"], {
        operation: "inspect",
        query: { sourceId: "example", listingId: "tools/curated" },
      });
      expect(JSON.stringify(shown.payload)).toContain("catalog-claim");

      // 2. Install both through their listings, then inspect trust by installed ID.
      const listing = (name: string) => ({
        sourceId: "example",
        listingId: `tools/${name}`,
        packageVersion: "1.0.0",
      });
      const installedCurated = await j.acquire("install", "curated", listing("curated"));
      const installedUnverified = await j.acquire("install", "unverified", listing("unverified"));
      expect(installedCurated.currentDigest).toBe(canonicalDigest(curated));
      expect(installedUnverified.currentDigest).toBe(canonicalDigest(unverified));
      const signer = fixtureSigner();
      const refreshed = await j.refresh("curated", signer);
      expect(refreshed.trust).toMatchObject({
        status: "applied",
        trust: { state: "curated", eligible: false, evidence: { curation: "verified" } },
        provenance: { curationStatus: "verified" },
      });
      expect((await j.inspect("unverified")).trust?.trust).toMatchObject({ eligible: false });
      expect((await j.inspect("unverified")).trust?.trust.state).not.toBe("curated");
      expect((await j.standing("curated")).state).toBe("unapproved");
      expect((await j.standing("unverified")).state).toBe("unapproved");

      // 3. Approval is the user's own decision for each package; curation grants nothing.
      expect((await j.approve("curated")).trust?.trust).toMatchObject({
        state: "user-approved",
        eligible: true,
      });
      expect((await j.approve("unverified")).trust?.trust).toMatchObject({ eligible: true });
      expect((await j.standing("curated")).state).toBe("eligible");

      // 4. A signed advisory revokes the curated package; every projection names one reason.
      await j.refresh("curated", signer, { advisory: { sequence: 2, status: "revoked" } });
      const revoked = await j.standing("curated");
      expect(revoked).toMatchObject({ state: "revoked", reason: "ecosystem-trust-revoked" });
      const notices = await j.cli(["extension", "notices", "--installed", "curated"]);
      expect(JSON.stringify(notices.payload)).toContain("ecosystem-trust-revoked");
      const human = await j.cli(
        ["package", "standing"],
        { packageId: "curated", operationId: randomUUID(), expectedRevision: 1 },
        "human",
      );
      expect(human.text).toContain("standing: revoked (ecosystem-trust-revoked)");
      expect((await j.standing("unverified")).state).toBe("eligible");

      // 8. Evaluation preserves the blocked standing as a security failure.
      const evaluated = packageReceiptSchema.parse(
        (
          await j.cli(["package", "evaluate"], {
            packageId: "curated",
            operationId: randomUUID(),
            expectedRevision: 1,
          })
        ).payload,
      );
      expect(JSON.stringify(evaluated.data)).toContain("standing-blocked");

      // 6. Another source lists a package with the same name from another coordinate.
      const mirror = await j.serve(declarative("curated"), "curated-mirror");
      expect(canonicalDigest(mirror)).not.toBe(canonicalDigest(curated));
      await j.publish("other", [{ listingId: "tools/curated", identity: mirror }]);
      const both = JSON.stringify(
        (await j.cli(["extension", "listing"], { operation: "list", query: { text: "curated" } }))
          .payload,
      );
      expect(both).toContain('"other"');
      expect(both).toContain('"example"');
      // Publishing it changes nothing installed: the revoked package is still the revoked bytes.
      expect(await j.standing("curated")).toMatchObject({
        state: "revoked",
        identityDigest: canonicalDigest(curated),
      });
      // Only an explicit update names it, and it arrives as a new identity with no trust.
      const replaced = await j.acquire("update", "curated", {
        sourceId: "other",
        listingId: "tools/curated",
        packageVersion: "1.0.0",
      });
      expect(replaced.currentDigest).toBe(canonicalDigest(mirror));

      // 5. Offline restart: no registry, every read from installed records only.
      j.stop();
      const requests = j.requests.length;
      const offline = await j.standing("curated");
      expect(offline).toMatchObject({
        state: "unapproved",
        reason: "ecosystem-trust-required",
        identityDigest: canonicalDigest(mirror),
      });
      expect(offline.versions).toContainEqual(
        expect.objectContaining({ identityDigest: canonicalDigest(curated), state: "revoked" }),
      );
      for (const option of offline.recovery)
        expect(RECOVERY_CHOICES as readonly string[]).toContain(option.choice);
      expect((await j.standing("unverified")).state).toBe("eligible");
      expect(j.requests).toHaveLength(requests);
    } finally {
      j.stop();
    }
  }, 90_000); // Many CLI dispatches, each reloading state; hosted runners are several times slower.
});
