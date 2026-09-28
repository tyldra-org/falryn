/**
 * Skill bundle resources (#137): references, assets, scripts, templates and examples
 * beneath a skill's own directory. Resources are evidence read on demand, never
 * instructions, and nothing here grants execution: every resource reports
 * `executable: false`. A helper script becomes runnable only through package admission.
 */
import { bytesDigest } from "../extensions/canonical.ts";

export const SKILL_RESOURCE_LIMITS = Object.freeze({
  /** Path segments below the bundle, and link hops followed by one request. */
  depth: 16,
  /** Resources one request may resolve, including refused links. */
  references: 64,
  /** Text returned by one request. */
  bytes: 262_144,
  /** One resource file. */
  fileBytes: 1_048_576,
  pathCharacters: 512,
  linksPerFile: 64,
  /** Entries named in a loaded skill's resource index. */
  indexEntries: 32,
  /** Files and directories the index walk may visit. */
  indexScan: 1_024,
});

export const SKILL_RESOURCE_KINDS = [
  "reference",
  "asset",
  "script",
  "template",
  "example",
  "other",
] as const;
export type SkillResourceKind = (typeof SKILL_RESOURCE_KINDS)[number];

/** Each outcome is reported separately; only `loaded` carries text. */
export const SKILL_RESOURCE_STATUSES = [
  "loaded",
  "binary",
  "already-loaded",
  "cycle",
  "escaped",
  "hidden",
  "missing",
  "too-large",
  "budget-exhausted",
  "depth-limit",
  "reference-limit",
  "changed",
  "unreadable",
] as const;
export type SkillResourceStatus = (typeof SKILL_RESOURCE_STATUSES)[number];

export type SkillResourceEntry = {
  /** Normalized path relative to the bundle; a refused path keeps the requested text. */
  readonly path: string;
  readonly kind: SkillResourceKind;
  readonly mediaType: string;
  readonly status: SkillResourceStatus;
  readonly bytes: number | null;
  readonly digest: string | null;
  readonly executable: false;
  /** Link hops from the requested resource. */
  readonly depth: number;
  /** The resource whose link led here; null for the requested one. */
  readonly via: string | null;
  readonly text?: string;
};

export type SkillResourceIndexEntry = {
  readonly path: string;
  readonly kind: SkillResourceKind;
  readonly mediaType: string;
  readonly bytes: number;
  readonly executable: false;
};

const FOLDERS: Readonly<Record<string, SkillResourceKind>> = {
  references: "reference",
  assets: "asset",
  scripts: "script",
  templates: "template",
  examples: "example",
};

export function skillResourceKind(path: string): SkillResourceKind {
  return FOLDERS[path.split("/")[0] ?? ""] ?? "other";
}

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  md: "text/markdown",
  markdown: "text/markdown",
  txt: "text/plain",
  json: "application/json",
  yaml: "application/yaml",
  yml: "application/yaml",
  toml: "application/toml",
  csv: "text/csv",
  html: "text/html",
  xml: "application/xml",
  ts: "text/typescript",
  tsx: "text/typescript",
  js: "text/javascript",
  mjs: "text/javascript",
  cjs: "text/javascript",
  py: "text/x-python",
  sh: "text/x-shellscript",
  bash: "text/x-shellscript",
  rb: "text/x-ruby",
  go: "text/x-go",
  rs: "text/x-rust",
  sql: "application/sql",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  svg: "image/svg+xml",
  pdf: "application/pdf",
  zip: "application/zip",
};

export function skillResourceMediaType(path: string): string {
  const name = path.split("/").at(-1) ?? "";
  const dot = name.lastIndexOf(".");
  return (dot > 0 && MEDIA_TYPES[name.slice(dot + 1).toLowerCase()]) || "application/octet-stream";
}

const TEXT_TYPES = /^(text\/|application\/(json|yaml|toml|xml|sql)$|image\/svg\+xml$)/u;

/**
 * Resolve a path against a directory inside the bundle. `..` may move within the bundle
 * but never above it; absolute, drive, backslash, NUL and empty-segment paths are refused.
 * A hidden segment (such as `.env` or `.git`) is not a skill resource.
 */
export function resolveSkillResourcePath(
  from: string,
  target: string,
):
  | { readonly ok: true; readonly path: string }
  | { readonly ok: false; readonly reason: "escaped" | "hidden" } {
  if (
    target.length === 0 ||
    target.length > SKILL_RESOURCE_LIMITS.pathCharacters ||
    target.startsWith("/") ||
    target.includes("\\") ||
    target.includes("\0") ||
    /^[A-Za-z]:/u.test(target)
  )
    return { ok: false, reason: "escaped" };
  const segments = from === "" ? [] : from.split("/");
  for (const segment of target.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length === 0) return { ok: false, reason: "escaped" };
      segments.pop();
      continue;
    }
    if (segment.startsWith(".")) return { ok: false, reason: "hidden" };
    segments.push(segment);
  }
  if (segments.length === 0 || segments.length > SKILL_RESOURCE_LIMITS.depth)
    return { ok: false, reason: "escaped" };
  return { ok: true, path: segments.join("/") };
}

const directoryOf = (path: string) => path.split("/").slice(0, -1).join("/");

/**
 * Relative links in markdown outside fenced code: inline links and images. Links with
 * a scheme, a bare fragment or a query-only target are not bundle resources.
 */
