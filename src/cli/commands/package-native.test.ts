import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { nativeProductJourney } from "../runtime/native-product-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);
test.skipIf(createHostSandbox().probe().status !== "available")(
  "native activation is explicit and publishes one real native tool after restart",
  async () => {
    const root = await temporaryRoot("falryn-native-cli-");
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
    );
    const { name } = fixture;
    const model = await nativeProductJourney({
      home: root,
      environment: fixture.environment,
      name,
    });
    expect(model.result.payload?.stage).toBe("attempt-completed");
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toContain(name);
    const continuation = z
      .object({
        messages: z.array(
          z.object({ role: z.string(), parts: z.array(z.object({ text: z.string().optional() })) }),
        ),
      })
      .parse(JSON.parse(model.requests[1] ?? "null"));
    const toolText = continuation.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts.map((part) => part.text ?? ""))
      .join("\n");
    expect(toolText).toContain('"answer":42');
    const stale = await nativeProductJourney(
      { home: root, environment: fixture.environment, name },
      async () => {
        const disable = { packageId: "fixture", operationId: randomUUID(), expectedRevision: 1 };
        const proposed = await fixture.invoke(
          ["package", "disable"],
          disable,
          packageReceiptSchema,
        );
        expect(
          (
            await fixture.invoke(
              ["package", "disable"],
              { ...disable, confirmation: proposed.confirmation },
              packageReceiptSchema,
            )
          ).status,
        ).toBe("completed");
      },
    );
    const staleContinuation = z
      .object({
        messages: z.array(
          z.object({ role: z.string(), parts: z.array(z.object({ text: z.string().optional() })) }),
        ),
      })
      .parse(JSON.parse(stale.requests[1] ?? "null"));
    const staleResult = staleContinuation.messages
      .filter((message) => message.role === "tool")
      .flatMap((message) => message.parts.map((part) => part.text ?? ""))
      .join("\n");
    expect(staleResult).toContain("stale-native-catalog");
    expect(staleResult).not.toContain('"answer":42');
    expect(stale.catalog.entries.every((entry) => entry.availability === "unavailable")).toBe(true);
  },
  30_000,
);
