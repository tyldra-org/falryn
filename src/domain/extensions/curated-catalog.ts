/**
 * Curated catalog metadata (#165). A catalog is a publisher's list of packages it vouches
 * for, as data only. Every listed version is an exact PackageIdentityV1, so a listing never
 * redefines package equality. Catalog claims (review, signature, tests) stay labelled as
 * claims and never become trust evidence; editorial labels and rank never change identity or
 * order. Links are display data. Nothing here fetches, installs or grants authority.
 */
import { z } from "zod";
import type { Result } from "../foundation/result.ts";
import {
  canonicalDigest,
  canonicalJson,
  ExtensionInputError,
  freezeMetadata,
  parseMetadata,
} from "./canonical.ts";
import { digestSchema, exactVersionSchema, packageIdentityV1Schema } from "./identity.ts";
import { type HostFacts, hostCompatible, packageCompatibilitySchema } from "./manifest.ts";

export const CURATED_CATALOG_SCHEMA = "falryn.curated-catalog";
export const CURATED_CATALOG_GENERATION = 1;
export const CURATED_LIMITS = Object.freeze({
  documentBytes: 1_048_576,
  entries: 512,
  versions: 32,
  tags: 16,
  provides: 16,
  localizations: 16,
  labels: 8,
  requires: 16,
  diagnostics: 256,
  titleLength: 120,
  summaryLength: 280,
  descriptionLength: 4_096,
  urlLength: 2_048,
});
/** The package classes of the canonical ecosystem design. */
export const CURATED_KINDS = [
  "skill",
  "plugin",
  "hook-pack",
  "workflow-pack",
  "mcp-preset",
  "documentation-set",
  "example-pack",
  "theme",
] as const;
/** What a listed package contributes, for filtering; its manifest remains authoritative. */
export const CURATED_CONTRIBUTIONS = [
  "skill",
  "prompt",
  "template",
  "tool",
  "mcp-server",
  "agent",
  "workflow",
  "provider",
  "hook",
  "theme",
  "keymap",
  "documentation",
] as const;
/** Claims a catalog may make. Each stays a claim: absent, unsupported or claimed true/false. */
export const CURATED_CLAIMS = ["review", "signature", "tests"] as const;
const ENTRY_FIELDS = [
  "listingId",
  "kind",
  "title",
  "summary",
  "description",
  "publisher",
  "license",
  "links",
  "tags",
  "localizations",
  "provides",
  "versions",
  "claims",
  "editorial",
  "requires",
] as const;
const DOCUMENT_FIELDS = [
  "schema",
  "generation",
  "source",
  "sequence",
  "publishedAt",
  "entries",
  "requires",
] as const;

/** Bidirectional overrides, isolates and zero-width marks make displayed text differ from its bytes. */
const DECEPTIVE = /[\p{Cc}\u202a-\u202e\u2066-\u2069\u200b-\u200f\ufeff]/u;
const text = (maximum: number, multiline = false) =>
  z
    .string()
    .min(1)
    .max(maximum)
    .refine(
      (value) =>
        value.trim() === value && !DECEPTIVE.test(multiline ? value.replaceAll("\n", "") : value),
      "text-deceptive",
    );
const token = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/u, "token-invalid");
const listingId = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/u, "listing-id-invalid");
const time = z.int().nonnegative();
/** Display links only: absolute https, no credentials, never a download location. */
const link = z
  .string()
  .max(CURATED_LIMITS.urlLength)
  .refine((value) => {
    if (DECEPTIVE.test(value) || /\s/u.test(value)) return false;
    try {
      const url = new URL(value);
      return url.protocol === "https:" && url.username === "" && url.password === "";
    } catch {
      return false;
    }
  }, "link-invalid");
const claim = z.strictObject({
  value: z.boolean(),
  at: time,
  by: text(CURATED_LIMITS.titleLength),
});
const withdrawn = z
  .strictObject({ reason: z.enum(["security", "defect", "superseded", "other"]), at: time })
  .nullable();
