import { describe, expect, test } from "bun:test";
import { sourceFixture, sourceScope } from "../../domain/context/instruction-sources.fixtures.ts";
import {
  EMPTY_SOURCE_PREFERENCES,
  instructionSourceKey,
} from "../../domain/context/instruction-sources.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import {
  createInstructionSourceOwner,
  type InstructionSourceSnapshot,
} from "./instruction-source-owner.ts";

function fixture() {
  const source = sourceFixture("AGENTS.md");
  const bytes = new Map([[source.digest, new TextEncoder().encode("AGENTS.md")]]);
  let snapshot: InstructionSourceSnapshot = {
    configuration: "1",
    workspace: "workspace",
    sources: [source],
    preferences: EMPTY_SOURCE_PREFERENCES,
  };
  let allowed = true;
  let failure = false;
  let reads = 0;
  const owner = createInstructionSourceOwner({
    async scan(signal) {
      signal.throwIfAborted();
      if (failure) throw new Error("malformed-source");
      return snapshot;
    },
    async read(item, signal) {
      signal.throwIfAborted();
      reads++;
      const value = bytes.get(item.digest);
      if (!value) throw new Error("source-missing");
      return value;
    },
    async current() {
      return allowed;
    },
  });
  return {
    owner,
    source,
    bytes,
    reads: () => reads,
    reject: () => {
      failure = true;
    },
    revoke: () => {
      allowed = false;
    },
    update: (value: InstructionSourceSnapshot) => {
      snapshot = value;
    },
    snapshot: () => snapshot,
  };
}

describe("atomic instruction source publications", () => {
  test("binds old bytes while later admissions see a complete replacement", async () => {
    const f = fixture();
    const old = await f.owner.prepare(sourceScope);
    expect(old.ok).toBe(true);
    if (!old.ok) return;
    const bytes = new TextEncoder().encode("edited instructions");
    const digest = bytesDigest(bytes);
    f.bytes.set(digest, bytes);
    f.update({ ...f.snapshot(), sources: [{ ...f.source, digest }] });
    const replacement = await f.owner.prepare(sourceScope);
    expect(replacement.ok).toBe(true);
    if (!replacement.ok) return;
    expect(old.binding.sections[0]?.content).toBe("AGENTS.md");
    expect(replacement.binding.sections[0]?.content).toBe("edited instructions");
    expect(old.binding.receipt.generation).not.toBe(replacement.binding.receipt.generation);
    expect(await old.binding.current(new AbortController().signal)).toBe(true);
  });
  test("no-op rescans reuse parse products and do not change instruction content", async () => {
    const f = fixture();
    const first = await f.owner.prepare(sourceScope);
    const second = await f.owner.prepare(sourceScope);
    expect(first.ok && second.ok).toBe(true);
    if (!first.ok || !second.ok) return;
    expect(f.reads()).toBe(1);
    expect(second.binding.receipt).toMatchObject({
      generation: first.binding.receipt.generation,
      contentDigest: first.binding.receipt.contentDigest,
      reload: "unchanged",
      reused: true,
    });
  });
  test("a malformed partial scan retains complete content but cannot retain revoked authority", async () => {
    const f = fixture();
    const first = await f.owner.prepare(sourceScope);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    f.reject();
    const retained = await f.owner.prepare(sourceScope);
    expect(retained.ok).toBe(true);
    if (!retained.ok) return;
    expect(retained.binding.receipt.reload).toBe("rejected");
    expect(retained.binding.sections).toEqual(first.binding.sections);
    f.revoke();
    expect(await first.binding.current(new AbortController().signal)).toBe(false);
    expect(await f.owner.prepare(sourceScope)).toMatchObject({
      ok: false,
      code: "source-authority-changed",
    });
  });
  test("rejects changed bytes without publishing partial metadata", async () => {
    const f = fixture();
    await f.owner.prepare(sourceScope);
    const before = f.owner.snapshot();
    const digest = bytesDigest(new TextEncoder().encode("declared"));
    f.bytes.set(digest, new TextEncoder().encode("different"));
    f.update({ ...f.snapshot(), sources: [{ ...f.source, digest }] });
    const retained = await f.owner.prepare(sourceScope);
    expect(retained).toMatchObject({ ok: true, binding: { receipt: { reload: "rejected" } } });
    if (retained.ok) expect(retained.binding.sections[0]?.content).toBe("AGENTS.md");
    expect(f.owner.snapshot()).toBe(before);
  });
  test("reference cycles and missing references fail before provider composition", async () => {
    const f = fixture();
    const key = instructionSourceKey(f.source.identity);
    f.update({ ...f.snapshot(), sources: [{ ...f.source, references: [key] }] });
    expect(await f.owner.prepare(sourceScope)).toMatchObject({
      ok: false,
      code: "instruction-reference-cycle",
    });
    f.update({
      ...f.snapshot(),
      sources: [
        { ...f.source, references: [instructionSourceKey(sourceFixture("missing.md").identity)] },
      ],
    });
    expect(await f.owner.prepare(sourceScope)).toMatchObject({
      ok: false,
      code: "instruction-reference-missing",
    });
    expect(f.owner.snapshot()).toBeNull();
  });
  test("session choices are volatile and reset restores persisted preferences", async () => {
    const f = fixture();
    const missing = instructionSourceKey(sourceFixture("missing.md").identity);
    f.owner.select({
      version: 1,
      choices: [{ kind: "instruction", name: "workspace:", source: missing }],
      restrictions: [],
    });
    expect((await f.owner.prepare(sourceScope)).ok).toBe(false);
    f.owner.reset();
    expect((await f.owner.prepare(sourceScope)).ok).toBe(true);
    expect(f.snapshot().preferences).toEqual(EMPTY_SOURCE_PREFERENCES);
  });
  test("pre-aborted scans neither read nor publish", async () => {
    const f = fixture();
    expect(await f.owner.prepare(sourceScope, [], AbortSignal.abort())).toMatchObject({
      ok: false,
      code: "cancelled",
    });
    expect(f.reads()).toBe(0);
    expect(f.owner.snapshot()).toBeNull();
  });
});

