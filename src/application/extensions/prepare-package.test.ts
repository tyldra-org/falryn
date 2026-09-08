import { describe, expect, test } from "bun:test";
import { bytesDigest } from "../../domain/extensions/canonical.ts";
import { NATIVE_CONTRIBUTION_KINDS } from "../../domain/extensions/identity.ts";
import { PORTABLE_MCP_SCHEMA } from "../../domain/extensions/manifest.ts";
import { packageInspectionReport } from "./inspection-report.ts";
import {
  declaredAuthority,
  executableDeclaration,
  executionResources,
  inspectionHost,
  packageSource,
  pluginManifest,
} from "./package-fixtures.ts";
import { preparePackage } from "./prepare-package.ts";

describe("extension package preparation", () => {
  test("normalizes portable components and isolates invalid siblings", async () => {
    const result = await preparePackage(
      packageSource(
        pluginManifest(
          { version: 1 },
          { futureField: { inert: true }, extensions: { foreign: [1, 2] } },
        ),
        {
          "skills/good/SKILL.md":
            "---\nname: good\ndescription: Useful skill\n---\nPRIVATE-INSTRUCTION",
          "skills/bad/SKILL.md": "---\nname: Wrong\ndescription: Nope\n---\n",
          "skills/nested/more/SKILL.md": "not discovered",
          "prompts/review.md":
            "---\ndescription: Review\nargument-hint: target\n---\nPRIVATE-PROMPT",
          "prompts/nested/hidden.md": "not discovered",
          "mcp.json": JSON.stringify({
            $schema: PORTABLE_MCP_SCHEMA,
            mcpServers: {
              good: {
                type: "stdio",
                command: "node",
                args: ["PRIVATE-ARG"],
                env: { TOKEN: "PRIVATE-SECRET" },
              },
              bad: { type: "streamable-http", url: "http://remote.example" },
              remote: {
                type: "streamable-http",
                url: "https://example.test/mcp",
                headers: { Authorization: "PRIVATE-HEADER" },
              },
            },
          }),
        },
      ),
      inspectionHost,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(
      result.package.contributions.map((entry) => [
        entry.identity.nativeKind,
        entry.identity.localId,
      ]),
    ).toEqual([
      ["skill", "good"],
      ["prompt", "review"],
      ["mcp-connection", "good"],
      ["mcp-connection", "remote"],
    ]);
    expect(result.package.diagnostics.map((entry) => entry.code)).toEqual([
      "unknown-portable-field",
      "invalid-skill",
      "invalid-mcp-server",
    ]);
    expect(result.package.manifest.futureField).toEqual({ inert: true });
    expect(JSON.stringify(packageInspectionReport(result))).not.toContain("PRIVATE-");
  });
  test("keeps unknown metadata and portable versions separate from strict native metadata", async () => {
    for (const extensions of [null, [], "future"]) {
      const result = await preparePackage(
        packageSource(pluginManifest({}, { version: "draft", extensions })),
        inspectionHost,
      );
      expect(result.ok).toBe(true);
      if (result.ok) expect(result.package.identity.packageVersion).toBeNull();
    }
    expect(
      await preparePackage(packageSource(pluginManifest({ version: 2 })), inspectionHost),
    ).toEqual({ ok: false, code: "invalid-falryn-manifest" });
    expect(await preparePackage(packageSource({ name: "missing-schema" }), inspectionHost)).toEqual(
      { ok: false, code: "invalid-plugin-manifest" },
    );
    expect(
      await preparePackage(
        packageSource({}, { "plugin.json": '{"name":"a","name":"b"}' }),
        inspectionHost,
      ),
    ).toEqual({ ok: false, code: "duplicate-json-key" });
  });
  test("every native kind prepares as an inert descriptor with conservative batching", async () => {
    const script = 'throw new Error("MUST NEVER EXECUTE");';
    const contributions = NATIVE_CONTRIBUTION_KINDS.map((kind) => ({
      kind,
      namespace: "fixture",
      id: kind,
      description: kind,
      authority: declaredAuthority,
      ...(kind === "capability-module"
        ? {
            authority: { ...declaredAuthority, effects: ["observation"] },
            execution: executableDeclaration,
            module: {
              version: 1,
              moduleVersion: "1",
              operations: [
                {
                  id: "inspect",
                  family: "read",
                  inputSchema: {},
                  outputSchema: {},
                  effects: ["observation"],
                  permissions: [],
                },
              ],
              actions: ["inspect"],
              instanceSchema: {},
              statusSchema: {},
              hostServices: ["clock"],
              resources: executionResources,
              presentationSlots: [],
            },
          }
        : {}),
    }));
    const result = await preparePackage(
      packageSource(
        pluginManifest({
          version: 1,
          contributions,
          files: [{ path: "scripts/run.ts", digest: bytesDigest(script) }],
        }),
        { "scripts/run.ts": script },
      ),
      inspectionHost,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.package.contributions).toHaveLength(NATIVE_CONTRIBUTION_KINDS.length);
    expect(new Set(result.package.contributions.map((entry) => entry.identityDigest)).size).toBe(
      NATIVE_CONTRIBUTION_KINDS.length,
    );
    expect(
      result.package.contributions.every(
        (entry) =>
          entry.batching.concurrencyScope === "serial" &&
          !entry.batching.background &&
          !entry.batching.nativeBatch,
      ),
    ).toBe(true);
    expect(Object.isFrozen(result.package.contributions[0]?.identity)).toBe(true);
    expect(packageInspectionReport(result).state).toBe("declared");
  });
  test("checks executable integrity, contribution ownership, and explicit prompt metadata", async () => {
    const script = "inert bytes";
    const tool = {
      kind: "tool",
      namespace: "fixture",
      id: "run",
      description: "Run",
      authority: { ...declaredAuthority, effects: ["external"] },
      execution: executableDeclaration,
    };
    const native = {
      version: 1,
      contributions: [tool],
      files: [{ path: "scripts/run.ts", digest: bytesDigest(script) }],
    };
    const prepare = (extension: unknown) =>
      preparePackage(
        packageSource(pluginManifest(extension), {
          "scripts/run.ts": script,
          "custom.md": "---\ndescription: Custom\nargument-hint: file\n---\nprivate",
        }),
        inspectionHost,
      );
    expect((await prepare(native)).ok).toBe(true);
    expect(await prepare({ ...native, files: [] })).toEqual({
      ok: false,
      code: "unlocked-executable",
    });
    expect(
      await prepare({
        ...native,
        files: [{ path: "scripts/run.ts", digest: bytesDigest("different") }],
      }),
    ).toEqual({ ok: false, code: "file-integrity-mismatch" });
    expect(await prepare({ ...native, contributions: [tool, { ...tool }] })).toEqual({
      ok: false,
      code: "duplicate-contribution-identity",
    });
    expect(
      (await prepare({ ...native, contributions: [tool, { ...tool, kind: "command" }] })).ok,
    ).toBe(true);
    expect(
      await prepare({ ...native, contributions: [{ ...tool, dependencies: ["run"] }] }),
    ).toEqual({ ok: false, code: "contribution-dependency-cycle" });
    const prompt = await prepare({
      version: 1,
      contributions: [
        {
          kind: "prompt",
          namespace: "fixture",
          id: "custom",
          path: "custom.md",
          description: "Custom",
          authority: declaredAuthority,
        },
      ],
    });
    expect(prompt.ok && prompt.package.contributions[0]?.declaration.frontmatter).toEqual({
      description: "Custom",
      "argument-hint": "file",
    });
  });
  test("metadata and exact bytes have distinct stable digests", async () => {
    const manifest = pluginManifest();
    const a = await preparePackage(packageSource(manifest), inspectionHost);
    const b = await preparePackage(
      packageSource(manifest, { "plugin.json": JSON.stringify(manifest, null, 2) }),
      inspectionHost,
    );
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    expect(a.package.identity.manifestDigest).toBe(b.package.identity.manifestDigest);
    expect(a.package.identity.packageDigest).not.toBe(b.package.identity.packageDigest);
    expect(a.package.identityDigest).not.toBe(b.package.identityDigest);
  });
  test("resolves supplied inventory and reports host incompatibility without activation", async () => {
    const manifest = pluginManifest({
      version: 1,
      dependencies: [{ id: "shared", range: "^1.0.0" }],
      compatibility: { bun: ">=2.0.0" },
      contributions: [
        {
          kind: "agent",
          namespace: "fixture",
          id: "worker",
          description: "Worker",
          family: "delegate",
          inputSchema: {},
          outputSchema: {},
          authority: declaredAuthority,
        },
      ],
    });
    const candidate = {
      id: "shared",
      packageVersion: "1.2.0",
      digest: bytesDigest("shared"),
      dependencies: [],
    };
    const result = await preparePackage(packageSource(manifest), inspectionHost, {
      candidates: [candidate],
    });
    expect(result.ok && result.package.dependencies.ok).toBe(true);
    expect(result.ok && result.package.contributions[0]?.compatibility).toBe("incompatible");
    const unresolved = await preparePackage(packageSource(manifest), inspectionHost);
    expect(unresolved.ok && unresolved.package.dependencies.ok).toBe(false);
    const controller = new AbortController();
    controller.abort();
    expect(
      await preparePackage(packageSource(manifest), inspectionHost, { signal: controller.signal }),
    ).toEqual({ ok: false, code: "cancelled" });
  });
});