const version = z.strictObject({
  identity: packageIdentityV1Schema,
  compatibility: packageCompatibilitySchema.optional(),
  publishedAt: time,
  withdrawn: withdrawn.default(null),
});
const localization = z.strictObject({
  title: text(CURATED_LIMITS.titleLength),
  summary: text(CURATED_LIMITS.summaryLength),
});
const entrySchema = z.strictObject({
  listingId,
  kind: z.enum(CURATED_KINDS),
  title: text(CURATED_LIMITS.titleLength),
  summary: text(CURATED_LIMITS.summaryLength),
  description: text(CURATED_LIMITS.descriptionLength, true).nullable().default(null),
  publisher: z.strictObject({ name: text(CURATED_LIMITS.titleLength), url: link.optional() }),
  license: z
    .string()
    .regex(/^[A-Za-z0-9.+()\- ]{1,64}$/u, "license-invalid")
    .nullable()
    .default(null),
  links: z
    .strictObject({
      homepage: link.optional(),
      repository: link.optional(),
      documentation: link.optional(),
    })
    .default({}),
  tags: z.array(token).max(CURATED_LIMITS.tags).default([]),
  localizations: z
    .record(z.string().regex(/^[a-z]{2,3}(?:-[A-Z]{2})?$/u, "locale-invalid"), localization)
    .refine((value) => Object.keys(value).length <= CURATED_LIMITS.localizations, "locale-limit")
    .default({}),
  provides: z.array(z.enum(CURATED_CONTRIBUTIONS)).max(CURATED_LIMITS.provides).default([]),
  versions: z.array(version).min(1).max(CURATED_LIMITS.versions),
  claims: z.record(z.string(), z.unknown()).default({}),
  editorial: z
    .strictObject({
      labels: z.array(token).max(CURATED_LIMITS.labels).default([]),
      rank: z.int().min(0).max(1_000).nullable().default(null),
      featured: z.boolean().default(false),
    })
    .default({ labels: [], rank: null, featured: false }),
  requires: z.array(z.string().max(64)).max(CURATED_LIMITS.requires).default([]),
});

const claimRecord = z.discriminatedUnion("status", [
  z.strictObject({ status: z.literal("absent") }),
  z.strictObject({ status: z.literal("unsupported") }),
  z.strictObject({ status: z.literal("claimed"), value: z.boolean(), at: time, by: z.string() }),
]);
export type CuratedClaim = z.infer<typeof claimRecord>;
const listingSchema = z.strictObject({
  listingId,
  kind: z.enum(CURATED_KINDS),
  title: z.string(),
  summary: z.string(),
  description: z.string().nullable(),
  publisher: z.strictObject({ name: z.string(), url: z.string().nullable() }),
  license: z.string().nullable(),
  links: z.strictObject({
    homepage: z.string().nullable(),
    repository: z.string().nullable(),
    documentation: z.string().nullable(),
  }),
  tags: z.array(z.string()),
  localizations: z.record(z.string(), localization),
  provides: z.array(z.enum(CURATED_CONTRIBUTIONS)),
  versions: z.array(
    z.strictObject({
      identity: packageIdentityV1Schema,
      identityDigest: digestSchema,
      compatibility: packageCompatibilitySchema.nullable(),
      publishedAt: time,
      withdrawn,
    }),
  ),
  /** Catalog claims, never trust evidence. Unrecognized claim names are listed, not kept. */
  claims: z.strictObject({
    authority: z.literal("catalog-claim"),
    review: claimRecord,
    signature: claimRecord,
    tests: claimRecord,
    unrecognized: z.array(z.string()),
  }),
  /** Presentation only: never identity, ordering, trust or availability. */
  editorial: z.strictObject({
    labels: z.array(z.string()),
    rank: z.int().nullable(),
    featured: z.boolean(),
  }),
});
export type CuratedListing = z.infer<typeof listingSchema>;
export const curatedListingSchema = listingSchema;
export const curatedCatalogSchema = z.strictObject({
  schema: z.literal(CURATED_CATALOG_SCHEMA),
  generation: z.literal(CURATED_CATALOG_GENERATION),
  source: z.strictObject({ id: token, title: z.string() }),
  sequence: z.int().positive(),
  publishedAt: time,
  entries: z.array(listingSchema).max(CURATED_LIMITS.entries),
  digest: digestSchema,
});
export type CuratedCatalog = z.infer<typeof curatedCatalogSchema>;

export type CatalogDiagnostic = {
  readonly code: string;
  /** JSON pointer into the submitted document; never a submitted value. */
  readonly path: string;
  readonly entry: number | null;
  readonly listingId: string | null;
};
export type CatalogIngestion =
  | { readonly kind: "rejected"; readonly diagnostics: readonly CatalogDiagnostic[] }
  | {
      readonly kind: "ingested";
      readonly catalog: CuratedCatalog;
      /** Listing IDs whose submitted entry was refused. */
      readonly rejected: readonly string[];
      readonly diagnostics: readonly CatalogDiagnostic[];
    };

