import { parseDocument } from "yaml";
import { z } from "zod";
import {
  canonicalJson,
  canonicalText,
  ExtensionInputError,
  packageRelativePath,
  parseMetadata,
} from "../../domain/extensions/canonical.ts";
import { PORTABLE_MCP_SCHEMA, portableMcpServerSchema } from "../../domain/extensions/manifest.ts";
import type { InspectionDiagnostic } from "../../domain/extensions/package-source.ts";

export type PortableComponent = {
  readonly kind: "skill" | "prompt" | "mcp-connection";
  readonly id: string;
  readonly path: string;
  readonly metadata: Readonly<Record<string, unknown>>;
};
const skillHeader = z
  .object({
    name: z
      .string()
      .min(1)
      .max(64)
      .regex(/^(?!.*--)[a-z0-9]+(?:-[a-z0-9]+)*$/u),
    description: z.string().trim().min(1).max(1_024),
    license: z.string().optional(),
    compatibility: z.string().min(1).max(500).optional(),
    metadata: z.record(z.string(), z.string()).optional(),
    "allowed-tools": z.string().optional(),
  })
  .catchall(z.unknown());

/** YAML is decoded once as inert metadata, never interpolated or evaluated. */
export function markdownMetadata(
  bytes: Uint8Array,
  required: boolean,
): Readonly<Record<string, unknown>> {
  const text = canonicalText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  if (!text.startsWith("---\n")) {
    if (required) throw new ExtensionInputError("missing-frontmatter");
    return {};
  }
  const end = text.indexOf("\n---", 4);
  if (end < 0 || (text[end + 4] !== undefined && text[end + 4] !== "\n"))
    throw new ExtensionInputError("invalid-frontmatter");
  const document = parseDocument(text.slice(4, end), {
    strict: true,
    uniqueKeys: true,
    stringKeys: true,
    prettyErrors: false,
    logLevel: "silent",
    version: "1.2",
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    throw new ExtensionInputError("invalid-frontmatter");
  const parsed: unknown = document.toJS({ maxAliasCount: 100 });
  const normalized: unknown = JSON.parse(canonicalJson(parsed));
  if (normalized === null || typeof normalized !== "object" || Array.isArray(normalized))
    throw new ExtensionInputError("invalid-frontmatter");
  return normalized as Record<string, unknown>;
}

export function portableComponents(
  files: ReadonlyMap<string, Uint8Array>,
  diagnose: (diagnostic: InspectionDiagnostic) => void,
): PortableComponent[] {
  const components: PortableComponent[] = [];
  for (const [path, bytes] of files) {
    const skill = /^skills\/([^/]+)\/SKILL\.md$/u.exec(path);
    const prompt = /^prompts\/([^/]+)\.md$/u.exec(path);
    if (skill === null && prompt === null) continue;
    try {
      const metadata = markdownMetadata(bytes, skill !== null);
      if (skill !== null) {
        const checked = skillHeader.safeParse(metadata);
        if (!checked.success || checked.data.name !== skill[1])
          throw new ExtensionInputError("invalid-skill");
        components.push({ kind: "skill", id: checked.data.name, path, metadata: checked.data });
      } else if (prompt?.[1] !== undefined) {
        if (
          ["description", "argument-hint"].some(
            (key) => metadata[key] !== undefined && typeof metadata[key] !== "string",
          )
        )
          throw new ExtensionInputError("invalid-prompt");
        components.push({ kind: "prompt", id: prompt[1], path, metadata });
      }
    } catch {
      diagnose({ code: skill !== null ? "invalid-skill" : "invalid-prompt", path });
    }
  }
  const mcp = files.get("mcp.json");
  if (mcp !== undefined) {
    try {
      const parsed = z
        .strictObject({
          $schema: z.literal(PORTABLE_MCP_SCHEMA),
          mcpServers: z.record(z.string(), z.unknown()),
        })
        .safeParse(parseMetadata(new TextDecoder("utf-8", { fatal: true }).decode(mcp)));
      if (!parsed.success) throw new ExtensionInputError("invalid-mcp-config");
      for (const [id, raw] of Object.entries(parsed.data.mcpServers)) {
        const server = portableMcpServerSchema.safeParse(raw);
        if (
          !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/u.test(id) ||
          !server.success ||
          !validServer(server.data, files)
        ) {
          diagnose({ code: "invalid-mcp-server", path: "mcp.json" });
          continue;
        }
        components.push({ kind: "mcp-connection", id, path: "mcp.json", metadata: server.data });
      }
    } catch {
      diagnose({ code: "invalid-mcp-config", path: "mcp.json" });
    }
  }
  return components;
}

function validServer(
  server: z.infer<typeof portableMcpServerSchema>,
  files: ReadonlyMap<string, Uint8Array>,
): boolean {
  if (server.type === "stdio") {
    if (/[\s\p{Cc}]/u.test(server.command)) return false;
    if (server.command.startsWith("./")) {
      const path = packageRelativePath(server.command);
      if (path === null || !files.has(path)) return false;
    } else if (/[\\/:$]/u.test(server.command)) return false;
    if (Object.keys(server.env ?? {}).some((key) => /^(?:PLUGIN_ROOT|PLUGIN_DATA)$/iu.test(key)))
      return false;
    if (server.cwd !== undefined) {
      const cwd = server.cwd;
      if (!cwd.startsWith("./") && !/^\$\{PLUGIN_(?:ROOT|DATA)\}(?:\/|$)/u.test(cwd)) return false;
      const suffix = cwd.replace(/^\$\{PLUGIN_(?:ROOT|DATA)\}\/?/u, "");
      if (suffix !== "" && suffix !== "./" && packageRelativePath(suffix) === null) return false;
    }
    return true;
  }
  try {
    const url = new URL(server.url);
    if (
      !["https:", "http:"].includes(url.protocol) ||
      url.username !== "" ||
      url.password !== "" ||
      url.hash !== ""
    )
      return false;
    if (url.protocol === "http:" && !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      return false;
    const seen = new Set<string>();
    for (const [key, value] of Object.entries(server.headers ?? {})) {
      const normalized = key.toLowerCase();
      if (
        !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(key) ||
        /[\r\n]/u.test(value) ||
        value.includes("\0") ||
        seen.has(normalized)
      )
        return false;
      seen.add(normalized);
    }
    return true;
  } catch {
    return false;
  }
}
