import { expect, test } from "bun:test";
import { z } from "zod";

import { responsesToolSchema } from "./tool-schema.ts";

test("strict wire round trips omission, explicit null, arrays and root variants", () => {
  const native = z.discriminatedUnion("kind", [
    z
      .object({
        kind: z.literal("write"),
        targets: z.array(
          z
            .object({
              path: z.string(),
              expectedRevision: z.string().optional(),
              expires: z.string().nullish(),
            })
            .strict(),
        ),
      })
      .strict(),
    z.object({ kind: z.literal("remove"), path: z.string() }).strict(),
  ]);
  const codec = responsesToolSchema(z.toJSONSchema(native));
  const wire = z.fromJSONSchema(codec.schema);
  for (const input of [
    {
      kind: "write",
      targets: [{ path: "a" }, { path: "b", expectedRevision: "rev-1", expires: null }],
    },
    { kind: "write", targets: [{ path: "c", expires: "tomorrow" }] },
    { kind: "remove", path: "a" },
  ]) {
    const encoded = codec.encode(input);
    expect(wire.safeParse(encoded).success).toBe(true);
    expect(codec.decode(encoded)).toEqual(input);
    expect(native.safeParse(codec.decode(encoded)).success).toBe(true);
  }
  expect(() => codec.decode({ kind: "remove", path: "a" })).toThrow("input envelope");
  const invalid = codec.decode({ input: { kind: "remove", path: "a", unknown: true } });
  expect(native.safeParse(invalid).success).toBe(false);
});

test("strict decoding preserves required null rejection and unknown properties", () => {
  const native = z.object({ required: z.string(), optional: z.string().optional() }).strict();
  const codec = responsesToolSchema(z.toJSONSchema(native));
  expect(codec.decode({ required: "yes", optional: null })).toEqual({ required: "yes" });
  expect(native.safeParse(codec.decode({ required: null, optional: null })).success).toBe(false);
  expect(
    native.safeParse(codec.decode({ required: "yes", optional: null, extra: true })).success,
  ).toBe(false);
});
