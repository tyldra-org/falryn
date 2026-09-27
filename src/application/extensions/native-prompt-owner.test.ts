// biome-ignore-all lint/suspicious/noTemplateCurlyInString: literal template placeholders are the subject under test.
import { expect, test } from "bun:test";
import { bytesDigest, ExtensionInputError } from "../../domain/extensions/canonical.ts";
import {
  type CatalogEntry,
  catalogEntryKey,
  createExtensionCatalog,
} from "../../domain/extensions/catalog.ts";
import { catalogFixture } from "../../domain/extensions/catalog-fixtures.ts";
import type { NativeActivation } from "../../domain/extensions/native-activation.ts";
import { configurationGeneration } from "../../domain/foundation/index.ts";
import {
  createNativePromptOwner,
  PACKAGE_PROMPT_OWNER,
  type PromptTemplateReadRequest,
} from "./native-prompt-owner.ts";
import { createNativeRegistrationPublisher } from "./native-registration.ts";
import {
  declaredAuthority,
  inspectionHost,
  packageSource,
  pluginManifest,
} from "./package-fixtures.ts";
import { type PreparedPackage, preparePackage } from "./prepare-package.ts";

const REVIEW =
  "---\ndescription: Review a file\nargument-hint: <file> [focus]\n---\n\nReview $1 focusing on ${@:2}.\nPRIVATE-BODY\n";

async function prepared(
  name: string,
  files: Record<string, string>,
  explicit = false,
  variables?: unknown,
) {
  const result = await preparePackage(
    packageSource(
      pluginManifest(
        {
          version: 1,
          contributions: explicit
            ? [
                {
                  kind: "prompt",
                  namespace: name,
                  id: "summarize",
                  path: "templates/summary.md",
                  description: "Summarize",
                  authority: declaredAuthority,
                  ...(variables === undefined ? {} : { variables }),
                },
              ]
            : [],
        },
        { name },
      ),
      files,
    ),
    inspectionHost,
  );
  if (!result.ok) throw new Error(result.code);
  return result.package;
}

function entriesFor(
  pkg: PreparedPackage,
  overrides: (localId: string) => Partial<CatalogEntry> = () => ({}),
) {
  const template = catalogFixture();
  return pkg.contributions.map(
    (contribution): CatalogEntry => ({
      ...template,
      source: {
        kind: "package",
        owner: pkg.identity,
        activation: {
          version: 1,
          packageIdentityDigest: pkg.identityDigest,
          scope: "user",
          scopeAuthorityId: bytesDigest("scope"),
          scopeAuthorityGeneration: 1,
          configurationGeneration: 1,
          activationRevision: 1,
          catalogGeneration: 1,
        },
      },
      contribution: contribution.identity,
      family: null,
      effects: [],
      aliases: [contribution.identity.localId],
      ...overrides(contribution.identity.localId),
    }),
  );
}

function activationFor(pkg: PreparedPackage): NativeActivation {
  return {
    version: 1,
    actor: bytesDigest("actor"),
    scopeKey: bytesDigest("scope-" + pkg.identityDigest),
    scopeBinding: bytesDigest("binding"),
    authority: { scope: "user", id: bytesDigest("scope"), generation: 1 },
    package: pkg.identityDigest,
    installedRevision: 1,
    configuration: bytesDigest("config"),
    contributions: pkg.contributions.map((entry) => entry.identityDigest),
    revision: 1,
  };
}

async function publish(
  packages: readonly {
    pkg: PreparedPackage;
    files: Record<string, string>;
    entries?: CatalogEntry[];
  }[],
  read?: (request: PromptTemplateReadRequest) => Uint8Array,
) {
  const reads: PromptTemplateReadRequest[] = [];
  const owner = createNativePromptOwner({
    async read(request) {
      reads.push(request);
      if (read) return read(request);
      const pkg = packages.find(({ pkg }) => pkg.identity.packageId === request.packageId);
      const text = pkg?.files[request.path];
      if (text === undefined) throw new ExtensionInputError("prompt-source-missing");
      return new TextEncoder().encode(text);
    },
  });
  const entries = packages.flatMap(({ pkg, entries }) => entries ?? entriesFor(pkg));
  const activations = new Map(
    packages.flatMap(({ pkg, entries: own }) =>
      (own ?? entriesFor(pkg)).map(
        (entry) => [catalogEntryKey(entry), activationFor(pkg)] as const,
      ),
    ),
  );
  const publication = createNativeRegistrationPublisher([owner]).publish({
    catalog: createExtensionCatalog({ generation: 1, inputs: bytesDigest("inputs"), entries }),
    generation: configurationGeneration.from(1),
    packages: new Map(packages.map(({ pkg }) => [pkg.identityDigest, pkg])),
    activations,
    trust: { inspect: () => null },
    signal: new AbortController().signal,
  });
  return { publication, reads };
}

