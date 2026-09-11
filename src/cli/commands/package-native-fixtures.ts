import { expect } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { preparePackageCliFixture } from "./package-health-fixtures.ts";

export async function prepareNativeCliFixture(command: readonly string[], root: string) {
  const fixture = await preparePackageCliFixture(command, root, "healthy", true);
  const intent = {
    operationId: randomUUID(),
    packageId: "fixture",
    expectedRevision: 1,
    nativeActivation: {
      scope: "user",
      expectedRevision: 0,
      contributions: [fixture.contribution],
    },
  };
  const preview = await fixture.invoke(["package", "enable"], intent, packageReceiptSchema);
  expect(preview).toMatchObject({
    status: "preview",
    code: "native-activation-confirmation-required",
  });
  const confirmed = await fixture.invoke(
    ["package", "enable"],
    { ...intent, confirmation: preview.confirmation },
    packageReceiptSchema,
  );
  expect(confirmed).toMatchObject({ status: "completed", activation: "enabled" });
  const catalog = await fixture.invoke(
    ["extension", "catalog"],
    { action: "catalog" },
    z.object({
      page: z.object({
        entries: z.array(
          z.object({
            availability: z.string(),
            reason: z.string(),
            binding: z.object({ actionId: z.string() }).nullable(),
          }),
        ),
      }),
    }),
  );
  expect(catalog.page.entries.filter((entry) => entry.availability === "available")).toEqual([
    expect.objectContaining({ availability: "available", reason: "native-owner-bound" }),
  ]);
  expect(
    catalog.page.entries.find((entry) => entry.reason === "scope-disabled")?.binding,
  ).toBeNull();
  const binding = catalog.page.entries.find((entry) => entry.availability === "available")?.binding;
  expect(binding).not.toBeNull();
  const name = binding?.actionId.split("/").at(-1)?.split("@")[0];
  if (!name) throw new Error("missing native name");
  return { ...fixture, name };
}
