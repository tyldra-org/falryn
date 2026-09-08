import { satisfies } from "semver";
import {
  bytesDigest,
  canonicalDigest,
  ExtensionInputError,
  freezeMetadata,
  packageRelativePath,
  parseMetadata,
} from "../../domain/extensions/canonical.ts";
import {
  type DependencyCandidate,
  type DependencyResolution,
  resolvePackageDependencies,
} from "../../domain/extensions/dependencies.ts";
import {
  type ContributionIdentityV1,
  contributionIdentityV1Schema,
  decodeIdentity,
  exactVersionSchema,
  type PackageIdentityV1,
  packageIdentityV1Schema,
} from "../../domain/extensions/identity.ts";
import {
  type ContributionDeclaration,
  contributionDeclarationSchema,
  FALRYN_EXTENSION_NAMESPACE,
  type FalrynManifest,
  falrynManifestSchema,
  type PortableManifest,
  portableManifestSchema,
} from "../../domain/extensions/manifest.ts";
import type {
  InspectionDiagnostic,
  PackageSource,
} from "../../domain/extensions/package-source.ts";
import { markdownMetadata, portableComponents } from "./portable-components.ts";

export type PreparedContribution = {
  readonly identity: ContributionIdentityV1;
  readonly identityDigest: string;
  readonly path: string | null;
  readonly declaration: Readonly<Record<string, unknown>>;
  readonly mode: "declarative" | "governed" | "full-user";
  readonly compatibility: "compatible" | "incompatible";
  readonly authority: ContributionDeclaration["authority"];
  readonly family: ContributionDeclaration["family"] | null;
  readonly batching: {
    readonly version: 1;
    readonly nativeBatch: boolean;
    readonly concurrencyScope: string;
    readonly background: boolean;
  };
};
export type PreparedPackage = {
  readonly compatibility: "compatible" | "incompatible";
  readonly identity: PackageIdentityV1;
  readonly identityDigest: string;
  readonly manifest: PortableManifest;
  readonly falryn: FalrynManifest;
  readonly files: readonly { readonly path: string; readonly digest: string }[];
  readonly contributions: readonly PreparedContribution[];
  readonly dependencies: DependencyResolution;
  readonly diagnostics: readonly InspectionDiagnostic[];
  readonly omittedDiagnostics: number;
};
export type PackagePreparation =
  | { readonly ok: true; readonly package: PreparedPackage }
  | { readonly ok: false; readonly code: string };
export type InspectionHost = {
  readonly falryn: string;
  readonly bun: string;
  readonly os: string;
  readonly arch: string;
};