test("admitted package prompts bind metadata only and expand on explicit invocation", async () => {
  const files = { "prompts/review.md": REVIEW, "prompts/plain.md": "\n  Say hi to $1\n" };
  const pkg = await prepared("kit", files);
  const { publication, reads } = await publish([{ pkg, files }]);
  expect(reads).toHaveLength(0);
  expect(
    publication.prompts.templates.map(({ localId, qualifiedName, description, argumentHint }) => ({
      localId,
      qualifiedName,
      description,
      argumentHint,
    })),
  ).toEqual([
    {
      localId: "plain",
      qualifiedName: "kit:plain",
      description: "Say hi to $1",
      argumentHint: null,
    },
    {
      localId: "review",
      qualifiedName: "kit:review",
      description: "Review a file",
      argumentHint: "<file> [focus]",
    },
  ]);
  const entry = publication.catalog.entries.find(
    (value) => value.contribution.localId === "review",
  );
  expect(entry).toMatchObject({ availability: "available", reason: "native-owner-bound" });
  expect(entry?.binding?.nativeRegistryOwner).toBe(PACKAGE_PROMPT_OWNER);
  expect(JSON.stringify(publication.catalog)).not.toContain("PRIVATE-BODY");

  const expanded = await publication.prompts.expand(
    '/review src/a.ts "error paths" tests',
    new AbortController().signal,
  );
  expect(expanded).toMatchObject({
    kind: "expanded",
    name: "review",
    text: "Review src/a.ts focusing on error paths tests.\nPRIVATE-BODY",
    fact: {
      version: 1,
      packageId: "kit",
      prompt: "kit:review",
      contentDigest: bytesDigest(REVIEW),
      argumentCount: 3,
      substitutions: 2,
    },
  });
  if (expanded.kind !== "expanded") throw new Error("not expanded");
  expect(JSON.stringify(expanded.fact)).not.toContain("PRIVATE-BODY");
  expect(reads).toEqual([expect.objectContaining({ packageId: "kit", path: "prompts/review.md" })]);
  const plain = await publication.prompts.expand("/kit:plain Ada", new AbortController().signal);
  expect(plain).toMatchObject({ kind: "expanded", text: "\n  Say hi to Ada\n" });
  expect(await publication.prompts.expand("review this", new AbortController().signal)).toEqual({
    kind: "not-template",
  });
  expect(
    await publication.prompts.expand("/missing x", new AbortController().signal),
  ).toMatchObject({ kind: "failed", code: "unknown-template" });
});

test("explicit manifest prompts use the same descriptor and invocation path", async () => {
  const files = { "templates/summary.md": "Summarize ${ARGUMENTS:-the diff}" };
  const pkg = await prepared("docs", files, true);
  const { publication } = await publish([{ pkg, files }]);
  expect(
    await publication.prompts.expand("/summarize", new AbortController().signal),
  ).toMatchObject({ kind: "expanded", text: "Summarize the diff" });
});

test("disabled, untrusted, unactivated or incompatible prompts do not bind", async () => {
  const files = { "prompts/review.md": REVIEW };
  const pkg = await prepared("kit", files);
  for (const override of [
    { enabled: false },
    { trust: "revoked" as const },
    { lifecycle: "changed" as const },
    { compatibility: "incompatible" as const },
  ]) {
    const { publication } = await publish([
      { pkg, files, entries: entriesFor(pkg, () => override) },
    ]);
    expect(publication.prompts.templates).toHaveLength(0);
    expect(
      await publication.prompts.expand("/review a", new AbortController().signal),
    ).toMatchObject({ kind: "failed", code: "unknown-template" });
  }
  const publisher = createNativeRegistrationPublisher([
    createNativePromptOwner({ read: async () => new Uint8Array() }),
  ]);
  const withoutActivation = publisher.publish({
    catalog: createExtensionCatalog({
      generation: 1,
      inputs: bytesDigest("inputs"),
      entries: entriesFor(pkg),
    }),
    generation: configurationGeneration.from(1),
    packages: new Map([[pkg.identityDigest, pkg]]),
    activations: new Map(),
    trust: { inspect: () => null },
    signal: new AbortController().signal,
  });
  expect(withoutActivation.prompts.templates).toHaveLength(0);
  expect(withoutActivation.catalog.entries[0]?.reason).toBe("native-activation-required");
});

test("a shared short alias requires the package-qualified name", async () => {
  const one = { "prompts/review.md": "one $1" };
  const two = { "prompts/review.md": "two $1" };
  const { publication } = await publish([
    { pkg: await prepared("alpha", one), files: one },
    { pkg: await prepared("beta", two), files: two },
  ]);
  const ambiguous = await publication.prompts.expand("/review x", new AbortController().signal);
  expect(ambiguous).toMatchObject({ kind: "failed", code: "ambiguous-template" });
  if (ambiguous.kind === "failed")
    expect(ambiguous.message).toContain("/alpha:review or /beta:review");
  expect(
    await publication.prompts.expand("/beta:review x", new AbortController().signal),
  ).toMatchObject({ kind: "expanded", text: "two x" });
});

