/** Test archives built byte by byte, so every hostile shape is exact. Never used by the product. */
import { gzipSync } from "node:zlib";
import { FALRYN_EXTENSION_NAMESPACE, PORTABLE_PLUGIN_SCHEMA } from "./manifest.ts";

export type ArchiveEntry = {
  readonly path: string;
  /** "0" file, "5" directory, "2" symlink, "1" hardlink, "3" device, "6" FIFO. */
  readonly type?: string;
  readonly text?: string;
  readonly bytes?: Uint8Array;
  readonly linkname?: string;
  /** Write the path as a pax record instead of the ustar name field. */
  readonly pax?: boolean;
  /** Corrupt the header checksum. */
  readonly badChecksum?: boolean;
};

const encoder = new TextEncoder();
function header(name: string, size: number, type: string, linkname = "", badChecksum = false) {
  const block = new Uint8Array(512);
  const put = (offset: number, value: string) => block.set(encoder.encode(value), offset);
  put(0, name.slice(0, 100));
  put(100, "0000644\0");
  put(108, "0000000\0");
  put(116, "0000000\0");
  put(124, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, "00000000000\0");
  put(156, type);
  put(157, linkname.slice(0, 100));
  put(257, "ustar\0");
  put(263, "00");
  block.fill(0x20, 148, 156);
  let sum = 0;
  for (const byte of block) sum += byte;
  put(148, `${(badChecksum ? sum + 1 : sum).toString(8).padStart(6, "0")}\0 `);
  return block;
}
function padded(bytes: Uint8Array) {
  const out = new Uint8Array(Math.ceil(bytes.length / 512) * 512);
  out.set(bytes);
  return out;
}

/** An uncompressed tar of the entries, ending with the two zero blocks. */
export function tarBytes(entries: readonly ArchiveEntry[], options: { end?: boolean } = {}) {
  const parts: Uint8Array[] = [];
  for (const entry of entries) {
    const type = entry.type ?? "0";
    const body = entry.bytes ?? encoder.encode(entry.text ?? "");
    if (entry.pax) {
      const record = ` path=${entry.path}\n`;
      let length = record.length;
      while (`${length}${record}`.length !== length) length = `${length}${record}`.length;
      const pax = encoder.encode(`${length}${record}`);
      parts.push(header("PaxHeader", pax.length, "x"), padded(pax));
    }
    const data = type === "0" ? body : new Uint8Array(0);
    parts.push(
      header(
        entry.pax ? "long-name" : entry.path,
        data.length,
        type,
        entry.linkname,
        entry.badChecksum,
      ),
    );
    if (data.length > 0) parts.push(padded(data));
  }
  if (options.end !== false) parts.push(new Uint8Array(1024));
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.length;
  }
  return out;
}

export const archiveBytes = (entries: readonly ArchiveEntry[], options?: { end?: boolean }) =>
  new Uint8Array(gzipSync(tarBytes(entries, options)));

/** A minimal valid package: plugin.json plus one skill, rooted under package/. */
export function packageArchiveEntries(name = "acquired", version = "1.0.0", root = "package/") {
  return [
    ...(root === "" ? [] : [{ path: root, type: "5" }]),
    {
      path: `${root}plugin.json`,
      text: JSON.stringify({
        $schema: PORTABLE_PLUGIN_SCHEMA,
        name,
        version,
        description: "Acquired package",
        extensions: { [FALRYN_EXTENSION_NAMESPACE]: { version: 1 } },
      }),
    },
    {
      path: `${root}skills/review/SKILL.md`,
      text: "---\nname: review\ndescription: Review changes.\n---\nReview.\n",
    },
  ] satisfies ArchiveEntry[];
}