/** Prepare descriptors only. No activation, registry publication, or process port is accepted. */
export async function preparePackage(
  source: PackageSource,
  host: InspectionHost,
  options: {
    readonly candidates?: readonly DependencyCandidate[];
    readonly locked?: readonly { readonly id: string; readonly digest: string }[];
    readonly signal?: AbortSignal;
  } = {},
): Promise<PackagePreparation> {
  try {
    const snapshot = await source.read(options.signal);
    if (options.signal?.aborted) throw new ExtensionInputError("cancelled");
    if (snapshot.files.length > 4_096) throw new ExtensionInputError("package-entry-limit");
    const files = new Map<string, Uint8Array>();
    let total = 0;
    for (const file of snapshot.files) {
      const path = packageRelativePath(file.path);
      if (path === null || files.has(path))
        throw new ExtensionInputError("invalid-package-inventory");
      total += file.bytes.length;
      if (file.bytes.length > 16_777_216 || total > 67_108_864)
        throw new ExtensionInputError("package-byte-limit");
      files.set(path, file.bytes);
    }
    const diagnostics = snapshot.diagnostics.slice(0, 128);
    let omittedDiagnostics =
      snapshot.omittedDiagnostics + Math.max(0, snapshot.diagnostics.length - 128);
    const diagnose = (diagnostic: InspectionDiagnostic) => {
      if (diagnostics.length < 128) diagnostics.push(diagnostic);
      else omittedDiagnostics++;
    };
    const plugin = files.get("plugin.json");
    if (plugin === undefined) throw new ExtensionInputError("missing-plugin-manifest");
    const checked = portableManifestSchema.safeParse(
      parseMetadata(new TextDecoder("utf-8", { fatal: true }).decode(plugin)),
    );
    if (!checked.success) throw new ExtensionInputError("invalid-plugin-manifest");
    const manifest = checked.data;
    const known = new Set([
      "$schema",
      "name",
      "version",
      "description",
      "author",
      "homepage",
      "repository",
      "license",
      "keywords",
      "extensions",
    ]);
    for (const key of Object.keys(manifest))
      if (!known.has(key)) diagnose({ code: "unknown-portable-field", path: "plugin.json" });
    const extensions = manifest.extensions;
    let extension: unknown = { version: 1 };
    if (extensions !== undefined) {
      if (extensions === null || typeof extensions !== "object" || Array.isArray(extensions))
        diagnose({ code: "invalid-extensions-container", path: "plugin.json" });
      else if (Object.hasOwn(extensions, FALRYN_EXTENSION_NAMESPACE))
        extension = (extensions as Record<string, unknown>)[FALRYN_EXTENSION_NAMESPACE];
    }
    const native = falrynManifestSchema.safeParse(extension);
    if (!native.success) throw new ExtensionInputError("invalid-falryn-manifest");
    const falryn = native.data;
    const normalizedManifest = {
      ...manifest,
      extensions: {
        ...(extensions !== null && typeof extensions === "object" && !Array.isArray(extensions)
          ? extensions
          : {}),
        [FALRYN_EXTENSION_NAMESPACE]: falryn,
      },
    };
    const inventory = [...files]
      .map(([path, bytes]) => ({ path, digest: bytesDigest(bytes) }))
      .sort((a, b) => (a.path < b.path ? -1 : 1));
    const inventoryMap = new Map(inventory.map((file) => [file.path, file.digest]));
    const packageDigest = canonicalDigest({ version: 1, files: inventory });
    const lockedFiles = new Map<string, string>();
    for (const file of falryn.files) {
      if (lockedFiles.has(file.path) || file.path === "plugin.json")
        throw new ExtensionInputError("invalid-file-lock");
      if (inventoryMap.get(file.path) !== file.digest)
        throw new ExtensionInputError("file-integrity-mismatch");
      lockedFiles.set(file.path, file.digest);
    }
    const version = exactVersionSchema.safeParse(manifest.version);
    if (manifest.version !== undefined && !version.success)
      diagnose({ code: "non-semver-portable-version", path: "plugin.json" });
    const decoded = decodeIdentity(packageIdentityV1Schema, {
      version: 1,
      packageId: falryn.packageId ?? manifest.name,
      packageVersion: version.success ? version.data : null,
      sourceCoordinate: {
        kind: "local",
        rootId: snapshot.sourceId,
        path: "plugin.json",
        sourceDigest: packageDigest,
      },
      packageDigest,
      manifestDigest: canonicalDigest(normalizedManifest),
    });
    if (!decoded.ok) throw new ExtensionInputError("invalid-package-identity");
    const contributions: PreparedContribution[] = [];
    const claimed = new Set<string>();
    const add = (
      kind: ContributionIdentityV1["nativeKind"],
      namespace: string,
      id: string,
      path: string | null,
      declaration: Record<string, unknown>,
      nativeDeclaration?: ContributionDeclaration,
    ) => {
      if (contributions.length >= 1_024) throw new ExtensionInputError("contribution-limit");
      const key = JSON.stringify([kind, namespace, id]);
      if (claimed.has(key)) throw new ExtensionInputError("duplicate-contribution-identity");
      claimed.add(key);
      for (const alias of nativeDeclaration?.aliases ?? []) {
        const aliasKey = JSON.stringify([kind, namespace, alias]);
        if (claimed.has(aliasKey)) throw new ExtensionInputError("duplicate-contribution-alias");
        claimed.add(aliasKey);
      }
      const identity = decodeIdentity(contributionIdentityV1Schema, {
        version: 1,
        owner: { kind: "package", digest: decoded.digest },
        nativeKind: kind,
        namespace,
        localId: id,
        descriptorDigest: canonicalDigest(declaration),
      });
      if (!identity.ok) throw new ExtensionInputError("invalid-contribution-identity");
      const mode =
        nativeDeclaration?.execution?.mode ??
        (kind === "mcp-connection" && nativeDeclaration === undefined
          ? "full-user"
          : "declarative");
      const compatible =
        compatibleWith(falryn.compatibility, host) &&
        compatibleWith(nativeDeclaration?.compatibility, host) &&
        compatibleWith(nativeDeclaration?.execution?.compatibility, host);
      contributions.push({
        authority: nativeDeclaration?.authority ?? {
          effects: kind === "mcp-connection" ? ["external"] : [],
          permissions: [],
          roots: [],
          destinations: [],
          secretReferences: [],
          localData: [],
        },
        family: nativeDeclaration?.family ?? null,
        identity: identity.value,
        identityDigest: identity.digest,
        path,
        declaration,
        mode,
        compatibility: compatible ? "compatible" : "incompatible",
        batching: nativeDeclaration?.batching ?? {
          version: 1,
          nativeBatch: false,
          concurrencyScope: "serial",
          background: false,
        },
      });
    };
    validateDeclarations(falryn, inventoryMap, lockedFiles);
    for (const declaration of falryn.contributions) {
      let metadata: Record<string, unknown> = declaration;
      if (declaration.kind === "prompt" && declaration.path !== undefined) {
        const bytes = files.get(declaration.path);
        if (bytes === undefined) throw new ExtensionInputError("missing-contribution-file");
        metadata = { ...declaration, frontmatter: markdownMetadata(bytes, false) };
      }
      add(
        declaration.kind,
        declaration.namespace,
        declaration.id,
        declaration.path ?? null,
        metadata,
        declaration,
      );
    }
    const explicitPaths = new Set(falryn.contributions.map((entry) => entry.path));
    for (const component of portableComponents(files, diagnose)) {
      if (explicitPaths.has(component.path) && component.kind === "prompt") continue;
      if (component.kind === "prompt") {
        const declaration = contributionDeclarationSchema.parse({
          kind: "prompt",
          namespace: manifest.name,
          id: component.id,
          path: component.path,
          description: component.metadata.description ?? "",
          authority: {
            effects: [],
            permissions: [],
            roots: [],
            destinations: [],
            secretReferences: [],
            localData: [],
          },
        });
        add(
          "prompt",
          declaration.namespace,
          declaration.id,
          component.path,
          { ...declaration, frontmatter: component.metadata },
          declaration,
        );
        continue;
      }
      add(component.kind, manifest.name, component.id, component.path, {
        kind: component.kind,
        path: component.path,
        metadata: component.metadata,
      });
    }
    const dependencies = resolvePackageDependencies({
      requirements: falryn.dependencies,
      candidates: options.candidates ?? [],
      ...(options.locked === undefined ? {} : { locked: options.locked }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
    if (options.signal?.aborted) throw new ExtensionInputError("cancelled");
    return {
      ok: true,
      package: freezeMetadata({
        compatibility: compatibleWith(falryn.compatibility, host) ? "compatible" : "incompatible",
        identity: decoded.value,
        identityDigest: decoded.digest,
        manifest,
        falryn,
        files: inventory,
        contributions,
        dependencies,
        diagnostics,
        omittedDiagnostics,
      }),
    };
  } catch (error) {
    return {
      ok: false,
      code: error instanceof ExtensionInputError ? error.code : "invalid-package-input",
    };
  }
}

function compatibleWith(value: FalrynManifest["compatibility"], host: InspectionHost): boolean {
  return (
    value === undefined ||
    ((value.falryn === undefined || satisfies(host.falryn, value.falryn)) &&
      (value.bun === undefined || satisfies(host.bun, value.bun)) &&
      (value.os.length === 0 || value.os.some((os) => os === host.os)) &&
      (value.arch.length === 0 || value.arch.some((arch) => arch === host.arch)))
  );
}

function validateDeclarations(
  manifest: FalrynManifest,
  files: ReadonlyMap<string, string>,
  locks: ReadonlyMap<string, string>,
): void {
  const declarations = new Map<string, ContributionDeclaration>();
  const configuration = new Set(manifest.configuration.map((entry) => entry.id));
  const state = new Set(manifest.state.map((entry) => entry.id));
  if (configuration.size !== manifest.configuration.length || state.size !== manifest.state.length)
    throw new ExtensionInputError("duplicate-state-family");
  for (const entry of manifest.contributions) {
    const key = `${entry.kind}/${entry.namespace}/${entry.id}`;
    if (declarations.has(key)) throw new ExtensionInputError("duplicate-contribution-identity");
    declarations.set(key, entry);
    for (const path of [...entry.resources, ...(entry.path === undefined ? [] : [entry.path])])
      if (!files.has(path)) throw new ExtensionInputError("missing-contribution-file");
    if (
      entry.configuration.some((id) => !configuration.has(id)) ||
      entry.state.some((id) => !state.has(id))
    )
      throw new ExtensionInputError("unknown-state-family");
    if (entry.execution !== undefined) {
      if (!locks.has(entry.execution.executable))
        throw new ExtensionInputError("unlocked-executable");
      for (const helper of entry.execution.helpers)
        if (files.get(helper.path) !== helper.digest || locks.get(helper.path) !== helper.digest)
          throw new ExtensionInputError("unlocked-helper");
    }
  }
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const heights = new Map<string, number>();
  const visit = (key: string, depth: number): void => {
    if (visiting.has(key)) throw new ExtensionInputError("contribution-dependency-cycle");
    if (depth > 32) throw new ExtensionInputError("contribution-dependency-depth");
    if (visited.has(key)) return;
    const entry = declarations.get(key);
    if (entry === undefined) throw new ExtensionInputError("missing-contribution-dependency");
    visiting.add(key);
    const dependencies = entry.dependencies.map((id) =>
      id.split("/").length === 3
        ? id
        : `${entry.kind}/${id.includes("/") ? id : `${entry.namespace}/${id}`}`,
    );
    for (const dependency of dependencies) visit(dependency, depth + 1);
    const height = Math.max(
      0,
      ...dependencies.map((dependency) => 1 + (heights.get(dependency) ?? 0)),
    );
    if (height > 32) throw new ExtensionInputError("contribution-dependency-depth");
    heights.set(key, height);
    visiting.delete(key);
    visited.add(key);
  };
  for (const key of declarations.keys()) visit(key, 0);
}