export function skillResourceLinks(text: string): string[] {
  const links: string[] = [];
  let fenced = false;
  for (const line of text.split("\n")) {
    if (/^\s*(```|~~~)/u.test(line)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    for (const match of line.matchAll(/!?\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu)) {
      const raw = match[1] ?? "";
      if (raw.startsWith("#") || raw.startsWith("?") || /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(raw))
        continue;
      let target = raw.split("#")[0]?.split("?")[0] ?? "";
      try {
        target = decodeURIComponent(target);
      } catch {
        // An undecodable link keeps its literal text and fails resolution honestly.
      }
      if (target !== "" && !links.includes(target)) links.push(target);
      if (links.length >= SKILL_RESOURCE_LIMITS.linksPerFile) return links;
    }
  }
  return links;
}

/** What the host reports for one bundle-relative read. */
export type SkillResourceRead =
  | { readonly ok: true; readonly bytes: Uint8Array }
  | {
      readonly ok: false;
      readonly problem: "missing" | "escaped" | "too-large" | "changed" | "unreadable";
      readonly bytes?: number;
    };

/**
 * Load a resource and, up to `depth` hops, the text resources its markdown links name.
 * Each canonical path is read at most once; every refusal is reported with its reason.
 */
export async function loadSkillResources(
  request: { readonly path: string; readonly depth: number },
  read: (path: string) => Promise<SkillResourceRead>,
  signal: AbortSignal,
): Promise<{ readonly resources: readonly SkillResourceEntry[]; readonly cancelled: boolean }> {
  const limit = Math.min(Math.max(0, Math.trunc(request.depth)), SKILL_RESOURCE_LIMITS.depth);
  const resources: SkillResourceEntry[] = [];
  const visited = new Set<string>();
  let budget: number = SKILL_RESOURCE_LIMITS.bytes;
  const entry = (
    path: string,
    status: SkillResourceStatus,
    depth: number,
    via: string | null,
    extra: Partial<Pick<SkillResourceEntry, "bytes" | "digest" | "text">> = {},
  ): SkillResourceEntry => ({
    path,
    kind: skillResourceKind(path),
    mediaType: skillResourceMediaType(path),
    status,
    bytes: extra.bytes ?? null,
    digest: extra.digest ?? null,
    executable: false,
    depth,
    via,
    ...(extra.text === undefined ? {} : { text: extra.text }),
  });
  const first = resolveSkillResourcePath("", request.path);
  if (!first.ok)
    return { resources: [entry(request.path, first.reason, 0, null)], cancelled: false };
  /** Breadth-first, so nearer links win the shared reference and byte budgets. */
  const queue: { path: string; depth: number; via: string | null; chain: readonly string[] }[] = [
    { path: first.path, depth: 0, via: null, chain: [] },
  ];
  while (queue.length > 0) {
    if (signal.aborted) return { resources, cancelled: true };
    const next = queue.shift();
    if (next === undefined) break;
    const { path, depth, via, chain } = next;
    if (resources.length >= SKILL_RESOURCE_LIMITS.references) {
      resources.push(entry(path, "reference-limit", depth, via));
      break;
    }
    if (chain.includes(path)) {
      resources.push(entry(path, "cycle", depth, via));
      continue;
    }
    if (visited.has(path)) {
      resources.push(entry(path, "already-loaded", depth, via));
      continue;
    }
    visited.add(path);
    const result = await read(path);
    if (!result.ok) {
      resources.push(entry(path, result.problem, depth, via, { bytes: result.bytes ?? null }));
      continue;
    }
    const bytes = result.bytes.byteLength;
    const digest = bytesDigest(result.bytes);
    let text: string | null = null;
    if (TEXT_TYPES.test(skillResourceMediaType(path))) {
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(result.bytes);
      } catch {
        text = null;
      }
    }
    if (text === null) {
      resources.push(entry(path, "binary", depth, via, { bytes, digest }));
      continue;
    }
    if (bytes > budget) {
      resources.push(entry(path, "budget-exhausted", depth, via, { bytes, digest }));
      continue;
    }
    budget -= bytes;
    resources.push(entry(path, "loaded", depth, via, { bytes, digest, text }));
    if (skillResourceMediaType(path) !== "text/markdown") continue;
    for (const link of skillResourceLinks(text)) {
      const target = resolveSkillResourcePath(directoryOf(path), link);
      if (!target.ok) {
        resources.push(entry(link, target.reason, depth + 1, path));
        continue;
      }
      if (depth + 1 > limit) {
        // Beyond the requested depth a link is named, not read, so the model can follow it.
        if (!visited.has(target.path))
          resources.push(entry(target.path, "depth-limit", depth + 1, path));
        continue;
      }
      queue.push({ path: target.path, depth: depth + 1, via: path, chain: [...chain, path] });
    }
  }
  return { resources, cancelled: false };
}

/** Compact index text for a loaded skill; sizes come from the directory walk, not reads. */
export function skillResourceIndexText(
  entries: readonly SkillResourceIndexEntry[],
  omitted: number,
): string {
  const listed = entries
    .slice(0, SKILL_RESOURCE_LIMITS.indexEntries)
    .map(
      (item) =>
        `${item.path} (${item.kind}, ${item.mediaType}, ${item.bytes} bytes${item.kind === "script" ? ", not executable" : ""})`,
    );
  const more = omitted + Math.max(0, entries.length - SKILL_RESOURCE_LIMITS.indexEntries);
  return [...listed, ...(more > 0 ? [`${more} more`] : [])].join("; ");
}
