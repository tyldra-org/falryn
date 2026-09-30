/**
 * Package archives (#1210). A downloaded package is a gzip-compressed POSIX ustar/pax
 * tar. This reader is deliberately small and strict: it accepts regular files and
 * directories only, refuses every link, device and unsafe path with its own code, and
 * never touches a file system. Its output is an in-memory package file list.
 */
import { gunzipSync } from "node:zlib";
import { err, ok, type Result } from "../foundation/result.ts";
import { packageRelativePath } from "./canonical.ts";
import type { PackageFile } from "./package-source.ts";

export const PACKAGE_ARCHIVE_LIMITS = Object.freeze({
  /** Compressed bytes accepted from a download. */
  compressedBytes: 67_108_864,
  /** Expanded tar bytes; also the installed-version byte ceiling. */
  expandedBytes: 67_108_864,
  files: 4_096,
  /** Header records, including directories and pax records. */
  records: 16_384,
  pathBytes: 1_024,
  depth: 32,
});

export const PACKAGE_ARCHIVE_ERRORS = [
  "archive-not-gzip",
  "archive-expanded-too-large",
  "archive-malformed",
  "archive-entry-link",
  "archive-entry-special",
  "archive-path-invalid",
  "archive-path-duplicate",
  "archive-too-many-entries",
  "archive-root-ambiguous",
] as const;
export type PackageArchiveError = (typeof PACKAGE_ARCHIVE_ERRORS)[number];

const BLOCK = 512;
const decoder = new TextDecoder("utf-8", { fatal: true });

function field(block: Uint8Array, offset: number, length: number): Uint8Array {
  const slice = block.subarray(offset, offset + length);
  const end = slice.indexOf(0);
  return end < 0 ? slice : slice.subarray(0, end);
}
function octal(block: Uint8Array, offset: number, length: number): number | null {
  const text = new TextDecoder().decode(field(block, offset, length)).trim();
  if (!/^[0-7]{1,12}$/u.test(text)) return null;
  const value = Number.parseInt(text, 8);
  return Number.isSafeInteger(value) ? value : null;
}
function checksumValid(block: Uint8Array): boolean {
  const stored = octal(block, 148, 8);
  if (stored === null) return false;
  let sum = 0;
  for (let index = 0; index < BLOCK; index++)
    sum += index >= 148 && index < 156 ? 0x20 : (block[index] ?? 0);
  return sum === stored;
}
/** Pax records are "<length> <key>=<value>\n"; only the path is honoured. */
function paxPath(bytes: Uint8Array): string | null | "malformed" {
  let text: string;
  try {
    text = decoder.decode(bytes);
  } catch {
    return "malformed";
  }
  let path: string | null = null;
  let at = 0;
  while (at < text.length) {
    const space = text.indexOf(" ", at);
    if (space < 0) return "malformed";
    const length = Number(text.slice(at, space));
    if (!Number.isSafeInteger(length) || length <= space - at) return "malformed";
    const record = text.slice(space + 1, at + length);
    if (!record.endsWith("\n")) return "malformed";
    const equals = record.indexOf("=");
    if (equals < 0) return "malformed";
    if (record.slice(0, equals) === "path") path = record.slice(equals + 1, -1);
    at += length;
  }
  return path;
}

/**
 * Read one compressed package archive into package files. The package root is the
 * archive root when it holds plugin.json, otherwise the single top-level directory
 * every entry shares.
 */