const SAFE_KEY = /^[A-Za-z0-9_-]{1,64}$/u;
function pointer(path: readonly PropertyKey[]): string {
  const parts = path.map((part) =>
    typeof part === "number" || SAFE_KEY.test(String(part)) ? String(part) : "~",
  );
  return ("/" + parts.join("/")).slice(0, 256);
}
function codeOf(message: string | undefined): string {
  return message !== undefined && /^[a-z]+(?:-[a-z]+)+$/u.test(message) ? message : "field-invalid";
}

/** A digest of one exact package identity; listings collide only on this, never on names. */
export function curatedIdentityDigest(identity: z.infer<typeof packageIdentityV1Schema>): string {
  return canonicalDigest(identity);
}

function normalizeClaims(raw: Readonly<Record<string, unknown>>): CuratedListing["claims"] {
  const read = (name: (typeof CURATED_CLAIMS)[number]): CuratedClaim => {
    if (!Object.hasOwn(raw, name)) return { status: "absent" };
    const parsed = claim.safeParse(raw[name]);
    return parsed.success ? { status: "claimed", ...parsed.data } : { status: "unsupported" };
  };
  return {
    authority: "catalog-claim",
    review: read("review"),
    signature: read("signature"),
    tests: read("tests"),
    unrecognized: Object.keys(raw)
      .filter((key) => !(CURATED_CLAIMS as readonly string[]).includes(key))
      .map((key) => (SAFE_KEY.test(key) ? key : "~"))
      .sort(),
  };
}

function normalizeEntry(entry: z.infer<typeof entrySchema>): CuratedListing {
  return {
    listingId: entry.listingId,
    kind: entry.kind,
    title: entry.title,
    summary: entry.summary,
    description: entry.description,
    publisher: { name: entry.publisher.name, url: entry.publisher.url ?? null },
    license: entry.license,
    links: {
      homepage: entry.links.homepage ?? null,
      repository: entry.links.repository ?? null,
      documentation: entry.links.documentation ?? null,
    },
    tags: [...new Set(entry.tags)].sort(),
    localizations: Object.fromEntries(
      Object.entries(entry.localizations).sort(([a], [b]) => (a < b ? -1 : 1)),
    ),
    provides: [...new Set(entry.provides)].sort(),
    versions: entry.versions
      .map((value) => ({
        identity: value.identity,
        identityDigest: curatedIdentityDigest(value.identity),
        compatibility: value.compatibility ?? null,
        publishedAt: value.publishedAt,
        withdrawn: value.withdrawn,
      }))
      .sort((a, b) =>
        b.publishedAt !== a.publishedAt
          ? b.publishedAt - a.publishedAt
          : a.identityDigest < b.identityDigest
            ? -1
            : 1,
      ),
    claims: normalizeClaims(entry.claims),
    editorial: {
      labels: [...new Set(entry.editorial.labels)].sort(),
      rank: entry.editorial.rank,
      featured: entry.editorial.featured,
    },
  };
}

const requiredList = z.array(z.string().max(64)).max(CURATED_LIMITS.requires);
/** Fields a consumer must understand; naming anything else refuses that entry. */
function understands(requires: unknown, known: readonly string[]): boolean {
  const parsed = requiredList.safeParse(requires ?? []);
  return parsed.success && parsed.data.every((field) => known.includes(field));
}
function ignoredFields(
  value: Readonly<Record<string, unknown>>,
  known: readonly string[],
  entry: number | null,
  base: readonly PropertyKey[],
  id: string | null,
): CatalogDiagnostic[] {
  return Object.keys(value)
    .filter((key) => !known.includes(key))
    .sort()
    .map((key) => ({ code: "field-ignored", path: pointer([...base, key]), entry, listingId: id }));
}

/**
 * Ingest one catalog document. Document problems reject it whole; entry problems reject
 * only that entry. Duplicate listings and shared package identities reject every
 * participant: neither side wins. Diagnostics name paths and codes, never values.
 */