test("revoked, changed or invalid sources fail visibly without expansion", async () => {
  const files = { "prompts/review.md": REVIEW };
  const pkg = await prepared("kit", files);
  const revoked = await publish([{ pkg, files }], () => {
    throw new ExtensionInputError("stale-native-catalog");
  });
  expect(
    await revoked.publication.prompts.expand("/review a", new AbortController().signal),
  ).toMatchObject({ kind: "failed", code: "template-unavailable", reason: "stale-native-catalog" });
  const changed = await publish([{ pkg, files }], () => new TextEncoder().encode("---\nbroken"));
  expect(
    await changed.publication.prompts.expand("/review a", new AbortController().signal),
  ).toMatchObject({ kind: "failed", code: "frontmatter-unclosed" });
  const ok = await publish([{ pkg, files }]);
  expect(
    await ok.publication.prompts.expand('/review "open', new AbortController().signal),
  ).toMatchObject({ kind: "failed", code: "unterminated-quote" });
  const cancelled = new AbortController();
  cancelled.abort();
  expect(await ok.publication.prompts.expand("/review a", cancelled.signal)).toMatchObject({
    kind: "failed",
    code: "cancelled",
  });
});

test("package preparation rejects more than 128 conventional templates", async () => {
  const files = Object.fromEntries(
    Array.from({ length: 129 }, (_, index) => ["prompts/p" + index + ".md", "x"]),
  );
  const result = await preparePackage(packageSource(pluginManifest(), files), inspectionHost);
  expect(result).toMatchObject({ ok: false, code: "prompt-template-limit" });
  delete files["prompts/p128.md"];
  expect((await preparePackage(packageSource(pluginManifest(), files), inspectionHost)).ok).toBe(
    true,
  );
});

test("declared variables bind at registration and expand, ask or fail without values in facts", async () => {
  const files = {
    "templates/summary.md":
      "Summarize ${file} to depth ${depth} with ${token}; notes: ${ARGUMENTS:-none}",
  };
  const pkg = await prepared("docs", files, true, {
    version: 1,
    entries: [
      { name: "file", type: { kind: "string" }, required: true, description: "File to read" },
      {
        name: "depth",
        type: { kind: "number", integer: true, minimum: 1, maximum: 3 },
        default: 1,
      },
      { name: "token", type: { kind: "string" }, required: true, sensitive: true },
    ],
  });
  const { publication } = await publish([{ pkg, files }]);
  expect(publication.prompts.templates[0]?.variables?.entries.map((entry) => entry.name)).toEqual([
    "file",
    "depth",
    "token",
  ]);
  const signal = new AbortController().signal;
  expect(await publication.prompts.expand("/summarize depth=2", signal)).toEqual({
    kind: "needs-input",
    name: "summarize",
    variables: [
      { name: "file", expected: "text", description: "File to read", sensitive: false },
      { name: "token", expected: "text", description: "", sensitive: true },
    ],
  });
  const expanded = await publication.prompts.expand("/summarize file=a.ts extra", signal, {
    token: "hunter2",
  });
  expect(expanded).toMatchObject({
    kind: "expanded",
    text: "Summarize a.ts to depth 1 with hunter2; notes: extra",
    fact: {
      argumentCount: 1,
      variables: [
        { name: "file", source: "argument", sensitive: false },
        { name: "depth", source: "default", sensitive: false },
        { name: "token", source: "entered", sensitive: true },
      ],
    },
  });
  if (expanded.kind !== "expanded") throw new Error("not expanded");
  expect(JSON.stringify(expanded.fact)).not.toContain("hunter2");
  const wrong = await publication.prompts.expand("/summarize file=a depth=many", signal);
  expect(wrong).toMatchObject({ kind: "failed", code: "variable-malformed" });
  if (wrong.kind === "failed") expect(wrong.message).not.toContain("many");
  expect(await publication.prompts.expand("/summarize file=a bogus=1", signal)).toMatchObject({
    kind: "failed",
    code: "variable-unknown",
  });
});

test("package preparation rejects unsupported or contradictory variable declarations", async () => {
  const files = { "templates/summary.md": "x" };
  for (const variables of [
    { version: 2, entries: [{ name: "a", type: { kind: "string" } }] },
    {
      version: 1,
      entries: [{ name: "a", type: { kind: "string" }, required: true, default: "x" }],
    },
    { version: 1, entries: [{ name: "a", type: { kind: "regex" } }] },
  ])
    await expect(prepared("docs", files, true, variables)).rejects.toThrow();
});
