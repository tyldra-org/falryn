// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal template placeholders are the subject under test.
import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { declaredAuthority } from "../../application/extensions/package-fixtures.ts";
import { removeTemporaryRoots, temporaryRoot } from "../../data/fixtures.ts";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { packageReceiptSchema } from "../../domain/extensions/lifecycle.ts";
import { createHostSandbox } from "../../integrations/security/host-sandbox.ts";
import { snapshotOf } from "../../tui/composer/index.ts";
import {
  nativePromptJourney,
  nativePromptShellJourney,
} from "../runtime/native-product-fixtures.ts";
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
          {
            kind: "prompt",
            namespace: "fixture",
            id: "outline",
            path: "outline.md",
            description: "Outline one topic",
            authority: declaredAuthority,
            variables: {
              version: 1,
              entries: [
                { name: "topic", type: { kind: "string" }, required: true },
                { name: "depth", type: { kind: "number", integer: true, maximum: 3 }, default: 1 },
              ],
            },
          },
        ] as never,
        files: { "review.md": TEMPLATE, "outline.md": "Brief ${topic} at depth ${depth}." },
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

    // A required variable with no value submits nothing and names what to pass.
    const missing = await run("/outline depth=2");
    expect(missing.requests).toEqual([]);
    expect(missing.result.payload).toMatchObject({ stage: "template-failed", turnId: null });
    expect(missing.result.errors[0]).toMatchObject({
      code: "template.variable-missing",
      message: "Not sent: /outline needs topic (text); pass each as name=value.",
    });
    const typed = await run('/outline topic="error paths"');
    expect(typed.result.payload).toMatchObject({
      stage: "attempt-completed",
      prompt: "Brief error paths at depth 1.",
      promptTemplate: {
        prompt: "fixture:outline",
        variables: [
          { name: "topic", source: "argument", sensitive: false },
          { name: "depth", source: "default", sensitive: false },
        ],
      },
    });
    const wrong = await run("/outline topic=a depth=9");
    expect(wrong.requests).toEqual([]);
    expect(wrong.result.errors[0]?.code).toBe("template.variable-constraint");

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

const COMBINED =
  "---\ndescription: Combined contract\n---\n" +
  "Task for ${target}: $1 then ${2:-tests}; next ${@:3:2}; all [$ARGUMENTS]; " +
  "mode ${mode}; ${note:-no note}. Keep $HOME, $ and $x literal; $$1.\n";
const INVOCATION = '/combined target="src/a b.ts" mode=deep fix "the parser" x y z';
const PARTIAL = '/combined mode=deep fix "the parser" x y z';
const RENDERED =
  "Task for src/a b.ts: fix then the parser; next x y; all [fix the parser x y z]; " +
  "mode deep; no note. Keep $HOME, $ and $x literal; $fix.";

