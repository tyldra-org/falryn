import { afterEach, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  type WorkspaceDecision,
  workspaceDecisionKey,
} from "../../domain/security/workspace-trust.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createWorkspaceTrustRepository } from "./workspace-trust-repository.ts";

afterEach(removeTemporaryRoots);
test("workspace decisions commit atomically, survive restart and reject stale or malformed writers", async () => {
  const root = await temporaryRoot("falryn-workspace-trust-");
  const hash = canonicalDigest("test");
  const decision: WorkspaceDecision = {
    version: 1,
    actor: hash,
    revision: 1,
    decidedAt: 100,
    inventory: {
      version: 1,
      identity: hash,
      generation: hash,
      configuration: hash,
      policy: 1,
      loaders: Array.from({ length: 1024 }, (_, index) => ({
        source: canonicalDigest(index),
        label: "s".repeat(256),
        digest: hash,
        sourceVersion: hash,
        bytes: 1,
        family: "skills",
        activation: "unavailable",
      })),
    },
  };
  const key = workspaceDecisionKey(hash, hash);
  const initial = await openProductStoreOrThrow(root);
  const repository = createWorkspaceTrustRepository(initial);
  expect(await repository.replace(key, 0, decision, AbortSignal.abort())).toMatchObject({
    error: { code: "cancelled" },
  });
  expect(await repository.get(key)).toEqual({ ok: true, value: null });
  expect((await repository.replace(key, 0, decision)).ok).toBe(true);
  expect(await repository.replace(key, 0, decision)).toMatchObject({ error: { code: "conflict" } });
  await initial.close();
  const reopened = await openProductStoreOrThrow(root);
  const durable = createWorkspaceTrustRepository(reopened);
  expect(await durable.get(key)).toEqual({ ok: true, value: decision });
  reopened.write((sql) => sql.run("UPDATE workspace_trust_decisions SET decision_json = '{}'"));
  expect(await durable.get(key)).toMatchObject({ error: { code: "malformed" } });
  expect(await durable.replace(key, 1, { ...decision, revision: 2 })).toMatchObject({
    error: { code: "malformed" },
  });
  await reopened.close();
});
