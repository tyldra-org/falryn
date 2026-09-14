import {
  applyEdits,
  createScanner,
  type Edit,
  findNodeAtLocation,
  format,
  getNodeValue,
  modify,
  type Node,
  parseTree,
} from "jsonc-parser";
import { createEmptyConfigurationDocument, serializeConfigurationDocument } from "./document.ts";
import { MAX_CONFIGURATION_FILE_BYTES, parseJsonc } from "./jsonc.ts";

export type ConfigurationDocumentEdit =
  | { readonly kind: "set"; readonly path: readonly string[]; readonly value: unknown }
  | { readonly kind: "remove"; readonly path: readonly string[] };

export type ConfigurationEditPlan =
  | { readonly kind: "rejected"; readonly code: string }
  | {
      readonly kind: "planned";
      readonly text: string;
      readonly document: Record<string, unknown>;
      readonly changedPaths: readonly string[];
    };

/** Plans against the exact source. No parser recovery may become a saved document. */
export function planConfigurationEdits(
  source: string | null,
  operations: readonly ConfigurationDocumentEdit[],
): ConfigurationEditPlan {
  let text = source ?? serializeConfigurationDocument(createEmptyConfigurationDocument());
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIGURATION_FILE_BYTES) {
    return { kind: "rejected", code: "oversized" };
  }
  const scanner = createScanner(text, false);
  let depth = 0;
  while (scanner.scan() !== 17) {
    if (scanner.getToken() === 1 || scanner.getToken() === 3) depth++;
    if (scanner.getToken() === 2 || scanner.getToken() === 4) depth--;
    if (depth > 64) return { kind: "rejected", code: "document-too-deep" };
  }
  const parsed = parseJsonc(text);
  if (!parsed.ok) return { kind: "rejected", code: parsed.error.code };
  const root = parseTree(text, [], { allowTrailingComma: true });
  if (root !== undefined && (root.type !== "object" || ambiguous(root))) {
    return { kind: "rejected", code: "ambiguous-document" };
  }
  const changedPaths: string[] = [];
  try {
    for (const operation of operations) {
      if (operation.path.length === 0 || operation.path.some(unsafeSegment)) {
        return { kind: "rejected", code: "invalid-path" };
      }
      const before = text;
      if (parseTree(text) === undefined && operation.kind === "set") {
        // Keep a comment-only preamble, including a final line comment.
        text += `${text.endsWith("\n") || text.length === 0 ? "" : "\n"}${serializeConfigurationDocument(createEmptyConfigurationDocument())}`;
      }
      text = update(text, operation.path, operation.kind === "set" ? operation.value : undefined);
      if (text !== before) changedPaths.push(operation.path.join("."));
    }
  } catch {
    return { kind: "rejected", code: "invalid-edit" };
  }
  const candidate = parseJsonc(text);
  const candidateRoot = parseTree(text);
  if (candidateRoot !== undefined && ambiguous(candidateRoot))
    return { kind: "rejected", code: "ambiguous-candidate" };
  if (!candidate.ok || !record(candidate.value)) {
    // An untouched comment-only document is a valid empty layer.
    if (candidate.ok && candidate.value === undefined && changedPaths.length === 0) {
      return { kind: "planned", text, document: createEmptyConfigurationDocument(), changedPaths };
    }
    return { kind: "rejected", code: "invalid-candidate" };
  }
  if (new TextEncoder().encode(text).byteLength > MAX_CONFIGURATION_FILE_BYTES) {
    return { kind: "rejected", code: "oversized" };
  }
  if (source === null) text = serializeConfigurationDocument(candidate.value);
  return { kind: "planned", text, document: candidate.value, changedPaths };
}

function unsafeSegment(segment: string): boolean {
  return segment.length === 0 || ["__proto__", "prototype", "constructor"].includes(segment);
}

