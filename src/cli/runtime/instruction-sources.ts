/** Host files enter the shared source owner only through bounded, root-bound reads. */
import {
  createInstructionSourceOwner,
  InstructionSourceFailure,
} from "../../application/context/instruction-source-owner.ts";
import {
  EMPTY_SOURCE_PREFERENCES,
  INSTRUCTION_SOURCE_LIMITS,
  type InstructionSource,
  instructionSourceKey,
  sourcePreferencesSchema,
} from "../../domain/context/instruction-sources.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { isInside, joinPath, type LocalPath, parentPath } from "../../domain/workspace/index.ts";
import { configuredInstructionSourcesSchema } from "./instruction-configuration.ts";
import type { Services } from "./services.ts";

export function composeInstructionSources(
  graph: Services,
  configuration = () => graph.loader.current(),
) {
  const roots = new Map<string, LocalPath>();
  const files = new Map<string, LocalPath>();
  let authorized = new Set<string>();
  const owner = createInstructionSourceOwner({
    async scan(signal) {
      const workspace = await graph.ensureWorkspaceSet(signal);
      if (!workspace.ok) throw new Error("source-workspace-unavailable");
      const home = await graph.configurationHomeForRead(signal);
      if (home.kind !== "current" && home.kind !== "legacy" && home.kind !== "empty")
        throw new Error("source-home-unavailable");
      const captured = configuration();
      const values = captured?.values ?? {};
      const declarations = configuredInstructionSourcesSchema.parse(
        values["instructions.sources"] ?? { version: 1, entries: [] },
      );
      const preferences = sourcePreferencesSchema.parse(
        values["instructions.preferences"] ?? EMPTY_SOURCE_PREFERENCES,
      );
      const sources: InstructionSource[] = [];
      const nextAuthorized = new Set<string>();
      const nextRoots = new Map<string, LocalPath>();
      const nextFiles = new Map<string, LocalPath>();
      let totalBytes = 0;
      for (const entry of declarations.entries) {
        signal.throwIfAborted();
        const localRoot =
          entry.root === "configuration"
            ? home.root
            : workspace.value.set.roots.find((root) => root.name === entry.root)?.path;
        if (!localRoot) throw new Error("source-root-unavailable");
        const canonical = await graph.fileSystem.realPath(localRoot, signal);
        if (!canonical.ok) throw new Error("source-root-unavailable");
        const root = canonical.value;
        const path = joinPath(root, ...entry.path.split("/"));
        if (!path.ok) throw new Error("source-path-invalid");
        const identity = {
          version: 1 as const,
          kind: "instruction" as const,
          root: canonicalDigest({ root }),
          path: entry.path,
          namespace: "instructions",
          localId: entry.path.split("/").at(-1) ?? entry.path,
        };
        const key = instructionSourceKey(identity);
        nextRoots.set(identity.root, root);
        nextFiles.set(key, path.value);
        // These declarations are user/profile authored. Workspace text cannot add paths.
        if (entry.enabled) nextAuthorized.add(key);
        const trust = graph.workspaceTrust.current().status;
        const trusted = entry.root === "configuration" || trust === "accepted" || trust === "empty";
        const state = await graph.fileSystem.stat(path.value, signal);
        if (!state.ok) throw new Error("source-unreadable");
        const bytes =
          state.value === null || !entry.enabled || !trusted
            ? null
            : await read(root, path.value, signal).catch((error) => {
                throw new InstructionSourceFailure(
                  error instanceof Error && /^[a-z-]+$/.test(error.message)
                    ? error.message
                    : "source-unreadable",
                  key,
                );
              });
        totalBytes += bytes?.byteLength ?? 0;
        if (totalBytes > INSTRUCTION_SOURCE_LIMITS.cacheBytes)
          throw new Error("source-scan-byte-limit");
        const relatedIdentity = (reference: string) => {
          const parent = parentPath(path.value);
          const referenced = parent === null ? null : joinPath(parent, ...reference.split("/"));
          if (!referenced?.ok || !isInside(root, referenced.value))
            throw new Error("source-reference-escape");
          const relative = referenced.value.slice(root.length + 1);
          return instructionSourceKey({
            ...identity,
            path: relative,
            localId: relative.split("/").at(-1) ?? relative,
          });
        };
        const references = entry.references.map(relatedIdentity);
        sources.push({
          identity,
          digest: bytes === null ? null : bytesDigest(bytes),
          origin:
            entry.root === "configuration"
              ? identity.localId === "FALRYN.md"
                ? "user-falryn"
                : identity.localId === "CLAUDE.md"
                  ? "user-claude"
                  : "user-agents"
              : identity.localId === "FALRYN.md"
                ? "project-falryn"
                : identity.localId === "CLAUDE.md"
                  ? "project-claude"
                  : "project-agents",
          scope: entry.scope,
          declaration: "explicit",
          enabled: entry.enabled,
          trusted,
          compatible: true,
          available: bytes !== null,
          eligibility: { user: true, automatic: true },
          references,
          conflicts: entry.conflicts.map(relatedIdentity),
        });
      }
      roots.clear();
      files.clear();
      for (const [key, value] of nextRoots) roots.set(key, value);
      for (const [key, value] of nextFiles) files.set(key, value);
      authorized = nextAuthorized;
      return {
        configuration: String(captured?.generation ?? "0"),
        workspace: canonicalDigest(workspace.value.set),
        sources,
        preferences,
      };
    },
    async read(source, signal) {
      const root = roots.get(source.identity.root),
        path = files.get(instructionSourceKey(source.identity));
      if (!root || !path) throw new Error("source-identity-unavailable");
      return read(root, path, signal);
    },
    async controlsCurrent(preferences, signal) {
      if (signal.aborted) return false;
      const current = sourcePreferencesSchema.safeParse(
        configuration()?.values["instructions.preferences"] ?? EMPTY_SOURCE_PREFERENCES,
      );
      return (
        current.success &&
        canonicalDigest(current.data.restrictions) === canonicalDigest(preferences.restrictions)
      );
    },
    async current(source, scope, signal) {
      if (signal.aborted) return false;
      const trust = graph.workspaceTrust.current().status;
      if (source.origin.startsWith("project-") && trust !== "accepted" && trust !== "empty")
        return false;
      const key = instructionSourceKey(source.identity);
      if (!authorized.has(key)) return false;
      const root = roots.get(source.identity.root),
        path = files.get(key);
      if (!root || !path) return false;
      if (
        source.origin.startsWith("project-") &&
        (source.identity.root !== scope.root ||
          (source.scope !== "" &&
            scope.directory !== source.scope &&
            !scope.directory.startsWith(`${source.scope}/`)))
      )
        return false;
      const values = configuration()?.values ?? {};
      const declarations = configuredInstructionSourcesSchema.safeParse(
        values["instructions.sources"] ?? { version: 1, entries: [] },
      );
      if (!declarations.success) return false;
      const workspace = await graph.ensureWorkspaceSet(signal);
      if (!workspace.ok) return false;
      const declaration = declarations.data.entries.find(
        (entry) =>
          entry.path === source.identity.path &&
          entry.enabled &&
          entry.scope === source.scope &&
          (entry.root === "configuration"
            ? source.origin.startsWith("user-")
            : workspace.value.set.roots.some(
                (candidate) =>
                  candidate.name === entry.root &&
                  canonicalDigest({ root: candidate.path }) === source.identity.root,
              )),
      );
      if (!declaration) return false;
      if (declaration.root === "configuration") {
        const home = await graph.configurationHomeForRead(signal);
        if (home.kind !== "current" && home.kind !== "legacy" && home.kind !== "empty")
          return false;
        const canonicalHome = await graph.fileSystem.realPath(home.root, signal);
        if (!canonicalHome.ok || canonicalHome.value !== root) return false;
      }
      try {
        await probe(root, path, signal);
        return true;
      } catch {
        return false;
      }
    },
  });
  async function probe(root: LocalPath, path: LocalPath, signal: AbortSignal) {
    const currentRoot = await graph.fileSystem.realPath(root, signal);
    if (!currentRoot.ok || currentRoot.value !== root) throw new Error("source-root-changed");
    const relative = path.slice(root.length + 1).split("/");
    for (let index = 1; index <= relative.length; index++) {
      const parent = joinPath(root, ...relative.slice(0, index));
      if (!parent.ok) throw new Error("source-path-escape");
      const stat = await graph.fileSystem.stat(parent.value, signal);
      if (!stat.ok || !stat.value || stat.value.kind === "symlink" || stat.value.kind === "other")
        throw new Error("source-path-escape");
    }
    const before = await graph.fileSystem.stat(path, signal);
    const canonical = await graph.fileSystem.realPath(path, signal);
    if (
      !before.ok ||
      before.value?.kind !== "file" ||
      !canonical.ok ||
      canonical.value !== path ||
      !isInside(root, canonical.value)
    )
      throw new Error("source-path-escape");
    return before.value;
  }
  async function read(root: LocalPath, path: LocalPath, signal: AbortSignal): Promise<Uint8Array> {
    const before = await probe(root, path, signal);
    const bytes = await graph.fileSystem.readBytes(
      path,
      INSTRUCTION_SOURCE_LIMITS.sourceBytes,
      signal,
    );
    if (!bytes.ok)
      throw new Error(
        bytes.error.code === "oversized" ? "instruction-source-byte-limit" : "source-unreadable",
      );
    const after = await graph.fileSystem.stat(path, signal);
    if (!after.ok || after.value?.revision !== before.revision)
      throw new Error("source-content-changed");
    return bytes.value;
  }
  return owner;
}
