/**
 * The host package adapter against a real temporary directory.
 *
 * The behaviours worth a real filesystem: an atomic publish, a staged file that
 * reads as unfinished, a refusal to overwrite a package the user already has,
 * and a positional read. A double would simply agree with all four.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { exportName, type LocalPath, localPath, type PackageWriterPort } from "../domain/index.ts";
import { createHostPackageWriter, STAGED_SUFFIX } from "./host-packages.ts";

const roots: string[] = [];

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

async function temporaryRoot(): Promise<LocalPath> {
  const created = await mkdtemp(join(tmpdir(), "falryn-packages-"));
  roots.push(created);
  return localPath(created);
}

const NAME = exportName.from("export-1");
const BYTES = new TextEncoder().encode("a whole package");

async function writer(): Promise<{ packages: PackageWriterPort; root: LocalPath }> {
  const root = await temporaryRoot();
  return { packages: createHostPackageWriter({ exportsRoot: root }), root };
}

describe("staging", () => {
  test("writes under a name that reads as unfinished", async () => {
    const { packages, root } = await writer();

    expect((await packages.begin(NAME)).ok).toBe(true);
    await packages.write(NAME, BYTES);

    // An interrupted export leaves something a user can recognize. Hiding it
    // would make abandoned bytes look like disk that vanished.
    expect(await readdir(root)).toEqual([`${NAME}${STAGED_SUFFIX}`]);
  });

  test("refuses a second export under one name", async () => {
    const { packages } = await writer();
    await packages.begin(NAME);

    expect(await packages.begin(NAME)).toMatchObject({
      ok: false,
      error: { code: "already-exists" },
    });
  });

  test("refuses to overwrite a package that is already published", async () => {
    const { packages, root } = await writer();
    await writeFile(join(root, NAME), "an export the user already has");

    const begun = await packages.begin(NAME);

    // Overwriting a package the user asked for is destroying an export to make
    // room for an export.
    expect(begun).toMatchObject({ ok: false, error: { code: "already-exists" } });
  });

  test("reports a write to a package that was never begun", async () => {
    const { packages } = await writer();

    expect(await packages.write(NAME, BYTES)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });
});

describe("publishing", () => {
  test("moves the staged package to its final name in one step", async () => {
    const { packages, root } = await writer();
    await packages.begin(NAME);
    await packages.write(NAME, BYTES);
    await packages.close(NAME);

    expect((await packages.finalize(NAME)).ok).toBe(true);

    expect(await readdir(root)).toEqual([NAME]);
    const length = await packages.byteLength(NAME);
    expect(length.ok && length.value).toBe(BYTES.byteLength);
  });

  test("refuses to publish bytes that are still open", async () => {
    const { packages } = await writer();
    await packages.begin(NAME);
    await packages.write(NAME, BYTES);

    // A rename moves a directory entry, not the page cache.
    expect((await packages.finalize(NAME)).ok).toBe(false);
  });

  test("reports a publish with nothing staged", async () => {
    const { packages } = await writer();

    expect(await packages.finalize(NAME)).toMatchObject({
      ok: false,
      error: { code: "not-found" },
    });
  });
});

describe("discarding", () => {
  test("removes the staged package and leaves the directory empty", async () => {
    const { packages, root } = await writer();
    await packages.begin(NAME);
    await packages.write(NAME, BYTES);

    expect((await packages.discard(NAME)).ok).toBe(true);

    expect(await readdir(root)).toEqual([]);
  });

  test("treats a staged package that is not there as already discarded", async () => {
    const { packages } = await writer();
    expect((await packages.discard(NAME)).ok).toBe(true);
  });

  test("never touches a published package", async () => {
    const { packages, root } = await writer();
    await packages.begin(NAME);
    await packages.write(NAME, BYTES);
    await packages.close(NAME);
    await packages.finalize(NAME);

    await packages.discard(NAME);

    expect(await readdir(root)).toEqual([NAME]);
  });
});

describe("reading a published package", () => {
  async function published(): Promise<PackageWriterPort> {
    const { packages } = await writer();
    await packages.begin(NAME);
    await packages.write(NAME, BYTES);
    await packages.close(NAME);
    await packages.finalize(NAME);
    return packages;
  }

  test("returns exactly the requested window", async () => {
    const packages = await published();

    const read = await packages.readRange(NAME, 2, 5);

    expect(read.ok && new TextDecoder().decode(read.value)).toBe("whole");
  });

  test("returns a short tail as the length it read", async () => {
    const packages = await published();

    const read = await packages.readRange(NAME, 10, 100);

    expect(read.ok && read.value.byteLength).toBe(BYTES.byteLength - 10);
  });

  test("refuses a negative offset or length", async () => {
    const packages = await published();

    expect(await packages.readRange(NAME, -1, 4)).toMatchObject({
      ok: false,
      error: { code: "out-of-range" },
    });
  });

  test("reports a package that is not there as absent rather than as a failure", async () => {
    const { packages } = await writer();

    const length = await packages.byteLength(NAME);

    expect(length.ok && length.value).toBeNull();
  });
});

describe("free space", () => {
  test("answers with a number or says it cannot", async () => {
    const { packages } = await writer();

    const available = await packages.availableBytes();

    // Either a real measurement or an honest `null`. A guess would refuse every
    // export or promise space nobody confirmed.
    expect(available.ok).toBe(true);
    expect(available.ok && (available.value === null || available.value >= 0)).toBe(true);
  });
});

describe("cancellation", () => {
  test("is reported before the operation touches the device", async () => {
    const { packages, root } = await writer();
    const controller = new AbortController();
    controller.abort();

    const begun = await packages.begin(NAME, controller.signal);

    expect(begun).toMatchObject({ ok: false, error: { code: "cancelled" } });
    expect(await readdir(root)).toEqual([]);
  });
});
