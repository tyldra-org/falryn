/**
 * Verified package suggestions (#1094). Two kinds of observation can point at an
 * uninstalled package: a Falryn-owned hint line an admitted command writes on stderr,
 * and a relevance declaration in a catalog the user opted into. Neither is trusted. A
 * hint names a source and a package; it carries no command, URL, credential or prompt,
 * and it means nothing until the named catalog lists that exact package. Relevance
 * declarations only compare facts Falryn already observed: an admitted executable's
 * name, workspace-relative paths and the kind of a capability a completed call used.
 * Nothing here reads content, contacts a marketplace, calls a model, installs or
 * enables anything.
 */
import { z } from "zod";
import { TOOL_CAPABILITY_KINDS, type ToolCapabilityKind } from "../tools/tool-registry.ts";
import { compileGlobPattern, matchGlob } from "../workspace/workspace-glob.ts";
import { canonicalDigest } from "./canonical.ts";
import { exactVersionSchema, identityText } from "./identity.ts";

/** The marker's codec name. A line starting with another version is inert text. */
export const PACKAGE_HINT_PREFIX = "falryn-package-hint/";
export const PACKAGE_HINT_VERSION = 1;
export const PACKAGE_SUGGESTIONS_KEY = "tools.packageSuggestions";
export const PACKAGE_SUGGESTION_PROPOSALS_KEY = "capabilities.packageSuggestionProposals";
export const PACKAGE_SUGGESTION_LIMITS = Object.freeze({
  /** One whole marker line, prefix included, independent of the stream it came from. */
  hintBytes: 4_096,
  hintsPerStream: 8,
  /** Distinct observations one session keeps; later ones are counted, not kept. */
  sessionObservations: 128,
  relevanceExecutables: 16,
  relevanceFiles: 16,
  relevanceCapabilities: TOOL_CAPABILITY_KINDS.length,
  dismissed: 256,
  sources: 16,
  reasons: 4,
  /** Additional matches a settled root turn records beside the one it surfaces. */
  additional: 8,
});

const sourceIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u);
const listingIdSchema = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u);
/** An executable's file name only; never a path, argument or shell text. */
export const executableNameSchema = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/u);

/** What a hint may say. Unknown fields make the marker malformed, so it stays inert. */
export const packageHintSchema = z.strictObject({
  sourceId: sourceIdSchema,
  listingId: listingIdSchema,
  packageId: identityText,
  packageVersion: exactVersionSchema.nullable().default(null),
});
export type PackageHint = z.infer<typeof packageHintSchema>;

export type HintDiagnostic = "marker-malformed" | "marker-oversized" | "marker-codec-unknown";
export type HintScan = {
  readonly hints: readonly PackageHint[];
  /** One entry per refused marker line, in stream order; values are never kept. */
  readonly diagnostics: readonly HintDiagnostic[];
  /** Valid markers beyond the per-stream limit. */
  readonly omitted: number;
};

const NEWLINE = 0x0a;
const PREFIX_BYTES = new TextEncoder().encode(PACKAGE_HINT_PREFIX);
const VERSION_PREFIX = `${PACKAGE_HINT_PREFIX}${PACKAGE_HINT_VERSION} `;

function startsWithPrefix(bytes: Uint8Array, at: number): boolean {
  if (at + PREFIX_BYTES.length > bytes.length) return false;
  for (let index = 0; index < PREFIX_BYTES.length; index += 1)
    if (bytes[at + index] !== PREFIX_BYTES[index]) return false;
  return true;
}

/**
 * Find hint markers in one captured stream. A marker is a whole line that starts at
 * the line's first byte, so indented, quoted or embedded text never matches. Only the
 * marker line itself is decoded, never the bulk output around it.
 */
