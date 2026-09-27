// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal template placeholders are the subject under test.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { declaredAuthority } from "../../application/extensions/package-fixtures.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { nativePromptJourney } from "../runtime/native-product-fixtures.ts";
import { prepareNativeCliFixture } from "./package-native-fixtures.ts";

afterEach(removeTemporaryRoots);

const TEMPLATE =
  "---\ndescription: Review one file\nargument-hint: <file> [focus]\n---\n" +
  "Review $1 focusing on ${@:2}. Keep $HOME literal.\n";

test.skipIf(createHostSandbox().probe().status !== "available")(
  "falryn run expands an admitted package prompt template before the ordinary submission",
  async () => {
    const root = await temporaryRoot("falryn-native-prompt-");
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      {
        declarations: [
          {
            kind: "prompt",
            namespace: "fixture",
            id: "review",
            path: "review.md",
            description: "Review one file",
            authority: declaredAuthority,
          },
        ] as never,
        files: { "review.md": TEMPLATE },
      },
    );
    const run = (prompt: string) =>
      nativePromptJourney({ home: root, environment: fixture.environment, prompt });

    const expanded = await run('/review src/app.ts "error paths" tests');
    expect(expanded.result.payload).toMatchObject({
      stage: "attempt-completed",
      prompt: "Review src/app.ts focusing on error paths tests. Keep $HOME literal.",
      promptTemplate: {
        version: 1,
        packageId: "fixture",
        prompt: "fixture:review",
        contentDigest: bytesDigest(TEMPLATE),
        argumentCount: 3,
        substitutions: 2,
      },
    });
    expect(expanded.requests).toHaveLength(1);
    expect(expanded.requests[0]).toContain(
      "Review src/app.ts focusing on error paths tests. Keep $HOME literal.",
    );
    expect(expanded.requests[0]).not.toContain("/review");

    const qualified = await run("/fixture:review lib.ts");
    expect(qualified.result.payload?.prompt).toBe(
      "Review lib.ts focusing on . Keep $HOME literal.",
    );

    for (const [prompt, code] of [
      ['/review "open', "template.unterminated-quote"],
      ["/missing x", "template.unknown-template"],
    ] as const) {
      const failed = await run(prompt);
      expect(failed.requests).toEqual([]);
      expect(failed.result.payload).toMatchObject({
        stage: "template-failed",
        prompt,
        turnId: null,
      });
      expect(failed.result.errors[0]?.code).toBe(code);
    }

    const disable = { packageId: "fixture", operationId: randomUUID(), expectedRevision: 1 };
    const proposed = await fixture.invoke(["package", "disable"], disable, packageReceiptSchema);
    expect(
      (
        await fixture.invoke(
          ["package", "disable"],
          { ...disable, confirmation: proposed.confirmation },
          packageReceiptSchema,
        )
      ).status,
    ).toBe("completed");
    const disabled = await run("/review src/app.ts");
    expect(disabled.requests).toEqual([]);
    expect(disabled.result.payload?.stage).toBe("template-failed");
  },
  60_000,
);
