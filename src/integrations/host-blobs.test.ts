/**
 * The host blob adapter against a real temporary directory.
 *
 * This is the one module that writes artifact bytes, so its checks run against
 * an actual filesystem rather than a double: an atomic rename, a flush before
 * the handle goes, a positional read, and a two-level listing are all
 * behaviors a double would simply agree with.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  artifactId,
  CONTENT_DIGEST_ALGORITHM,
  contentDigest,
  type LocalPath,
  localPath,
} from "../domain/index.ts";
import { createSha256Hasher } from "./content-digest.ts";
import { createHostBlobStore, type HostBlobStore } from "./host-blobs.ts";

const roots: string[] = [];
const stores: HostBlobStore[] = [];

afterEach(async () => {
  while (stores.length > 0) {
    const store = stores.pop();
    if (store !== undefined) {
      await store.releaseOpenHandles();
    }
  }
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-blobs-"));
  roots.push(created);
  return localPath(created);
}

const DIGEST = contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${"ab".repeat(32)}`);
const OTHER = contentDigest.from(`${CONTENT_DIGEST_ALGORITHM}:${"cd".repeat(32)}`);
const ID = artifactId.from("capture-1");
const BYTES = new TextEncoder().encode("half a loaf");

async function store(): Promise<{ blobs: HostBlobStore; artifacts: LocalPath; temp: LocalPath }> {
  const artifacts = await temporaryRoot();
  const temp = await temporaryRoot();
  const blobs = createHostBlobStore({ artifactsRoot: artifacts, temporaryRoot: temp });
  stores.push(blobs);
  return {
    blobs,
    artifacts,
    temp,
  };
}

describe("writing in-flight bytes", () => {
  test("allocates under the name reconciliation can recognize", async () => {
    const { blobs, temp } = await store();

    expect((await blobs.allocate({ scope: "temporary", artifactId: ID })).ok).toBe(true);

    expect(await readdir(temp)).toEqual(["artifact-capture-1.part"]);
  });

  test("refuses a second allocation under one identity", async () => {
    const { blobs } = await store();
    await blobs.allocate({ scope: "temporary", artifactId: ID });

    const again = await blobs.allocate({ scope: "temporary", artifactId: ID });

    // Two ingests under one identity means one of them is about to have its
    // bytes silently replaced.
    expect(again).toMatchObject({ ok: false, error: { code: "already-exists" } });
  });

  test("appends chunks in order and reports their length once closed", async () => {
    const { blobs } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES.slice(0, 4));
    await blobs.write(location, BYTES.slice(4));
    await blobs.close(location);

    const length = await blobs.byteLength(location);

    expect(length.ok && length.value).toBe(BYTES.byteLength);
  });

  test("closes twice without reporting a failure", async () => {
    const { blobs } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);

    expect((await blobs.close(location)).ok).toBe(true);
    expect((await blobs.close(location)).ok).toBe(true);
  });

  test("refuses a write to a blob that was never allocated", async () => {
    const { blobs } = await store();

    const written = await blobs.write({ scope: "temporary", artifactId: ID }, BYTES);

    expect(written).toMatchObject({ ok: false, error: { code: "not-found" } });
  });
});

describe("finalizing", () => {
  test("moves closed bytes into content, sharded by digest", async () => {
    const { blobs, artifacts, temp } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES);
    await blobs.close(location);

    const finalized = await blobs.finalize(location, { scope: "content", digest: DIGEST });

    expect(finalized.ok).toBe(true);
    expect(await readdir(temp)).toEqual([]);
    expect(await readdir(join(artifacts, "blobs"))).toEqual(["ab"]);
    expect(await readdir(join(artifacts, "blobs", "ab"))).toEqual(["ab".repeat(32)]);
  });

  test("refuses to move bytes that are still open", async () => {
    const { blobs } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES);

    const finalized = await blobs.finalize(location, { scope: "content", digest: DIGEST });

    // A rename moves a directory entry, not the page cache.
    expect(finalized.ok).toBe(false);
  });

  test("quarantines through the same move, to a different scope", async () => {
    const { blobs, artifacts } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES);
    await blobs.close(location);

    await blobs.finalize(location, { scope: "quarantine", digest: DIGEST });

    expect(await readdir(join(artifacts, "quarantine", "ab"))).toEqual(["ab".repeat(32)]);
  });

  test("reports a missing source rather than creating an empty destination", async () => {
    const { blobs, artifacts } = await store();

    const finalized = await blobs.finalize(
      { scope: "temporary", artifactId: ID },
      { scope: "content", digest: DIGEST },
    );

    expect(finalized).toMatchObject({ ok: false, error: { code: "not-found" } });
    expect(await readdir(join(artifacts, "blobs", "ab"))).toEqual([]);
  });
});

describe("reading", () => {
  async function stored(): Promise<HostBlobStore> {
    const { blobs } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES);
    await blobs.close(location);
    await blobs.finalize(location, { scope: "content", digest: DIGEST });
    return blobs;
  }

  test("returns exactly the requested window", async () => {
    const blobs = await stored();

    const read = await blobs.readRange({ scope: "content", digest: DIGEST }, 5, 1);

    expect(read.ok && new TextDecoder().decode(read.value)).toBe("a");
  });

  test("returns a short tail as the length it read", async () => {
    const blobs = await stored();

    const read = await blobs.readRange({ scope: "content", digest: DIGEST }, 8, 100);

    // Handing back the tail of an over-allocated buffer would report zeros as
    // content.
    expect(read.ok && read.value.byteLength).toBe(3);
  });

  test("refuses a negative offset or length", async () => {
    const blobs = await stored();

    expect(await blobs.readRange({ scope: "content", digest: DIGEST }, -1, 4)).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
  });

  test("reports bytes that are not there as absent rather than as a failure", async () => {
    const { blobs } = await store();

    const length = await blobs.byteLength({ scope: "content", digest: OTHER });

    expect(length.ok && length.value).toBeNull();
  });
});

describe("removing", () => {
  test("treats bytes that are not there as already removed", async () => {
    const { blobs } = await store();

    expect((await blobs.remove({ scope: "content", digest: OTHER })).ok).toBe(true);
  });

  test("closes and deletes in-flight bytes together", async () => {
    const { blobs, temp } = await store();
    const location = { scope: "temporary", artifactId: ID } as const;
    await blobs.allocate(location);
    await blobs.write(location, BYTES);

    expect((await blobs.remove(location)).ok).toBe(true);

    expect(await readdir(temp)).toEqual([]);
  });
});

describe("listing", () => {
  test("finds every stored digest across shards, and nothing else", async () => {
    const { blobs, artifacts } = await store();
    for (const digest of [DIGEST, OTHER]) {
      const location = {
        scope: "temporary",
        artifactId: artifactId.from(`a${digest.length}`),
      } as const;
      await blobs.allocate(location);
      await blobs.close(location);
      await blobs.finalize(location, { scope: "content", digest });
    }
    // A file that is not a digest is not a blob this store wrote.
    await writeFile(join(artifacts, "blobs", "ab", "README"), "not a blob");

    const listed = await blobs.list("content", 100);

    expect(listed.ok && listed.value.map((one) => one.scope)).toEqual(["content", "content"]);
    expect(
      listed.ok &&
        listed.value.flatMap((one) => (one.scope === "temporary" ? [] : [one.digest])).sort(),
    ).toEqual([DIGEST, OTHER].sort());
  });

  test("finds in-flight bytes only under the declared name", async () => {
    const { blobs, temp } = await store();
    await blobs.allocate({ scope: "temporary", artifactId: ID });
    await writeFile(join(temp, "someone-elses-file"), "x");

    const listed = await blobs.list("temporary", 100);

    expect(listed.ok && listed.value).toEqual([{ scope: "temporary", artifactId: ID }]);
  });

  test("stops at the requested bound", async () => {
    const { blobs } = await store();
    for (const digest of [DIGEST, OTHER]) {
      const location = {
        scope: "temporary",
        artifactId: artifactId.from(`b${digest.length}`),
      } as const;
      await blobs.allocate(location);
      await blobs.close(location);
      await blobs.finalize(location, { scope: "content", digest });
    }

    const listed = await blobs.list("content", 1);

    expect(listed.ok && listed.value).toHaveLength(1);
  });

  test("answers with nothing for a scope that was never created", async () => {
    const { blobs } = await store();

    const listed = await blobs.list("quarantine", 10);

    // A directory that does not exist holds nothing, and that is a complete
    // answer rather than a failure to look.
    expect(listed.ok && listed.value).toEqual([]);
  });
});

describe("cancellation", () => {
  test("is reported before the operation touches the device", async () => {
    const { blobs, temp } = await store();
    const controller = new AbortController();
    controller.abort();

    const allocated = await blobs.allocate(
      { scope: "temporary", artifactId: ID },
      controller.signal,
    );

    expect(allocated).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await readdir(temp)).toEqual([]);
  });
});

describe("the digest the store verifies with", () => {
  test("names the function that produced it and matches the bytes", async () => {
    const hasher = createSha256Hasher().create();
    hasher.update(new TextEncoder().encode("abc"));

    // The published SHA-256 of "abc".
    expect(String(hasher.digest())).toBe(
      `${CONTENT_DIGEST_ALGORITHM}:ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad`,
    );
  });

  test("gives one answer per hasher, over the chunks it was given", async () => {
    const port = createSha256Hasher();
    const whole = port.create();
    whole.update(new TextEncoder().encode("abc"));
    const split = port.create();
    split.update(new TextEncoder().encode("a"));
    split.update(new TextEncoder().encode("bc"));

    expect(split.digest()).toBe(whole.digest());
  });
});