export function scanPackageHints(bytes: Uint8Array): HintScan {
  const hints: PackageHint[] = [];
  const diagnostics: HintDiagnostic[] = [];
  const seen = new Set<string>();
  let omitted = 0;
  let start = 0;
  while (start < bytes.length) {
    const newline = bytes.indexOf(NEWLINE, start);
    const end = newline < 0 ? bytes.length : newline;
    if (startsWithPrefix(bytes, start)) {
      const decoded = decodeMarkerLine(bytes.subarray(start, end));
      if (typeof decoded === "string") diagnostics.push(decoded);
      else if (!seen.has(canonicalDigest(decoded))) {
        // A repeated hint is the same observation, so only new ones count against the limit.
        if (hints.length < PACKAGE_SUGGESTION_LIMITS.hintsPerStream) {
          seen.add(canonicalDigest(decoded));
          hints.push(decoded);
        } else omitted += 1;
      }
    }
    if (newline < 0) break;
    start = newline + 1;
  }
  return { hints, diagnostics, omitted };
}

/** One marker line, without its newline: a hint, or why it stays inert text. */
function decodeMarkerLine(line: Uint8Array): PackageHint | HintDiagnostic {
  const body = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
  if (body.length > PACKAGE_SUGGESTION_LIMITS.hintBytes) return "marker-oversized";
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  } catch {
    return "marker-malformed";
  }
  if (!text.startsWith(VERSION_PREFIX)) return "marker-codec-unknown";
  return decodeHint(text.slice(VERSION_PREFIX.length)) ?? "marker-malformed";
}

function decodeHint(text: string): PackageHint | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = packageHintSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

/**
 * A catalog entry's opt-in relevance declaration. Executables match an admitted
 * command's file name exactly; files are bounded workspace globs compiled by the
 * discovery codec; capabilities name the kinds of the tool vocabulary a completed call
 * used. There is no regex, script or content matcher.
 */
export const relevanceDeclarationSchema = z
  .strictObject({
    executables: z
      .array(executableNameSchema)
      .max(PACKAGE_SUGGESTION_LIMITS.relevanceExecutables)
      .default([]),
    files: z
      .array(
        z
          .string()
          .min(1)
          .max(256)
          .refine((value) => {
            const compiled = compileGlobPattern(value);
            return compiled.ok && !compiled.value.directoryOnly;
          }, "relevance-glob-invalid"),
      )
      .max(PACKAGE_SUGGESTION_LIMITS.relevanceFiles)
      .default([]),
    capabilities: z
      .array(z.enum(TOOL_CAPABILITY_KINDS))
      .max(PACKAGE_SUGGESTION_LIMITS.relevanceCapabilities)
      .default([]),
  })
  .refine(
    (value) => value.executables.length + value.files.length + value.capabilities.length > 0,
    "relevance-empty",
  );
export type RelevanceDeclaration = {
  readonly executables: string[];
  readonly files: string[];
  readonly capabilities: ToolCapabilityKind[];
};

/** The stored, normalized form: sorted and deduplicated, so equal content digests equally. */
export function normalizeRelevance(
  value: z.infer<typeof relevanceDeclarationSchema>,
): RelevanceDeclaration {
  return {
    executables: [...new Set(value.executables)].sort(),
    files: [...new Set(value.files)].sort(),
    capabilities: [...new Set(value.capabilities)].sort(),
  };
}
export const storedRelevanceSchema = z.strictObject({
  executables: z.array(z.string()),
  files: z.array(z.string()),
  capabilities: z.array(z.enum(TOOL_CAPABILITY_KINDS)),
});

/** A fact Falryn already observed; never content, never a home-directory path. */
export type SuggestionSignal =
  | { readonly kind: "executable"; readonly name: string }
  | { readonly kind: "file"; readonly path: string }
  | { readonly kind: "capability"; readonly capability: ToolCapabilityKind };

/** The first declared rule an observed signal satisfies, or null. */
export function relevanceMatch(
  declaration: RelevanceDeclaration,
  signal: SuggestionSignal,
): string | null {
  if (signal.kind === "executable")
    return declaration.executables.includes(signal.name) ? signal.name : null;
  if (signal.kind === "capability")
    return declaration.capabilities.includes(signal.capability) ? signal.capability : null;
  for (const pattern of declaration.files) {
    const compiled = compileGlobPattern(pattern);
    if (compiled.ok && matchGlob(signal.path, compiled.value, "file")) return pattern;
  }
  return null;
}

/** The name an argv-mode command was admitted with; shell text has no admitted program. */
export function executableName(path: string): string | null {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return executableNameSchema.safeParse(name).success ? name : null;
}