export function ingestCuratedCatalog(bytes: Uint8Array): CatalogIngestion {
  const diagnostics: CatalogDiagnostic[] = [];
  const reject = (code: string, path = "/"): CatalogIngestion => ({
    kind: "rejected",
    diagnostics: [{ code, path, entry: null, listingId: null }],
  });
  if (bytes.byteLength > CURATED_LIMITS.documentBytes) return reject("catalog-too-large");
  let document: unknown;
  try {
    document = parseMetadata(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch (error) {
    return reject(
      error instanceof ExtensionInputError && error.code === "duplicate-json-key"
        ? "catalog-duplicate-key"
        : "catalog-malformed",
    );
  }
  if (document === null || typeof document !== "object" || Array.isArray(document))
    return reject("catalog-malformed");
  const raw = document as Readonly<Record<string, unknown>>;
  if (raw.schema !== CURATED_CATALOG_SCHEMA) return reject("catalog-schema-unsupported", "/schema");
  if (raw.generation !== CURATED_CATALOG_GENERATION)
    return reject("catalog-generation-unsupported", "/generation");
  if (!understands(raw.requires, DOCUMENT_FIELDS))
    return reject("catalog-required-field-unknown", "/requires");
  const header = z
    .object({
      source: z.strictObject({ id: token, title: text(CURATED_LIMITS.titleLength) }),
      sequence: z.int().positive(),
      publishedAt: time,
      entries: z.array(z.unknown()),
    })
    .safeParse(raw);
  if (!header.success)
    return reject("catalog-header-invalid", pointer(header.error.issues[0]?.path ?? []));
  if (header.data.entries.length > CURATED_LIMITS.entries)
    return reject("catalog-entry-limit", "/entries");
  diagnostics.push(...ignoredFields(raw, DOCUMENT_FIELDS, null, [], null));

  const parsed = new Map<number, z.infer<typeof entrySchema>>();
  header.data.entries.forEach((candidate, index) => {
    const base = ["entries", index];
    if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) {
      diagnostics.push({
        code: "entry-malformed",
        path: pointer(base),
        entry: index,
        listingId: null,
      });
      return;
    }
    const listing = candidate as Readonly<Record<string, unknown>>;
    const named = listingId.safeParse(listing.listingId);
    const id = named.success ? named.data : null;
    if (!understands(listing.requires, ENTRY_FIELDS)) {
      diagnostics.push({
        code: "entry-required-field-unknown",
        path: pointer([...base, "requires"]),
        entry: index,
        listingId: id,
      });
      return;
    }
    const known = Object.fromEntries(
      Object.entries(listing).filter(([key]) => (ENTRY_FIELDS as readonly string[]).includes(key)),
    );
    const checked = entrySchema.safeParse(known);
    if (!checked.success) {
      for (const issue of checked.error.issues.slice(0, 8))
        diagnostics.push({
          code: codeOf(issue.message),
          path: pointer([...base, ...issue.path]),
          entry: index,
          listingId: id,
        });
      return;
    }
    const versions = checked.data.versions;
    const packageVersions = versions.map((value) => value.identity.packageVersion);
    const digests = versions.map((value) => curatedIdentityDigest(value.identity));
    if (
      new Set(versions.map((value) => value.identity.packageId)).size !== 1 ||
      new Set(packageVersions).size !== packageVersions.length ||
      new Set(digests).size !== digests.length ||
      packageVersions.some(
        (value) => value !== null && !exactVersionSchema.safeParse(value).success,
      )
    ) {
      diagnostics.push({
        code: "versions-inconsistent",
        path: pointer([...base, "versions"]),
        entry: index,
        listingId: id,
      });
      return;
    }
    diagnostics.push(...ignoredFields(listing, ENTRY_FIELDS, index, base, id));
    parsed.set(index, checked.data);
  });

  // Neither side of a duplicate listing or a shared package identity is admitted.
  const byListing = new Map<string, number[]>();
  const byIdentity = new Map<string, Set<number>>();
  for (const [index, entry] of parsed) {
    byListing.set(entry.listingId, [...(byListing.get(entry.listingId) ?? []), index]);
    for (const value of entry.versions) {
      const digest = curatedIdentityDigest(value.identity);
      byIdentity.set(digest, new Set([...(byIdentity.get(digest) ?? []), index]));
    }
  }
  const excluded = new Map<number, string>();
  for (const indexes of byListing.values())
    if (indexes.length > 1) for (const index of indexes) excluded.set(index, "listing-duplicate");
  for (const indexes of byIdentity.values())
    if (indexes.size > 1)
      for (const index of indexes)
        if (!excluded.has(index)) excluded.set(index, "identity-collision");
  for (const [index, code] of excluded) {
    diagnostics.push({
      code,
      path: pointer(["entries", index]),
      entry: index,
      listingId: parsed.get(index)?.listingId ?? null,
    });
    parsed.delete(index);
  }

  const entries = [...parsed.values()]
    .map(normalizeEntry)
    .sort((a, b) => (a.listingId < b.listingId ? -1 : 1));
  const body = {
    schema: CURATED_CATALOG_SCHEMA,
    generation: CURATED_CATALOG_GENERATION,
    source: header.data.source,
    sequence: header.data.sequence,
    publishedAt: header.data.publishedAt,
    entries,
  };
  const catalog = freezeMetadata(
    curatedCatalogSchema.parse({ ...body, digest: canonicalDigest(body) }),
  );
  const admitted = new Set(entries.map((entry) => entry.listingId));
  const rejected = [
    ...new Set(
      diagnostics
        .filter((item) => item.code !== "field-ignored" && item.listingId !== null)
        .map((item) => item.listingId as string)
        .filter((id) => !admitted.has(id)),
    ),
  ].sort();
  diagnostics.sort((a, b) => (a.entry ?? -1) - (b.entry ?? -1) || (a.path < b.path ? -1 : 1));
  return {
    kind: "ingested",
    catalog,
    rejected,
    diagnostics: diagnostics.slice(0, CURATED_LIMITS.diagnostics),
  };
}

/** Deterministic serialization; parsing it back yields an identical record. */
export function serializeCuratedCatalog(catalog: CuratedCatalog): string {
  return canonicalJson(catalog);
}

/** Read a stored normalized catalog; a changed body or unknown generation is refused. */
export function parseCuratedCatalog(value: string): CuratedCatalog {
  const catalog = curatedCatalogSchema.parse(parseMetadata(value));
  const { digest, ...body } = catalog;
  if (canonicalDigest(body) !== digest) throw new ExtensionInputError("catalog-record-corrupt");
  return freezeMetadata(catalog);
}

/** Per-version host compatibility; an absent declaration admits any host. */
export function listingCompatibility(listing: CuratedListing, host: HostFacts) {
  return listing.versions.map((value) => ({
    identityDigest: value.identityDigest,
    packageVersion: value.identity.packageVersion,
    compatible: hostCompatible(value.compatibility ?? undefined, host),
    withdrawn: value.withdrawn !== null,
  }));
}

export const CURATED_RECORD_VERSION = 2;
export const CURATED_RECORD_BYTES = 4_194_304;
export const CURATED_SOURCES = 64;
/**
 * Where a stored catalog came from. A file import makes no freshness claim; a marketplace
 * refresh records the exact configured URL, when it was fetched and the digest of the
 * received document, so freshness is always a dated fact rather than an assumption.
 */
export const catalogOriginSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("file") }),
  z.strictObject({
    kind: z.literal("marketplace"),
    url: z.string().max(CURATED_LIMITS.urlLength),
    fetchedAt: time,
    bodyDigest: digestSchema,
  }),
]);
export type CatalogOrigin = z.infer<typeof catalogOriginSchema>;
/**
 * One source's stored catalog. A listing whose newer entry was refused keeps its prior
 * accepted form, marked retained with the sequence it came from, instead of vanishing
 * or being replaced by invalid data.
 */