test.skipIf(createHostSandbox().probe().status !== "available")(
  "the renderer, slash invocation and typed variables work together through both product paths",
  async () => {
    const root = await temporaryRoot("falryn-native-prompt-integrated-");
    const fixture = await prepareNativeCliFixture(
      [process.execPath, "run", new URL("../../main.ts", import.meta.url).pathname],
      root,
      {
        declarations: [
          {
            kind: "prompt",
            namespace: "fixture",
            id: "combined",
            path: "combined.md",
            description: "Combined contract",
            authority: declaredAuthority,
            variables: {
              version: 1,
              entries: [
                { name: "target", type: { kind: "string" }, required: true },
                {
                  name: "mode",
                  type: { kind: "enum", values: ["quick", "deep"] },
                  default: "quick",
                },
                { name: "note", type: { kind: "string" } },
              ],
            },
          },
        ] as never,
        files: { "combined.md": COMBINED },
      },
    );
    const run = (prompt: string, session?: string) =>
      nativePromptJourney({
        home: root,
        environment: fixture.environment,
        prompt,
        ...(session === undefined ? {} : { session }),
      });

    // Headless: the exact rendered text is the provider input, with body-free provenance.
    const first = await run(INVOCATION);
    expect(first.result.payload).toMatchObject({
      stage: "attempt-completed",
      prompt: RENDERED,
      promptTemplate: {
        prompt: "fixture:combined",
        contentDigest: bytesDigest(COMBINED),
        argumentCount: 5,
        variables: [
          { name: "target", source: "argument", sensitive: false },
          { name: "mode", source: "argument", sensitive: false },
          { name: "note", source: "absent", sensitive: false },
        ],
      },
    });
    expect(first.requests).toHaveLength(1);
    expect(first.requests[0]).toContain(RENDERED);
    expect(first.requests[0]).not.toContain("/combined");
    const session = first.result.payload?.sessionId;
    if (session === undefined) throw new Error("no session");
    expect(first.events.length).toBeGreaterThan(0);

    // Every rejection continues the existing session without changing it.
    for (const [prompt, code] of [
      [PARTIAL, "template.variable-missing"],
      ["/combined target=a mode=slow", "template.variable-constraint"],
      ["/combined target=a extra=1", "template.variable-unknown"],
      ['/combined target=a "open', "template.unterminated-quote"],
    ] as const) {
      const rejected = await run(prompt, session);
      expect({ prompt, requests: rejected.requests }).toEqual({ prompt, requests: [] });
      expect(rejected.result.payload).toMatchObject({ stage: "template-failed", turnId: null });
      expect(rejected.result.errors[0]?.code).toBe(code);
      expect(rejected.events).toEqual(first.events);
    }
    const continued = await run(INVOCATION, session);
    expect(continued.requests).toHaveLength(1);
    expect(continued.requests[0]).toContain(RENDERED);
    expect(continued.events.length).toBeGreaterThan(first.events.length);

    // Terminal host: production attachments, durable native publication, ordinary submission.
    const shell = await nativePromptShellJourney({ home: root, environment: fixture.environment });
    try {
      const expand = shell.attached.submission.expandTemplate;
      if (expand === undefined) throw new Error("no template expansion");
      const signal = new AbortController().signal;
      expect(await expand(PARTIAL, signal)).toEqual({
        kind: "needs-input",
        name: "combined",
        variables: [{ name: "target", expected: "text", description: "", sensitive: false }],
      });
      const transcript = shell.attached.transcriptFeed.events().length;
      expect(await expand("/combined target=a mode=slow", signal)).toMatchObject({
        kind: "failed",
        code: "variable-constraint",
      });
      const expanded = await expand(PARTIAL, signal, { target: "src/a b.ts" });
      expect(expanded).toMatchObject({
        kind: "expanded",
        text: RENDERED,
        fact: {
          contentDigest: bytesDigest(COMBINED),
          variables: [
            { name: "target", source: "entered", sensitive: false },
            { name: "mode", source: "argument", sensitive: false },
            { name: "note", source: "absent", sensitive: false },
          ],
        },
      });
      // Expansion alone sends nothing and records nothing.
      expect(shell.requests).toEqual([]);
      expect(shell.attached.transcriptFeed.events()).toHaveLength(transcript);
      const submitted = await shell.attached.submission.submit(snapshotOf(RENDERED, 1));
      expect(submitted.kind).toBe("accepted");
      expect(shell.requests).toHaveLength(1);
      expect(JSON.stringify(shell.requests[0])).toContain(RENDERED);

      // A package disabled after the preview fails the next expansion in both paths.
      const disable = { packageId: "fixture", operationId: randomUUID(), expectedRevision: 1 };
      const proposed = await fixture.invoke(["package", "disable"], disable, packageReceiptSchema);
      await fixture.invoke(
        ["package", "disable"],
        { ...disable, confirmation: proposed.confirmation },
        packageReceiptSchema,
      );
      expect(await expand(INVOCATION, signal)).toMatchObject({
        kind: "failed",
        code: "template-unavailable",
      });
      expect(shell.requests).toHaveLength(1);
    } finally {
      await shell.close();
    }
    const disabled = await run(INVOCATION, session);
    expect(disabled.requests).toEqual([]);
    expect(disabled.result.payload?.stage).toBe("template-failed");
  },
  90_000,
);
