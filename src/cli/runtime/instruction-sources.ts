/** Host files enter the shared source owner only through bounded, root-bound reads. */
import {
  createInstructionSourceOwner,
  InstructionSourceFailure,
} from "../../application/context/instruction-source-owner.ts";
import { markdownMetadata } from "../../application/extensions/portable-components.ts";
import {
  type DISCOVERY_PROBLEMS,
  EMPTY_SOURCE_PREFERENCES,
  INSTRUCTION_DISCOVERY,
  INSTRUCTION_SOURCE_LIMITS,
  type InstructionScope,
  type InstructionSource,
  instructionSourceKey,
  sourcePathSchema,
  sourcePreferencesSchema,
} from "../../domain/context/instruction-sources.ts";
import { bytesDigest, canonicalDigest } from "../../domain/extensions/canonical.ts";
import { readSkillEntrypoint } from "../../domain/extensions/skill-metadata.ts";
import { isInside, joinPath, type LocalPath, parentPath } from "../../domain/workspace/index.ts";
import { configuredInstructionSourcesSchema } from "./instruction-configuration.ts";
import { type DiscoveredInstruction, discoverInstructionFiles } from "./instruction-discovery.ts";
import type { Services } from "./services.ts";
import { type DiscoveredSkill, discoverSkillBundles, SKILL_LOCATIONS } from "./skill-discovery.ts";

/** Which user-owned directory a user-scope conventional source was found under. */
type UserHome = "configuration" | "user";