export const curatedCatalogRecordSchema = z.strictObject({
  recordVersion: z.literal(CURATED_RECORD_VERSION),
  catalog: curatedCatalogSchema,
  retained: z
    .array(z.strictObject({ fromSequence: z.int().positive(), listing: listingSchema }))
    .max(CURATED_LIMITS.entries),
  importedAt: time,
  origin: catalogOriginSchema,
});
export type CuratedCatalogRecord = z.infer<typeof curatedCatalogRecordSchema>;

export type CuratedImportDecision =
  | { readonly kind: "stale"; readonly storedSequence: number }
  | { readonly kind: "conflict"; readonly storedSequence: number }
  | {
      readonly kind: "unchanged";
      readonly record: CuratedCatalogRecord;
      /** The same catalog was fetched again; only its origin facts move forward. */
      readonly refreshed: boolean;
    }
  | {
      readonly kind: "replace";
      readonly record: CuratedCatalogRecord;
      /** Retained listings dropped because the new catalog now lists their package. */
      readonly dropped: readonly string[];
    };

/**
 * Decide how one ingested catalog replaces its source's stored record. Only a higher
 * sequence replaces; the same sequence with a different body is a conflict, never a win.
 * Receiving the same catalog again from a marketplace renews its fetch facts only.
 */