test("pending session restriction revisions cannot widen an already requested selection", async () => {
  const f = fixture();
  const queued = f.owner.prepare(sourceScope);
  f.owner.select({ ...EMPTY_SOURCE_PREFERENCES, restrictions: [] });
  expect(await queued).toMatchObject({ ok: false, code: "source-controls-changed" });
  expect(f.reads()).toBe(0);
});
test("configuration mismatch fails before reading a body", async () => {
  const f = fixture();
  expect(await f.owner.prepare(sourceScope, [], new AbortController().signal, "old")).toMatchObject(
    { ok: false, code: "source-configuration-changed" },
  );
  expect(f.reads()).toBe(0);
});
test("no-op admissions across turn identities keep effective content stable", async () => {
  const f = fixture();
  await f.owner.prepare(sourceScope);
  const next = await f.owner.prepare({ ...sourceScope, execution: "next" });
  expect(next).toMatchObject({
    ok: true,
    binding: { receipt: { reused: true, contentChanged: false } },
  });
  expect(f.reads()).toBe(1);
});
test("new invocation restrictions invalidate an existing binding before new effects", async () => {
  const f = fixture();
  const bound = await f.owner.prepare(sourceScope);
  f.owner.select({
    ...EMPTY_SOURCE_PREFERENCES,
    restrictions: [
      { source: instructionSourceKey(f.source.identity), user: false, automatic: false },
    ],
  });
  expect(bound.ok && (await bound.binding.current(new AbortController().signal))).toBe(false);
});