/**
 * User-scoped preferences. `sources` opts marketplaces in; nothing is suggested from a
 * source that is not listed. Dismissals name a source and package, not a version, so an
 * update never resets one.
 */
export const packageSuggestionPreferencesSchema = z
  .strictObject({
    sources: z.array(sourceIdSchema).max(PACKAGE_SUGGESTION_LIMITS.sources).default([]),
    dismissed: z
      .array(z.strictObject({ sourceId: sourceIdSchema, packageId: identityText }))
      .max(PACKAGE_SUGGESTION_LIMITS.dismissed)
      .default([]),
  })
  .refine(({ sources }) => new Set(sources).size === sources.length, "duplicate source")
  .refine(
    ({ dismissed }) =>
      new Set(dismissed.map((item) => `${item.sourceId}\n${item.packageId}`)).size ===
      dismissed.length,
    "duplicate dismissal",
  );
export type PackageSuggestionPreferences = z.infer<typeof packageSuggestionPreferencesSchema>;
export const DEFAULT_PACKAGE_SUGGESTION_PREFERENCES: PackageSuggestionPreferences = {
  sources: [],
  dismissed: [],
};

/** Sources project configuration proposes. A proposal is shown for review; it enables nothing. */
export const packageSuggestionProposalsSchema = z.strictObject({
  sources: z.array(sourceIdSchema).max(PACKAGE_SUGGESTION_LIMITS.sources).default([]),
});

export function isDismissed(
  preferences: PackageSuggestionPreferences,
  sourceId: string,
  packageId: string,
): boolean {
  return preferences.dismissed.some(
    (item) => item.sourceId === sourceId && item.packageId === packageId,
  );
}

/** One identity per source and package, so a later version or duplicate output is the same suggestion. */
export function packageSuggestionId(sourceId: string, packageId: string): string {
  return canonicalDigest({ version: 1, sourceId, packageId });
}

/** Why a package was suggested. Values are names and patterns Falryn observed or the catalog declared. */
export const suggestionReasonSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    kind: z.literal("hint"),
    /** null when the command ran through a shell, which admits no program identity. */
    executable: executableNameSchema.nullable(),
    invocationId: z.string().min(1).max(256),
  }),
  z.strictObject({
    kind: z.literal("relevance"),
    signal: z.enum(["executable", "file", "capability"]),
    /** The declared rule that matched: an executable name, a workspace glob or a capability kind. */
    rule: z.string().min(1).max(256),
  }),
]);
export type SuggestionReason = z.infer<typeof suggestionReasonSchema>;

const suggestionSummarySchema = z.strictObject({
  suggestionId: z.string(),
  sourceId: sourceIdSchema,
  listingId: listingIdSchema,
  packageId: identityText,
  packageVersion: z.string().max(256).nullable(),
  identityDigest: z.string().nullable(),
  title: z.string().max(120),
  reasons: z.array(suggestionReasonSchema).min(1).max(PACKAGE_SUGGESTION_LIMITS.reasons),
});
export type PackageSuggestionSummary = z.infer<typeof suggestionSummarySchema>;

/**
 * What a settled root turn recorded: the one suggestion it surfaced and the other
 * eligible matches an explicit list can show. Replay and export read it; nothing
 * matches or notifies again from it.
 */
export const packageSuggestionRecordSchema = z.strictObject({
  version: z.literal(1),
  surfaced: suggestionSummarySchema,
  additional: z.array(suggestionSummarySchema).max(PACKAGE_SUGGESTION_LIMITS.additional),
});
export type PackageSuggestionRecord = z.infer<typeof packageSuggestionRecordSchema>;

/** One reason in words, shared by the transcript, CLI and terminal views. */
export function suggestionReasonText(reason: SuggestionReason): string {
  if (reason.kind === "hint")
    return reason.executable === null
      ? `a command's hint (${reason.invocationId})`
      : `${reason.executable}'s hint (${reason.invocationId})`;
  if (reason.signal === "executable") return `the catalog marks it relevant to ${reason.rule}`;
  if (reason.signal === "capability")
    return `the catalog marks it relevant to ${reason.rule} capabilities this session used`;
  return `the catalog marks it relevant to files matching ${reason.rule}`;
}