export function readPackageArchive(
  compressed: Uint8Array,
): Result<readonly PackageFile[], PackageArchiveError> {
  if (compressed[0] !== 0x1f || compressed[1] !== 0x8b) return err("archive-not-gzip");
  let tar: Uint8Array;
  try {
    tar = gunzipSync(compressed, { maxOutputLength: PACKAGE_ARCHIVE_LIMITS.expandedBytes });
  } catch (error) {
    return err(
      (error as { code?: string }).code === "ERR_BUFFER_TOO_LARGE"
        ? "archive-expanded-too-large"
        : "archive-not-gzip",
    );
  }
  const files: { path: string; bytes: Uint8Array }[] = [];
  const directories = new Set<string>();
  let pendingPath: string | null = null;
  let records = 0;
  let ended = false;
  for (let at = 0; at + BLOCK <= tar.length; ) {
    const header = tar.subarray(at, at + BLOCK);
    if (header.every((byte) => byte === 0)) {
      ended = true;
      break;
    }
    if (++records > PACKAGE_ARCHIVE_LIMITS.records) return err("archive-too-many-entries");
    const magic = new TextDecoder().decode(header.subarray(257, 262));
    if (magic !== "ustar" || !checksumValid(header)) return err("archive-malformed");
    const size = octal(header, 124, 12);
    if (size === null) return err("archive-malformed");
    const dataStart = at + BLOCK;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) return err("archive-malformed");
    const data = tar.subarray(dataStart, dataEnd);
    at = dataStart + Math.ceil(size / BLOCK) * BLOCK;
    const type = String.fromCharCode(header[156] ?? 0);
    if (type === "x" || type === "L") {
      if (size > PACKAGE_ARCHIVE_LIMITS.pathBytes * 4) return err("archive-malformed");
      const named = type === "L" ? decodePath(field(data, 0, data.length)) : paxPath(data);
      if (named === "malformed") return err("archive-malformed");
      pendingPath = named;
      continue;
    }
    // Global pax records carry defaults only; they never name an entry.
    if (type === "g") continue;
    if (type === "1" || type === "2" || type === "K") return err("archive-entry-link");
    if (type !== "0" && type !== "\0" && type !== "5") return err("archive-entry-special");
    let raw: string | null | "malformed" = pendingPath;
    pendingPath = null;
    if (raw === null) {
      const name = decodePath(field(header, 0, 100));
      const prefix = decodePath(field(header, 345, 155));
      if (name === "malformed" || prefix === "malformed" || name === null)
        return err("archive-malformed");
      raw = prefix === null ? name : `${prefix}/${name}`;
    }
    if (raw === "malformed") return err("archive-malformed");
    const path = entryPath(raw, type === "5");
    if (path === "invalid") return err("archive-path-invalid");
    if (path === null) continue;
    if (type === "5") {
      directories.add(path);
      continue;
    }
    if (files.length >= PACKAGE_ARCHIVE_LIMITS.files) return err("archive-too-many-entries");
    files.push({ path, bytes: data.slice() });
  }
  if (!ended || pendingPath !== null) return err("archive-malformed");

  // Exact and case-folded duplicates, and a file that is also a directory, are refused.
  const seen = new Set<string>();
  for (const file of files) {
    const folded = file.path.toLowerCase();
    if (seen.has(folded) || directories.has(file.path)) return err("archive-path-duplicate");
    seen.add(folded);
  }
  for (const file of files) {
    const parts = file.path.split("/");
    for (let depth = 1; depth < parts.length; depth++)
      if (seen.has(parts.slice(0, depth).join("/").toLowerCase()))
        return err("archive-path-duplicate");
  }
  if (files.some((file) => file.path === "plugin.json"))
    return ok(files.sort((a, b) => (a.path < b.path ? -1 : 1)));
  const tops = new Set(files.map((file) => file.path.split("/")[0]));
  const [top] = tops;
  if (tops.size !== 1 || top === undefined || files.some((file) => !file.path.includes("/")))
    return err("archive-root-ambiguous");
  return ok(
    files
      .map((file) => ({ path: file.path.slice(top.length + 1), bytes: file.bytes }))
      .sort((a, b) => (a.path < b.path ? -1 : 1)),
  );
}

function decodePath(bytes: Uint8Array): string | null | "malformed" {
  if (bytes.length === 0) return null;
  try {
    return decoder.decode(bytes);
  } catch {
    return "malformed";
  }
}

/** A safe package-relative path, null for the archive root itself, or invalid. */
function entryPath(raw: string, directory: boolean): string | null | "invalid" {
  let path = raw;
  if (directory) path = path.replace(/\/+$/u, "");
  while (path.startsWith("./")) path = path.slice(2);
  if (path === "." || path === "") return directory ? null : "invalid";
  if (
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("\0") ||
    new TextEncoder().encode(path).length > PACKAGE_ARCHIVE_LIMITS.pathBytes ||
    path.split("/").length > PACKAGE_ARCHIVE_LIMITS.depth ||
    packageRelativePath(path) !== path
  )
    return "invalid";
  return path;
}
