import type { InstructionSourceReceipt } from "../../domain/context/instruction-source-receipt.ts";

export type { InstructionSourceReceipt } from "../../domain/context/instruction-source-receipt.ts";

/** One publication owner for source metadata, choices and admitted instruction bytes. */
import {
  EMPTY_SOURCE_PREFERENCES,
  type InstructionScope,
  type InstructionSource,
  instructionScopeSchema,
  instructionSourceKey,
  instructionSourceSchema,
  INSTRUCTION_SOURCE_LIMITS as LIMITS,
  resolveInstructionSources,
  type SourceDecision,
  type SourcePreferences,
  sourcePreferencesSchema,
} from "../../domain/context/instruction-sources.ts";
import type { PromptSectionInput } from "../../domain/context/prompt-composition.ts";
import { bytesDigest, canonicalDigest, freezeMetadata } from "../../domain/extensions/canonical.ts";

export type InstructionSourceSnapshot = {
  readonly configuration: string;
  readonly workspace: string;
  readonly sources: readonly InstructionSource[];
  readonly preferences: SourcePreferences;
};
export type InstructionSourcePort = {
  scan(signal: AbortSignal): Promise<InstructionSourceSnapshot>;
  read(source: InstructionSource, signal: AbortSignal): Promise<Uint8Array>;
  controlsCurrent?(preferences: SourcePreferences, signal: AbortSignal): Promise<boolean>;
  /** Current scope/trust/enablement authority, independent of cached content. */
  current(
    source: InstructionSource,
    scope: InstructionScope,
    signal: AbortSignal,
  ): Promise<boolean>;
};
export type InstructionBinding = {
  readonly sections: readonly PromptSectionInput[];
  readonly receipt: InstructionSourceReceipt;
  /** Exact bytes stay bound; new effects still require current source authority. */
  current(signal: AbortSignal): Promise<boolean>;
};
export type InstructionPreparation =
  | { readonly ok: true; readonly binding: InstructionBinding }
  | {
      readonly ok: false;
      readonly code: string;
      readonly sources: readonly SourceDecision[];
      readonly observedGeneration?: string | null;
      readonly rejectedSource?: string | null;
    };
export type InstructionSelection = NonNullable<
  Parameters<typeof resolveInstructionSources>[0]["selections"]
>;
export type InstructionSourceOwner = ReturnType<typeof createInstructionSourceOwner>;