export function decideCuratedImport(
  prior: CuratedCatalogRecord | null,
  catalog: CuratedCatalog,
  rejected: readonly string[],
  importedAt: number,
  origin: CatalogOrigin = { kind: "file" },
): CuratedImportDecision {
  if (prior !== null) {
    const stored = prior.catalog.sequence;
    if (catalog.sequence < stored) return { kind: "stale", storedSequence: stored };
    if (catalog.sequence === stored) {
      if (catalog.digest !== prior.catalog.digest)
        return { kind: "conflict", storedSequence: stored };
      if (origin.kind === "file") return { kind: "unchanged", record: prior, refreshed: false };
      return {
        kind: "unchanged",
        record: freezeMetadata(curatedCatalogRecordSchema.parse({ ...prior, importedAt, origin })),
        refreshed: true,
      };
    }
  }
  const previous = new Map<string, { fromSequence: number; listing: CuratedListing }>();
  for (const item of prior?.retained ?? []) previous.set(item.listing.listingId, item);
  for (const listing of prior?.catalog.entries ?? [])
    previous.set(listing.listingId, { fromSequence: prior?.catalog.sequence ?? 1, listing });
  const listed = new Set(
    catalog.entries.flatMap((entry) => entry.versions.map((value) => value.identityDigest)),
  );
  const retained: CuratedCatalogRecord["retained"] = [];
  const dropped: string[] = [];
  for (const id of rejected) {
    const item = previous.get(id);
    if (item === undefined) continue;
    if (item.listing.versions.some((value) => listed.has(value.identityDigest))) dropped.push(id);
    else retained.push(item);
  }
  retained.sort((a, b) => (a.listing.listingId < b.listing.listingId ? -1 : 1));
  return {
    kind: "replace",
    record: freezeMetadata(
      curatedCatalogRecordSchema.parse({
        recordVersion: CURATED_RECORD_VERSION,
        catalog,
        retained,
        importedAt,
        origin,
      }),
    ),
    dropped: dropped.sort(),
  };
}

/**
 * Read one stored record; an unknown record version is reported, never guessed at.
 * Version 1 predates marketplace refresh, so its catalogs were file imports.
 */
export function parseCuratedCatalogRecord(
  value: string,
):
  | { readonly ok: true; readonly record: CuratedCatalogRecord }
  | { readonly ok: false; readonly code: string } {
  let raw: unknown;
  try {
    if (Buffer.byteLength(value) > CURATED_RECORD_BYTES)
      return { ok: false, code: "catalog-record-corrupt" };
    raw = JSON.parse(value);
  } catch {
    return { ok: false, code: "catalog-record-corrupt" };
  }
  if (raw === null || typeof raw !== "object" || Array.isArray(raw))
    return { ok: false, code: "catalog-record-corrupt" };
  const version = (raw as { recordVersion?: unknown }).recordVersion;
  if (version === 1)
    raw = { ...raw, recordVersion: CURATED_RECORD_VERSION, origin: { kind: "file" } };
  else if (version !== CURATED_RECORD_VERSION)
    return { ok: false, code: "catalog-record-unsupported" };
  const parsed = curatedCatalogRecordSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, code: "catalog-record-corrupt" };
  const { digest, ...body } = parsed.data.catalog;
  if (canonicalDigest(body) !== digest) return { ok: false, code: "catalog-record-corrupt" };
  return { ok: true, record: freezeMetadata(parsed.data) };
}

export type StoredCuratedCatalog = {
  readonly sourceId: string;
  readonly sequence: number;
  readonly record: CuratedCatalogRecord | null;
  /** Why a stored row could not be read; its source stays listed as unavailable. */
  readonly code: string | null;
};
export type CuratedCatalogStoreError = { readonly code: string };
export interface CuratedCatalogStore {
  get(sourceId: string): Result<StoredCuratedCatalog | null, CuratedCatalogStoreError>;
  list(): Result<readonly StoredCuratedCatalog[], CuratedCatalogStoreError>;
  /** Compare-and-replace on the stored sequence; null expects no stored record. */
  replace(
    record: CuratedCatalogRecord,
    expectedSequence: number | null,
    signal?: AbortSignal,
  ): Result<null, CuratedCatalogStoreError>;
}