export function composeInstructionSources(
  graph: Services,
  configuration = () => graph.loader.current(),
) {
  const roots = new Map<string, LocalPath>();
  const files = new Map<string, LocalPath>();
  let authorized = new Set<string>();
  /** Discovered (conventional) sources from the last scan, and the user home of a user-wide one. */
  let discovered = new Map<string, { readonly user: UserHome | null }>();
  /**
   * Directories turns have been scoped to, per root. Discovery walks each one's ancestor
   * chain, so the discovered set stays stable as main and child turns alternate.
   */
  const tracked = new Map<string, string[]>();
  const remember = (scope: InstructionScope) => {
    const directories = tracked.get(scope.root) ?? [];
    if (scope.directory === "" || directories.includes(scope.directory)) return;
    directories.push(scope.directory);
    if (directories.length > INSTRUCTION_DISCOVERY.directories) directories.shift();
    tracked.set(scope.root, directories);
  };
  const owner = createInstructionSourceOwner({
    async scan(signal, scope) {
      remember(scope);
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
      // Conventional files need no registration. Explicit registrations of the same
      // identity take precedence in the owner.
      const nextDiscovered = new Map<string, { readonly user: UserHome | null }>();
      const trust = graph.workspaceTrust.current().status;
      /** Read one discovered entrypoint unless untrusted; failures become named problems. */
      const readDiscovered = async (
        root: LocalPath,
        path: LocalPath,
        trusted: boolean,
        problem: (typeof DISCOVERY_PROBLEMS)[number] | null,
      ) => {
        let bytes: Uint8Array | null = null;
        // Untrusted project files are listed but never read.
        if (problem === null && trusted) {
          try {
            bytes = await read(root, path, signal);
          } catch (error) {
            if (signal.aborted) throw error;
            const code = error instanceof Error ? error.message : "";
            problem =
              code === "instruction-source-byte-limit"
                ? "oversized"
                : code === "source-path-escape"
                  ? "symlink"
                  : "unreadable";
          }
          if (bytes !== null) {
            try {
              new TextDecoder("utf-8", { fatal: true }).decode(bytes);
            } catch {
              problem = "malformed-utf8";
              bytes = null;
            }
          }
        }
        totalBytes += bytes?.byteLength ?? 0;
        if (totalBytes > INSTRUCTION_SOURCE_LIMITS.cacheBytes)
          throw new Error("source-scan-byte-limit");
        return { bytes, problem };
      };
      const admit = async (root: LocalPath, found: DiscoveredInstruction, user: boolean) => {
        const path = found.directory === "" ? found.name : `${found.directory}/${found.name}`;
        // A name the source contract cannot represent is not a source.
        if (!sourcePathSchema.safeParse(path).success) return;
        const identity = {
          version: 1 as const,
          kind: "instruction" as const,
          root: canonicalDigest({ root }),
          path,
          namespace: "instructions",
          localId: found.name,
        };
        const key = instructionSourceKey(identity);
        const trusted = user || trust === "accepted" || trust === "empty";
        const { bytes, problem } = await readDiscovered(root, found.path, trusted, found.problem);
        nextRoots.set(identity.root, root);
        nextFiles.set(key, found.path);
        nextDiscovered.set(key, { user: user ? "configuration" : null });
        if (bytes !== null) nextAuthorized.add(key);
        const family =
          found.matches === "FALRYN.md"
            ? "falryn"
            : found.matches === "CLAUDE.md"
              ? "claude"
              : "agents";
        sources.push({
          identity,
          digest: bytes === null ? null : bytesDigest(bytes),
          origin: `${user ? "user" : "project"}-${family}`,
          scope: user ? "" : found.directory,
          declaration: "conventional",
          enabled: true,
          trusted,
          compatible: true,
          available: bytes !== null,
          ...(problem === null ? {} : { problem }),
          eligibility: { user: true, automatic: true },
          references: [],
          conflicts: [],
        });
      };
      const canonicalHome = await graph.fileSystem.realPath(home.root, signal);
      if (canonicalHome.ok)
        for (const found of await discoverInstructionFiles(
          graph.fileSystem,
          canonicalHome.value,
          [""],
          INSTRUCTION_DISCOVERY.userFiles,
          signal,
        ))
          await admit(canonicalHome.value, found, true);
      for (const workspaceRoot of workspace.value.set.roots) {
        const canonical = await graph.fileSystem.realPath(workspaceRoot.path, signal);
        // A root that no longer exists contributes nothing.
        if (!canonical.ok) continue;
        for (const found of await discoverInstructionFiles(
          graph.fileSystem,
          canonical.value,
          tracked.get(canonicalDigest({ root: canonical.value })) ?? [],
          INSTRUCTION_DISCOVERY.projectFiles,
          signal,
        ))
          await admit(canonical.value, found, false);
      }
      /**
       * Skill bundles (#136): each authorized root's three locations, then the user's. The
       * entrypoint's frontmatter supplies the description and invocation eligibility; its
       * body is read in full here only to bind the digest, and enters a request only when
       * selected.
       */
      const admitSkill = async (
        root: LocalPath,
        found: DiscoveredSkill,
        origin: InstructionSource["origin"],
        user: UserHome | null,
      ) => {
        const identity = {
          version: 1 as const,
          kind: "skill" as const,
          root: canonicalDigest({ root }),
          path: found.relative,
          namespace: "skills",
          localId: found.bundle,
        };
        const key = instructionSourceKey(identity);
        // The home directory can itself be a workspace root; its project copy already counts.
        if (nextFiles.has(key)) return;
        const trusted = user !== null || trust === "accepted" || trust === "empty";
        const loaded = await readDiscovered(root, found.path, trusted, found.problem);
        let problem = loaded.problem;
        let entry: ReturnType<typeof readSkillEntrypoint> | null = null;
        if (loaded.bytes !== null) {
          try {
            entry = readSkillEntrypoint(markdownMetadata(loaded.bytes, true), found.bundle);
          } catch {
            entry = { ok: false, problem: "malformed-metadata" };
          }
          if (!entry.ok) problem = entry.problem;
          else if (entry.unsupported !== null) problem = "unsupported-control";
        }
        const admitted = loaded.bytes !== null && entry?.ok === true;
        nextRoots.set(identity.root, root);
        nextFiles.set(key, found.path);
        nextDiscovered.set(key, { user });
        if (admitted) nextAuthorized.add(key);
        sources.push({
          identity,
          digest: loaded.bytes === null ? null : bytesDigest(loaded.bytes),
          origin,
          scope: "",
          declaration: "conventional",
          enabled: true,
          trusted,
          compatible: entry?.ok !== true || entry.unsupported === null,
          available: admitted,
          ...(problem === null ? {} : { problem }),
          eligibility: entry?.ok === true ? entry.invocation : null,
          ...(entry?.ok === true ? { summary: entry.description } : {}),
          references: [],
          conflicts: [],
        });
      };
      for (const workspaceRoot of workspace.value.set.roots) {
        const canonical = await graph.fileSystem.realPath(workspaceRoot.path, signal);
        if (!canonical.ok) continue;
        for (const [location, family] of SKILL_LOCATIONS.project)
          for (const found of await discoverSkillBundles(
            graph.fileSystem,
            canonical.value,
            location,
            signal,
          ))
            await admitSkill(canonical.value, found, `project-${family}`, null);
      }
      const canonicalUser = await graph.fileSystem.realPath(graph.userHome, signal);
      for (const [root, location, origin, user] of [
        [canonicalHome.ok ? canonicalHome.value : null, "skills", "user-falryn", "configuration"],
        [canonicalUser.ok ? canonicalUser.value : null, ".agents/skills", "user-agents", "user"],
        [canonicalUser.ok ? canonicalUser.value : null, ".claude/skills", "user-claude", "user"],
      ] as const) {
        if (root === null) continue;
        for (const found of await discoverSkillBundles(graph.fileSystem, root, location, signal))
          await admitSkill(root, found, origin, user);
      }
      roots.clear();
      files.clear();
      for (const [key, value] of nextRoots) roots.set(key, value);
      for (const [key, value] of nextFiles) files.set(key, value);
      authorized = nextAuthorized;
      discovered = nextDiscovered;
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
      if (source.declaration === "conventional") {
        const found = discovered.get(key);
        if (!found) return false;
        if (found.user !== null) {
          let userRoot: LocalPath = graph.userHome;
          if (found.user === "configuration") {
            const home = await graph.configurationHomeForRead(signal);
            if (home.kind !== "current" && home.kind !== "legacy" && home.kind !== "empty")
              return false;
            userRoot = home.root;
          }
          const canonicalHome = await graph.fileSystem.realPath(userRoot, signal);
          if (!canonicalHome.ok || canonicalHome.value !== root) return false;
        } else {
          const workspace = await graph.ensureWorkspaceSet(signal);
          if (
            !workspace.ok ||
            !workspace.value.set.roots.some(
              (candidate) => canonicalDigest({ root: candidate.path }) === source.identity.root,
            )
          )
            return false;
        }
        // The exact name must still be a regular file in its directory.
        const parent = parentPath(path);
        const listed = parent === null ? null : await graph.fileSystem.list(parent, signal);
        if (
          !listed?.ok ||
          !listed.value.some((entry) => entry.path === path && entry.kind === "file")
        )
          return false;
        try {
          await probe(root, path, signal);
          return true;
        } catch {
          return false;
        }
      }
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
    if (before.byteLength > INSTRUCTION_SOURCE_LIMITS.sourceBytes)
      throw new Error("instruction-source-byte-limit");
    // A size check alone cannot bound a file that grows while it is being read.
    const bytes = await graph.fileSystem.readBytesRange(
      path,
      0,
      INSTRUCTION_SOURCE_LIMITS.sourceBytes + 1,
      signal,
      { expectedRevision: before.revision },
    );
    if (!bytes.ok)
      throw new Error(
        bytes.error.code === "oversized"
          ? "instruction-source-byte-limit"
          : bytes.error.code === "stale-read"
            ? "source-content-changed"
            : "source-unreadable",
      );
    if (bytes.value.byteLength > INSTRUCTION_SOURCE_LIMITS.sourceBytes)
      throw new Error("instruction-source-byte-limit");
    const after = await probe(root, path, signal);
    if (after.revision !== before.revision || bytes.value.byteLength !== before.byteLength)
      throw new Error("source-content-changed");
    return bytes.value;
  }
  return owner;
}
