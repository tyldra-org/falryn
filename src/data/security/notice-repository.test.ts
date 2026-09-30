import { afterEach, expect, test } from "bun:test";
import { canonicalDigest } from "../../domain/extensions/canonical.ts";
import {
  NOTICE_LIMITS,
  type NoticeAcknowledgement,
  noticeAcknowledgementKey,
} from "../../domain/security/ecosystem-notice.ts";
import { openProductStoreOrThrow, removeTemporaryRoots, temporaryRoot } from "../fixtures.ts";
import { createNoticeAcknowledgementRepository } from "./notice-repository.ts";

afterEach(removeTemporaryRoots);

const scope = { kind: "user" as const, authority: canonicalDigest("actor") };
function record(name: string, overrides: Partial<NoticeAcknowledgement> = {}) {
  return {
    version: 1 as const,
    noticeId: canonicalDigest(name),
    scope,
    revision: 1,
    acknowledgedAt: 1_000,
    expiresAt: 2_000,
    ...overrides,
  };
}
const keyOf = (value: NoticeAcknowledgement) =>
  noticeAcknowledgementKey(value.noticeId, value.scope);

test("acknowledgements survive restart and a stale writer cannot overwrite a newer revision", async () => {
  const root = await temporaryRoot("falryn-notice-ack-");
  const first = record("first");
  const opened = await openProductStoreOrThrow(root);
  expect(createNoticeAcknowledgementRepository(opened).replace(keyOf(first), 0, first).ok).toBe(
    true,
  );
  await opened.close();

  const reopened = await openProductStoreOrThrow(root);
  try {
    const store = createNoticeAcknowledgementRepository(reopened);
    expect(store.get(keyOf(first))).toEqual({ ok: true, value: first });
    expect(store.get(keyOf(record("absent")))).toEqual({ ok: true, value: null });
    const next = { ...first, revision: 2, expiresAt: 3_000 };
    expect(store.replace(keyOf(first), 1, next).ok).toBe(true);
    expect(store.replace(keyOf(first), 1, { ...first, revision: 2 })).toMatchObject({
      error: { code: "conflict" },
    });
    expect(store.get(keyOf(first))).toEqual({ ok: true, value: next });
  } finally {
    await reopened.close();
  }
});

test("rejects a record that does not match its key, revision or contract", async () => {
  const root = await temporaryRoot("falryn-notice-ack-invalid-");
  const opened = await openProductStoreOrThrow(root);
  try {
    const store = createNoticeAcknowledgementRepository(opened);
    const value = record("invalid");
    expect(store.replace(keyOf(record("other")), 0, value)).toMatchObject({
      error: { code: "malformed" },
    });
    expect(store.replace(keyOf(value), 0, { ...value, revision: 2 })).toMatchObject({
      error: { code: "malformed" },
    });
    expect(
      store.replace(keyOf(value), 0, {
        ...value,
        expiresAt: value.acknowledgedAt + NOTICE_LIMITS.acknowledgementMs + 1,
      }),
    ).toMatchObject({ error: { code: "malformed" } });
    expect(store.replace(keyOf(value), 0, value, AbortSignal.abort())).toMatchObject({
      error: { code: "cancelled" },
    });
    expect(store.get(keyOf(value))).toEqual({ ok: true, value: null });
  } finally {
    await opened.close();
  }
});

test("a corrupt row denies instead of being replaced or read as an acknowledgement", async () => {
  const root = await temporaryRoot("falryn-notice-ack-corrupt-");
  const opened = await openProductStoreOrThrow(root);
  try {
    const store = createNoticeAcknowledgementRepository(opened);
    const value = record("corrupt");
    const key = keyOf(value);
    expect(
      opened.write((statements) => {
        statements.run(
          "INSERT INTO ecosystem_notice_acknowledgements (acknowledgement_key, revision, expires_at, record_json) VALUES ($key, 1, 2000, $json)",
          { key, json: JSON.stringify({ ...value, noticeId: canonicalDigest("someone-else") }) },
        );
        return null;
      }).ok,
    ).toBe(true);
    expect(store.get(key)).toMatchObject({ error: { code: "malformed" } });
    expect(store.replace(key, 1, { ...value, revision: 2 })).toMatchObject({
      error: { code: "malformed" },
    });
    // A corrupt row protects no valid state, so a caller that expects none can repair it.
    expect(store.replace(key, 0, value).ok).toBe(true);
    expect(store.get(key)).toEqual({ ok: true, value });
  } finally {
    await opened.close();
  }
});

test("expired acknowledgements are pruned and the live table is bounded", async () => {
  const root = await temporaryRoot("falryn-notice-ack-bound-");
  const opened = await openProductStoreOrThrow(root);
  try {
    const store = createNoticeAcknowledgementRepository(opened);
    const expired = record("expired", { acknowledgedAt: 1, expiresAt: 10 });
    expect(store.replace(keyOf(expired), 0, expired).ok).toBe(true);
    for (let index = 0; index < NOTICE_LIMITS.records; index++) {
      const live = record(`live-${index}`);
      const written = store.replace(keyOf(live), 0, live);
      if (!written.ok) throw new Error(`write ${index}: ${written.error.code}`);
    }
    expect(store.get(keyOf(expired))).toEqual({ ok: true, value: null });
    const overflow = record("overflow");
    expect(store.replace(keyOf(overflow), 0, overflow)).toMatchObject({ error: { code: "limit" } });
    const refreshed = record("live-0", { revision: 2, expiresAt: 5_000 });
    expect(store.replace(keyOf(refreshed), 1, refreshed).ok).toBe(true);
  } finally {
    await opened.close();
  }
}, 30_000); // Fills the table to its 1,024-record bound through the real SQLite store.

test("a failed transaction leaves no acknowledgement", async () => {
  const root = await temporaryRoot("falryn-notice-ack-fault-");
  const value = record("fault");
  await (await openProductStoreOrThrow(root)).close(); // Apply migrations before injecting faults.
  for (const failure of ["disk-full", "io-failure"] as const) {
    const faulty = await openProductStoreOrThrow(root, {
      faults: { failOperations: { transaction: failure } },
    });
    try {
      expect(
        createNoticeAcknowledgementRepository(faulty).replace(keyOf(value), 0, value),
      ).toMatchObject({
        error: { code: failure === "io-failure" ? "uncertain" : "unavailable" },
      });
    } finally {
      await faulty.close();
    }
  }
  const recovered = await openProductStoreOrThrow(root);
  try {
    expect(createNoticeAcknowledgementRepository(recovered).get(keyOf(value))).toEqual({
      ok: true,
      value: null,
    });
  } finally {
    await recovered.close();
  }
});