function ambiguous(node: Node, depth = 0): boolean {
  if (depth > 64) return true;
  if (node.type === "object") {
    const names = new Set<string>();
    for (const property of node.children ?? []) {
      const name: unknown = property.children?.[0]?.value;
      if (typeof name !== "string" || names.has(name) || unsafeSegment(name)) return true;
      names.add(name);
    }
  }
  return (node.children ?? []).some((child) => ambiguous(child, depth + 1));
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function update(text: string, path: readonly (string | number)[], value: unknown): string {
  const root = parseTree(text);
  const node = root === undefined ? undefined : findNodeAtLocation(root, [...path]);
  const old: unknown = node === undefined ? undefined : getNodeValue(node);
  if (JSON.stringify(old) === JSON.stringify(value)) return text;
  if (record(old) && record(value)) {
    for (const key of Object.keys(old)) {
      if (!Object.hasOwn(value, key)) text = update(text, [...path, key], undefined);
    }
    for (const [key, item] of Object.entries(value)) {
      if (unsafeSegment(key)) throw new Error("invalid-path");
      text = update(text, [...path, key], item);
    }
    return text;
  }
  if (Array.isArray(old) && Array.isArray(value)) {
    for (let index = old.length - 1; index >= value.length; index--) {
      text = update(text, [...path, index], undefined);
    }
    for (let index = 0; index < value.length; index++)
      text = update(text, [...path, index], value[index]);
    return text;
  }
  if (value === undefined) return node === undefined ? text : removeNode(text, node);
  const edits = modify(text, [...path], value, {});
  return applyEdits(
    text,
    edits.flatMap((edit) => preserveEdit(text, edit)),
  );
}

/** Remove owned syntax while retaining all comments and surrounding whitespace. */
function removeNode(text: string, node: Node): string {
  const owned = node.parent?.type === "property" ? node.parent : node;
  const parent = owned.parent;
  if (parent === undefined) throw new Error("invalid-removal");
  const end = owned.offset + owned.length;
  const scanner = createScanner(text, false);
  scanner.setPosition(end);
  let comma: number | null = null;
  while (scanner.scan() !== 17) {
    const token = scanner.getToken();
    if (token === 5) {
      comma = scanner.getTokenOffset();
      break;
    }
    if (token < 12 || token > 15) break;
  }
  if (comma === null) {
    const siblings = parent.children ?? [];
    const index = siblings.indexOf(owned);
    const previous = siblings[index - 1];
    if (previous !== undefined) {
      scanner.setPosition(previous.offset + previous.length);
      while (scanner.scan() !== 17 && scanner.getTokenOffset() < owned.offset) {
        if (scanner.getToken() === 5) {
          comma = scanner.getTokenOffset();
          break;
        }
      }
    }
  }
  const edits: Edit[] = [
    { offset: owned.offset, length: owned.length, content: trivia(text.slice(owned.offset, end)) },
  ];
  if (comma !== null) edits.push({ offset: comma, length: 1, content: "" });
  return applyEdits(text, edits);
}

function trivia(text: string): string {
  const scanner = createScanner(text, false);
  let result = "";
  while (scanner.scan() !== 17) {
    if (scanner.getToken() >= 12 && scanner.getToken() <= 15) {
      result += text.slice(
        scanner.getTokenOffset(),
        scanner.getTokenOffset() + scanner.getTokenLength(),
      );
    }
  }
  return result;
}

function preserveEdit(text: string, edit: Edit): readonly Edit[] {
  if (edit.length > 0) {
    const removed = text.slice(edit.offset, edit.offset + edit.length);
    const comments = trivia(removed);
    return [{ ...edit, content: `${comments}${edit.content}` }];
  }
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const unit = /(?:^|\n)([\t ]+)"/.exec(text)?.[1] ?? "  ";
  const multiline = text.includes("\n");
  if (!multiline) return [edit];
  const prefix = edit.content.startsWith(",") ? "," : "";
  const body = edit.content.slice(prefix.length);
  const scanner = createScanner(text, false);
  scanner.setPosition(edit.offset);
  let trailingComma = false;
  while (scanner.scan() !== 17) {
    const token = scanner.getToken();
    if (token === 5) {
      trailingComma = true;
      continue;
    }
    if (token >= 12 && token <= 15) continue;
    break;
  }
  if (scanner.getToken() !== 2 && scanner.getToken() !== 4) return [edit];
  const closing = scanner.getTokenOffset();
  const lineStart = text.lastIndexOf("\n", closing - 1) + 1;
  if (!/^[\t ]*$/.test(text.slice(lineStart, closing))) return [edit];
  const indentation = text.slice(lineStart, closing);
  const wrapper = scanner.getToken() === 4 ? `[${body}]` : `{${body}}`;
  const formatted = applyEdits(
    wrapper,
    format(wrapper, undefined, { insertSpaces: !unit.includes("\t"), tabSize: unit.length, eol }),
  );
  const content = formatted
    .slice(formatted.indexOf(eol) + eol.length, formatted.lastIndexOf(eol))
    .split(eol)
    .map((line) => `${indentation}${line}`)
    .join(eol);
  const edits: Edit[] = [
    { offset: lineStart, length: 0, content: `${content}${trailingComma ? "," : ""}${eol}` },
  ];
  if (prefix === "," && !trailingComma)
    edits.push({ offset: edit.offset, length: 0, content: "," });
  return edits;
}