export function createInstructionSourceOwner(port: InstructionSourcePort) {
  let published:
    | (InstructionSourceSnapshot & {
        readonly generation: string;
        readonly persistedPreferences: SourcePreferences;
      })
    | null = null;
  let session: SourcePreferences | null = null;
  let serial: Promise<void> = Promise.resolve();
  const cache = new Map<string, { readonly text: string; readonly bytes: number }>();
  let cacheBytes = 0;
  const admissions = new Set<string>();
  const contents = new Map<string, string>();
  let controlRevision = 0;
  let pendingCount = 0;
  let pendingReload: InstructionSourceReceipt | null = null;

  function cacheText(key: string, text: string, bytes: number) {
    const previous = cache.get(key);
    if (previous) cacheBytes -= previous.bytes;
    cache.delete(key);
    while (cacheBytes + bytes > LIMITS.cacheBytes && cache.size > 0) {
      const oldest = cache.entries().next().value;
      if (!oldest) break;
      cache.delete(oldest[0]);
      cacheBytes -= oldest[1].bytes;
    }
    cache.set(key, { text, bytes });
    cacheBytes += bytes;
  }

  async function prepare(
    scope: InstructionScope,
    selections: InstructionSelection,
    signal: AbortSignal,
    retained: { code: string; source: string | null; observed: string | null } | null = null,
    capturedControls = controlRevision,
    expectedConfiguration?: string,
    observe = false,
  ): Promise<InstructionPreparation> {
    const stop = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.deadlineMs)]);
    let reload: InstructionSourceReceipt["reload"] = "unchanged";
    let observedGeneration: string | null = retained?.observed ?? null;
    let rejection: string | null = retained?.code ?? null;
    let rejectedSource: string | null = retained?.source ?? null;
    let readingSource: string | null = null;
    let candidate = published;
    let decisions: readonly SourceDecision[] = [];
    try {
      stop.throwIfAborted();
      scope = instructionScopeSchema.parse(scope);
      if (capturedControls !== controlRevision) throw new Error("source-controls-changed");
      try {
        if (retained) throw new Error("retained-generation");
        const scanned = await port.scan(stop);
        if (expectedConfiguration !== undefined && scanned.configuration !== expectedConfiguration)
          throw new Error("source-configuration-changed");
        if (Buffer.byteLength(JSON.stringify(scanned)) > LIMITS.cacheBytes)
          throw new Error("source-metadata-limit");
        const declarations = scanned.sources.map((source) => instructionSourceSchema.parse(source));
        const unique = new Map<string, InstructionSource>();
        const declarationsSeen = new Set<string>();
        for (const source of declarations) {
          const key = instructionSourceKey(source.identity);
          const prior = unique.get(key);
          const declarationKey = `${key}:${source.declaration}`;
          if (declarationsSeen.has(declarationKey)) throw new Error("duplicate-source-identity");
          declarationsSeen.add(declarationKey);
          if (!prior || source.declaration === "explicit") unique.set(key, source);
        }
        const sources = [...unique.values()];
        sources.sort((a, b) => {
          const left = instructionSourceKey(a.identity),
            right = instructionSourceKey(b.identity);
          return left < right ? -1 : left > right ? 1 : 0;
        });
        const preferences = sourcePreferencesSchema.parse(session ?? scanned.preferences);
        const data = {
          ...scanned,
          sources,
          preferences,
          persistedPreferences: sourcePreferencesSchema.parse(scanned.preferences),
        };
        if (Buffer.byteLength(JSON.stringify(data)) > LIMITS.cacheBytes)
          throw new Error("source-metadata-limit");
        const generation = canonicalDigest(data);
        observedGeneration = generation;
        candidate = freezeMetadata({ ...data, generation });
        reload = generation === published?.generation ? "unchanged" : "committed";
      } catch (error) {
        if (
          stop.aborted ||
          !published ||
          (error instanceof Error && error.message === "source-configuration-changed")
        )
          throw error;
        candidate = published;
        rejection =
          retained?.code ??
          (error instanceof Error && /^[a-z-]+$/.test(error.message)
            ? error.message
            : "source-invalid");
        if (error instanceof InstructionSourceFailure) rejectedSource = error.source;
        reload = "rejected";
      }
      if (!candidate) throw new Error("sources-unavailable");
      const persistedControls = candidate.persistedPreferences;
      const restrictions = canonicalDigest(candidate.preferences.restrictions);
      const controlsCurrent = async (checkSignal: AbortSignal) =>
        controlRevision === capturedControls &&
        (!port.controlsCurrent || (await port.controlsCurrent(persistedControls, checkSignal)));
      const resolution = resolveInstructionSources({
        sources: candidate.sources,
        scope,
        preferences: candidate.preferences,
        selections,
      });
      decisions = resolution.decisions;
      if (
        !retained &&
        published &&
        candidate.generation !== published.generation &&
        resolution.unavailable.some((code) => code.startsWith("instruction-conflict:"))
      )
        return prepare(
          scope,
          selections,
          signal,
          {
            code: "instruction-conflict",
            source:
              resolution.decisions.find((item) => item.state === "conflicting")?.source ?? null,
            observed: observedGeneration,
          },
          capturedControls,
          expectedConfiguration,
          observe,
        );
      if (resolution.unavailable.length)
        return {
          ok: false,
          code: resolution.unavailable[0] ?? "source-unavailable",
          observedGeneration,
          rejectedSource:
            resolution.decisions.find((item) => item.state === "conflicting")?.source ?? null,
          sources: sourceDecisionPage(decisions),
        };
      const sections: PromptSectionInput[] = [];
      const bound = new Map<string, InstructionSource>();
      const visiting = new Set<string>();
      let bytes = 0;
      const visit = async (source: InstructionSource): Promise<void> => {
        stop.throwIfAborted();
        const identity = instructionSourceKey(source.identity);
        if (visiting.has(identity)) throw new Error("instruction-reference-cycle");
        if (bound.has(identity)) return;
        if (source.digest === null) throw new Error("source-content-unavailable");
        if (visiting.size >= LIMITS.references) throw new Error("instruction-reference-limit");
        if (!(await controlsCurrent(stop)) || !(await port.current(source, scope, stop)))
          throw new Error("source-authority-changed");
        visiting.add(identity);
        readingSource = identity;
        const key = canonicalDigest([identity, source.digest, candidate?.configuration]);
        let product = cache.get(key);
        if (!product) {
          if (reload === "rejected") throw new Error("last-good-content-unavailable");
          const read = await port.read(source, stop);
          if (read.byteLength > LIMITS.sourceBytes)
            throw new Error("instruction-source-byte-limit");
          if (bytesDigest(read) !== source.digest) throw new Error("source-content-changed");
          let text: string;
          try {
            text = new TextDecoder("utf-8", { fatal: true }).decode(read);
          } catch {
            throw new InstructionSourceFailure("source-invalid", identity);
          }
          product = { text, bytes: read.byteLength };
          cacheText(key, text, read.byteLength);
        }
        bytes += product.bytes;
        if (bytes > LIMITS.admittedBytes) throw new Error("instruction-aggregate-byte-limit");
        for (const reference of source.references) {
          const dependency = candidate?.sources.find(
            (entry) => instructionSourceKey(entry.identity) === reference,
          );
          if (!dependency) throw new Error("instruction-reference-missing");
          // A reference cannot promote another origin or escape the declaring source's root.
          if (
            dependency.identity.root !== source.identity.root ||
            dependency.origin.startsWith("project-") !== source.origin.startsWith("project-") ||
            (dependency.identity.kind !== "instruction" &&
              !resolution.selected.includes(dependency)) ||
            !dependency.enabled ||
            !dependency.trusted ||
            !dependency.available ||
            !dependency.compatible
          )
            throw new Error("instruction-reference-denied");
          await visit(dependency);
        }
        bound.set(identity, source);
        visiting.delete(identity);
        sections.push({
          id: `instruction-${String(sections.length).padStart(4, "0")}-${identity.slice(7)}`,
          role:
            source.identity.kind === "skill"
              ? "skill-workflow"
              : source.origin.startsWith("project-")
                ? "project-instruction"
                : "user-instruction",
          source: `${identity}@${source.digest}`,
          content: product.text,
          required: true,
          available: true,
        });
      };
      for (const source of resolution.selected) await visit(source);
      stop.throwIfAborted();
      if (controlRevision !== capturedControls) throw new Error("source-controls-changed");
      let previousGeneration = published?.generation ?? null;
      if (
        !observe &&
        pendingReload?.generation === candidate.generation &&
        reload === "unchanged"
      ) {
        previousGeneration = pendingReload.previousGeneration;
        reload = pendingReload.reload;
        observedGeneration = pendingReload.observedGeneration;
        rejection = pendingReload.rejection;
        rejectedSource = pendingReload.rejectedSource ?? null;
      }
      published = candidate;
      const contentDigest = bytesDigest(
        new TextEncoder().encode(
          JSON.stringify(sections.map(({ id, role, content }) => ({ id, role, content }))),
        ),
      );
      const admission = canonicalDigest([
        candidate.generation,
        { root: scope.root, directory: scope.directory, kind: scope.kind },
        [...bound.keys()],
        contentDigest,
      ]);
      const reused = admissions.has(admission);
      if (!observe) {
        if (admissions.size >= 1_024) admissions.clear();
        admissions.add(admission);
      }
      const cards = sourceDecisionPage(decisions);
      const contentKey = canonicalDigest({
        root: scope.root,
        directory: scope.directory,
        kind: scope.kind,
      });
      const contentChanged = contents.get(contentKey) !== contentDigest;
      if (!observe) {
        if (contents.size >= 1024) contents.clear();
        contents.set(contentKey, contentDigest);
      }
      const receipt = freezeMetadata({
        generation: candidate.generation,
        previousGeneration,
        configuration: candidate.configuration,
        workspace: candidate.workspace,
        scope,
        contentDigest,
        sources: cards,
        omitted: decisions.length - cards.length,
        reload,
        observedGeneration,
        rejection,
        rejectedSource,
        contentChanged,
        reused,
      });
      if (observe) {
        if (reload !== "unchanged") pendingReload = receipt;
      } else pendingReload = null;
      return {
        ok: true,
        binding: {
          sections: freezeMetadata(sections),
          receipt,
          async current(checkSignal) {
            try {
              if (
                checkSignal.aborted ||
                canonicalDigest(
                  (session ?? published?.preferences ?? persistedControls).restrictions,
                ) !== restrictions ||
                (port.controlsCurrent &&
                  !(await port.controlsCurrent(persistedControls, checkSignal)))
              )
                return false;
              for (const source of bound.values())
                if (!(await port.current(source, scope, checkSignal))) return false;
              return true;
            } catch {
              return false;
            }
          },
        },
      };
    } catch (error) {
      // A complete prior publication may survive malformed replacement content.
      // Authority and explicit selection failures never substitute another source.
      if (
        !retained &&
        published &&
        !stop.aborted &&
        error instanceof Error &&
        [
          "source-content-changed",
          "source-invalid",
          "instruction-reference-cycle",
          "instruction-reference-missing",
          "instruction-source-byte-limit",
          "instruction-aggregate-byte-limit",
        ].includes(error.message)
      )
        return prepare(
          scope,
          selections,
          signal,
          { code: error.message, source: readingSource, observed: observedGeneration },
          capturedControls,
          expectedConfiguration,
          observe,
        );
      return {
        ok: false,
        code: signal.aborted
          ? "cancelled"
          : stop.aborted
            ? "source-timeout"
            : error instanceof Error && /^[a-z-]+$/.test(error.message)
              ? error.message
              : "source-invalid",
        sources: sourceDecisionPage(decisions),
        observedGeneration,
        rejectedSource: error instanceof InstructionSourceFailure ? error.source : readingSource,
      };
    }
  }
  return {
    /** Session selection is volatile. Persisted choices use the configuration writer. */
    select(preferences: unknown) {
      session = freezeMetadata(sourcePreferencesSchema.parse(preferences));
      controlRevision++;
    },
    reset() {
      session = null;
      controlRevision++;
    },
    snapshot() {
      return published;
    },
    /** Inspect the publication without reading bodies or asserting current authority. */
    inspect(scope: InstructionScope, selections: InstructionSelection = [], offset = 0) {
      if (!Number.isSafeInteger(offset) || offset < 0) throw new Error("invalid-source-cursor");
      if (!published) return null;
      const resolved = resolveInstructionSources({
        sources: published.sources,
        preferences: session ?? published.preferences,
        scope,
        selections,
      });
      const cards = sourceDecisionPage(resolved.decisions.slice(offset));
      const next = offset + cards.length;
      return freezeMetadata({
        generation: published.generation,
        authority: "not-revalidated" as const,
        sources: cards,
        total: resolved.decisions.length,
        nextOffset: next < resolved.decisions.length ? next : null,
      });
    },
    prepare(
      scope: InstructionScope,
      selections: InstructionSelection = [],
      signal = new AbortController().signal,
      expectedConfiguration?: string,
      observe = false,
    ): Promise<InstructionPreparation> {
      // The process budget owns runnable work; this publication queue is bounded too.
      if (pendingCount >= 64)
        return Promise.resolve({ ok: false, code: "source-queue-full", sources: [] });
      pendingCount++;
      const controls = controlRevision;
      const queuedSignal = AbortSignal.any([signal, AbortSignal.timeout(LIMITS.deadlineMs)]);
      const pending = serial
        .then(() =>
          prepare(scope, selections, queuedSignal, null, controls, expectedConfiguration, observe),
        )
        .then(
          (result): InstructionPreparation =>
            !result.ok && result.code === "cancelled" && !signal.aborted && queuedSignal.aborted
              ? { ...result, code: "source-timeout" }
              : result,
        )
        .finally(() => {
          pendingCount--;
        });
      serial = pending.then(
        () => {},
        () => {},
      );
      return pending;
    },
    emptyPreferences: EMPTY_SOURCE_PREFERENCES,
  };
}

/** Adapters may identify a rejected source without exposing its content or host error. */
export class InstructionSourceFailure extends Error {
  constructor(
    code: string,
    readonly source: string,
  ) {
    super(code);
  }
}

function sourceDecisionPage(decisions: readonly SourceDecision[]): SourceDecision[] {
  const cards: SourceDecision[] = [];
  let bytes = 2;
  for (const decision of decisions) {
    const size = Buffer.byteLength(JSON.stringify(decision)) + (cards.length ? 1 : 0);
    if (cards.length >= LIMITS.pageEntries || bytes + size > LIMITS.pageBytes) break;
    cards.push(decision);
    bytes += size;
  }
  return cards;
}
