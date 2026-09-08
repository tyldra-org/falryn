import { expect, test } from "bun:test";
import { canonicalJson } from "../../domain/extensions/canonical.ts";
import type { PackageSource } from "../../domain/extensions/package-source.ts";
import { inspectionHost, packageSource } from "./package-fixtures.ts";
import { preparePackage } from "./prepare-package.ts";

test("bounds supplied inventory count, individual bytes and aggregate bytes before parsing", async () => {
  const snapshot = await packageSource().read();
  const cases = [
    {
      files: Array.from({ length: 4_097 }, (_, index) => ({
        path: `${index}.bin`,
        bytes: new Uint8Array(),
      })),
      code: "package-entry-limit",
    },
    {
      files: [{ path: "large.bin", bytes: new Uint8Array(16_777_217) }],
      code: "package-byte-limit",
    },
    {
      files: Array.from({ length: 5 }, (_, index) => ({
        path: `${index}.bin`,
        bytes: new Uint8Array(16_777_216),
      })),
      code: "package-byte-limit",
    },
  ];
  for (const entry of cases) {
    const source: PackageSource = {
      async read() {
        return { ...snapshot, files: entry.files };
      },
    };
    expect(await preparePackage(source, inspectionHost)).toEqual({ ok: false, code: entry.code });
  }
});

test("caps diagnostics without hiding their omitted count and rejects excessive metadata depth", async () => {
  const snapshot = await packageSource().read();
  const source: PackageSource = {
    async read() {
      return {
        ...snapshot,
        diagnostics: Array.from({ length: 200 }, () => ({ code: "unsupported-package-entry" })),
        omittedDiagnostics: 3,
      };
    },
  };
  const result = await preparePackage(source, inspectionHost);
  expect(result.ok).toBe(true);
  if (result.ok) {
    expect(result.package.diagnostics).toHaveLength(128);
    expect(result.package.omittedDiagnostics).toBe(75);
  }
  let deep: unknown = null;
  for (let index = 0; index < 34; index++) deep = { child: deep };
  expect(() => canonicalJson(deep)).toThrow("metadata-limit");
});