test("inspection pages a larger metadata catalog without loading unselected bodies", async () => {
  const f = fixture();
  const skills = Array.from({ length: 130 }, (_, index) => {
    const source = sourceFixture(`skills/${index}/SKILL.md`);
    return {
      ...source,
      identity: { ...source.identity, kind: "skill" as const, localId: `skill-${index}` },
    };
  });
  f.update({ ...f.snapshot(), sources: [f.source, ...skills] });
  expect((await f.owner.prepare(sourceScope)).ok).toBe(true);
  const first = f.owner.inspect(sourceScope);
  expect(first?.sources).toHaveLength(100);
  expect(first?.total).toBe(131);
  expect(f.owner.inspect(sourceScope, [], first?.nextOffset ?? 0)?.sources).toHaveLength(31);
  expect(f.reads()).toBe(1);
});
test("oversized source and aggregate bodies never produce partial instructions", async () => {
  for (const count of [1, 9]) {
    const body = new Uint8Array(count === 1 ? 1048577 : 1048576).fill(65);
    const digest = bytesDigest(body);
    const f = fixture();
    f.bytes.set(digest, body);
    f.update({
      ...f.snapshot(),
      sources: Array.from({ length: count }, (_, index) =>
        sourceFixture(`source-${index}.md`, { digest }),
      ),
    });
    expect(await f.owner.prepare(sourceScope)).toMatchObject({
      ok: false,
      code: count === 1 ? "instruction-source-byte-limit" : "instruction-aggregate-byte-limit",
    });
    expect(f.owner.snapshot()).toBeNull();
  }
});
test("the publication queue rejects excess work and queued cancellation reads no bytes", async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let scans = 0;
  const owner = createInstructionSourceOwner({
    async scan() {
      scans++;
      await held;
      return {
        configuration: "0",
        workspace: "workspace",
        sources: [],
        preferences: EMPTY_SOURCE_PREFERENCES,
      };
    },
    async read() {
      throw new Error("unexpected body read");
    },
    async current() {
      return true;
    },
  });
  const abort = new AbortController();
  const pending = Array.from({ length: 64 }, () => owner.prepare(sourceScope, [], abort.signal));
  expect(await owner.prepare(sourceScope)).toMatchObject({ ok: false, code: "source-queue-full" });
  abort.abort();
  release();
  expect(
    (await Promise.all(pending)).every((result) => !result.ok && result.code === "cancelled"),
  ).toBe(true);
  expect(scans).toBeLessThanOrEqual(1);
});

test("a preference-only change affects the next selection while admitted content stays usable", async () => {
  const f = fixture();
  const bound = await f.owner.prepare(sourceScope);
  f.owner.select({
    ...EMPTY_SOURCE_PREFERENCES,
    choices: [
      {
        kind: "instruction",
        name: "workspace:",
        source: instructionSourceKey(sourceFixture("missing.md").identity),
      },
    ],
  });
  expect(bound.ok && (await bound.binding.current(new AbortController().signal))).toBe(true);
  expect((await f.owner.prepare(sourceScope)).ok).toBe(false);
});

test("watcher observations publish atomically without consuming next-turn provenance", async () => {
  const f = fixture();
  const old = await f.owner.prepare(sourceScope);
  const bytes = new TextEncoder().encode("after watcher rescan");
  const digest = bytesDigest(bytes);
  f.bytes.set(digest, bytes);
  f.update({ ...f.snapshot(), sources: [{ ...f.source, digest }] });
  const observed = await f.owner.prepare(sourceScope, [], undefined, undefined, true);
  expect(observed.ok).toBe(true);
  expect(old.ok && old.binding.sections[0]?.content).toBe("AGENTS.md");
  const admitted = await f.owner.prepare({ ...sourceScope, execution: "next" });
  expect(admitted).toMatchObject({
    ok: true,
    binding: { receipt: { reload: "committed", contentChanged: true, reused: false } },
  });
  if (admitted.ok && old.ok)
    expect(admitted.binding.receipt.previousGeneration).toBe(old.binding.receipt.generation);
  const malformed = new Uint8Array([0xff]);
  const badDigest = bytesDigest(malformed);
  f.bytes.set(badDigest, malformed);
  f.update({ ...f.snapshot(), sources: [{ ...f.source, digest: badDigest }] });
  const rejected = await f.owner.prepare(sourceScope);
  expect(rejected).toMatchObject({
    ok: true,
    binding: {
      receipt: {
        reload: "rejected",
        rejection: "source-invalid",
        rejectedSource: instructionSourceKey(f.source.identity),
      },
    },
  });
  if (rejected.ok) expect(rejected.binding.sections[0]?.content).toBe("after watcher rescan");
});

test("a reference cannot bypass the invocation eligibility of an unselected skill", async () => {
  const f = fixture();
  const hidden = sourceFixture("manual/SKILL.md", {
    eligibility: { user: true, automatic: false },
  });
  hidden.identity = { ...hidden.identity, kind: "skill", localId: "manual" };
  f.update({
    ...f.snapshot(),
    sources: [{ ...f.source, references: [instructionSourceKey(hidden.identity)] }, hidden],
  });
  expect(await f.owner.prepare(sourceScope)).toMatchObject({
    ok: false,
    code: "instruction-reference-denied",
  });
  expect(f.reads()).toBe(1);
});
