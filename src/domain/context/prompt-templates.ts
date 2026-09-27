/**
 * Package prompt templates (#138): the one bounded codec for template source,
 * slash invocation text, argument splitting and rendering.
 *
 * Pure. Argument and default text is inserted verbatim in one pass and is
 * never evaluated as shell, code, frontmatter or another template.
 */
import { isAlias, isMap, isScalar, isSeq, parseDocument } from "yaml";
import { err, ok, type Result } from "../foundation/result.ts";

const KIB = 1024;
/** Hard ceilings. A caller may apply narrower limits; nothing can widen these. */
export const PROMPT_TEMPLATE_LIMITS = {
  templatesPerPackage: 128,
  sourceBytes: 72 * KIB,
  frontmatterBytes: 8 * KIB,
  bodyBytes: 64 * KIB,
  yamlDepth: 8,
  frontmatterKeys: 64,
  keyBytes: 128,
  descriptionBytes: 512,
  hintBytes: 256,
  arguments: 64,
  argumentTextBytes: 16 * KIB,
  argumentBytes: 4 * KIB,
  substitutions: 1_024,
  renderedBytes: 128 * KIB,
} as const;

const MAX_PLACEHOLDER_NUMBER = 2_147_483_647;
const DESCRIPTION_SCALARS = 60;

const MESSAGES = {
  "invalid-utf8": "the template is not valid UTF-8",
  "source-limit": "the template file exceeds 72 KiB",
  "frontmatter-unclosed": "the template frontmatter has no closing --- line",
  "frontmatter-limit": "the template frontmatter exceeds 8 KiB",
  "frontmatter-invalid":
    "the template frontmatter must be a plain YAML mapping without aliases, anchors, merges, custom tags or non-JSON values",
  "frontmatter-depth": "the template frontmatter nests deeper than 8 levels",
  "frontmatter-key-count": "the template frontmatter has more than 64 keys",
  "frontmatter-key-limit": "a template frontmatter key exceeds 128 bytes",
  "description-limit": "the template description exceeds 512 bytes",
  "hint-limit": "the template argument hint exceeds 256 bytes",
  "body-limit": "the template body exceeds 64 KiB",
  "unterminated-quote": "an argument quote is not closed",
  "argument-count": "more than 64 arguments were given",
  "argument-text-limit": "the argument text exceeds 16 KiB",
  "argument-limit": "an argument exceeds 4 KiB",
  "zero-position": "the template uses position 0; positions start at 1",
  "numeric-overflow": "a template position or length exceeds 2147483647",
  "malformed-placeholder": "the template has an unsupported or unclosed placeholder",
  "substitution-limit": "the template makes more than 1,024 substitutions",
  "rendered-limit": "the expanded text exceeds 128 KiB",
} as const;

export type PromptTemplateErrorCode = keyof typeof MESSAGES;
export type PromptTemplateError = {
  readonly code: PromptTemplateErrorCode;
  readonly message: string;
};

/** Parsed, bounded template source. The body is rendered only on explicit invocation. */
export type PromptTemplateSource = {
  /** Inert JSON-compatible metadata; unknown keys never affect rendering or authority. */
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly body: string;
  readonly description: string;
  readonly argumentHint: string | null;
};

export type RenderedPromptTemplate = {
  readonly text: string;
  readonly argumentCount: number;
  readonly substitutions: number;
  readonly renderedBytes: number;
};

/** Slash text that names a template: /<alias> or /<package>:<alias>, then argument text. */
export type PromptInvocation = {
  readonly name: string;
  readonly argumentText: string;
};

function failure(code: PromptTemplateErrorCode): { ok: false; error: PromptTemplateError } {
  return err({ code, message: MESSAGES[code] });
}

function utf8Bytes(text: string): number {
  let bytes = 0;
  for (const char of text) {
    const point = char.codePointAt(0) ?? 0;
    bytes += point < 0x80 ? 1 : point < 0x800 ? 2 : point < 0x10000 ? 3 : 4;
  }
  return bytes;
}

const decoder = new TextDecoder("utf-8", { fatal: true });
const CORE_TAGS = new Set(
  ["str", "int", "float", "bool", "null", "map", "seq"].map((tag) => "tag:yaml.org,2002:" + tag),
);

/**
 * Decode template bytes: strict UTF-8, one optional BOM, CR/CRLF normalized to
 * LF, and frontmatter only between exact opening and closing --- lines.
 */
export function parsePromptTemplateSource(
  bytes: Uint8Array,
): Result<PromptTemplateSource, PromptTemplateError> {
  if (bytes.byteLength > PROMPT_TEMPLATE_LIMITS.sourceBytes) return failure("source-limit");
  let text: string;
  try {
    // The WHATWG decoder removes exactly one leading BOM.
    text = decoder.decode(bytes).replace(/\r\n?/gu, "\n");
  } catch {
    return failure("invalid-utf8");
  }
  if (text !== "---" && !text.startsWith("---\n")) return source({}, text);
  let close = -1;
  for (let from = 3; close < 0; ) {
    const found = text.indexOf("\n---", from);
    if (found < 0) return failure("frontmatter-unclosed");
    const after = text[found + 4];
    if (after === undefined || after === "\n") close = found;
    else from = found + 1;
  }
  const content = close > 4 ? text.slice(4, close) : "";
  if (utf8Bytes(content) > PROMPT_TEMPLATE_LIMITS.frontmatterBytes)
    return failure("frontmatter-limit");
  const frontmatter = parseFrontmatter(content);
  if (!frontmatter.ok) return frontmatter;
  return source(frontmatter.value, text.slice(close + 5).trim());
}

function source(
  frontmatter: Readonly<Record<string, unknown>>,
  body: string,
): Result<PromptTemplateSource, PromptTemplateError> {
  const description = frontmatter.description;
  const hint = frontmatter["argument-hint"];
  if (
    (description !== undefined && typeof description !== "string") ||
    (hint !== undefined && typeof hint !== "string")
  )
    return failure("frontmatter-invalid");
  if (description !== undefined && utf8Bytes(description) > PROMPT_TEMPLATE_LIMITS.descriptionBytes)
    return failure("description-limit");
  if (hint !== undefined && utf8Bytes(hint) > PROMPT_TEMPLATE_LIMITS.hintBytes)
    return failure("hint-limit");
  if (utf8Bytes(body) > PROMPT_TEMPLATE_LIMITS.bodyBytes) return failure("body-limit");
  return ok({
    frontmatter,
    body,
    description: description === undefined || description === "" ? derived(body) : description,
    argumentHint: hint === undefined || hint === "" ? null : hint,
  });
}

/** First non-empty body line, at most 60 Unicode scalar values plus "..." when cut. */
function derived(body: string): string {
  for (const line of body.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const scalars = Array.from(trimmed);
    return scalars.length > DESCRIPTION_SCALARS
      ? scalars.slice(0, DESCRIPTION_SCALARS).join("") + "..."
      : trimmed;
  }
  return "";
}

function parseFrontmatter(
  content: string,
): Result<Readonly<Record<string, unknown>>, PromptTemplateError> {
  const document = parseDocument(content, {
    version: "1.2",
    schema: "core",
    strict: true,
    uniqueKeys: true,
    merge: false,
    prettyErrors: false,
    logLevel: "silent",
  });
  if (document.errors.length > 0 || document.warnings.length > 0)
    return failure("frontmatter-invalid");
  if (document.contents === null) return ok({});
  if (!isMap(document.contents)) return failure("frontmatter-invalid");
  const keys = { count: 0 };
  const invalid = inspectNode(document.contents, 1, keys);
  if (invalid !== null) return failure(invalid);
  return ok(document.toJS() as Record<string, unknown>);
}

function inspectNode(
  node: unknown,
  depth: number,
  keys: { count: number },
): PromptTemplateErrorCode | null {
  if (node === null) return null;
  if (isAlias(node)) return "frontmatter-invalid";
  if (isScalar(node) || isMap(node) || isSeq(node)) {
    if (node.anchor !== undefined || (node.tag !== undefined && !CORE_TAGS.has(node.tag)))
      return "frontmatter-invalid";
  } else return "frontmatter-invalid";
  if (isScalar(node)) {
    const value = node.value;
    if (value === null || typeof value === "string" || typeof value === "boolean") return null;
    return typeof value === "number" && Number.isFinite(value) ? null : "frontmatter-invalid";
  }
  if (depth > PROMPT_TEMPLATE_LIMITS.yamlDepth) return "frontmatter-depth";
  if (isSeq(node)) {
    for (const item of node.items) {
      const invalid = inspectNode(item, depth + 1, keys);
      if (invalid !== null) return invalid;
    }
    return null;
  }
  for (const pair of node.items) {
    const key = pair.key;
    if (!isScalar(key) || typeof key.value !== "string" || key.value === "<<")
      return "frontmatter-invalid";
    if (key.anchor !== undefined || (key.tag !== undefined && !CORE_TAGS.has(key.tag)))
      return "frontmatter-invalid";
    keys.count += 1;
    if (keys.count > PROMPT_TEMPLATE_LIMITS.frontmatterKeys) return "frontmatter-key-count";
    if (utf8Bytes(key.value) > PROMPT_TEMPLATE_LIMITS.keyBytes) return "frontmatter-key-limit";
    const invalid = inspectNode(pair.value, depth + 1, keys);
    if (invalid !== null) return invalid;
  }
  return null;
}

const WHITESPACE = /^\p{White_Space}$/u;

/**
 * Split invocation text on Unicode whitespace outside single or double quotes.
 * Quotes are removed, adjacent segments join, empty quote-only segments create
 * no argument, and backslash is an ordinary character.
 */
export function splitPromptArguments(text: string): Result<readonly string[], PromptTemplateError> {
  if (utf8Bytes(text) > PROMPT_TEMPLATE_LIMITS.argumentTextBytes)
    return failure("argument-text-limit");
  const values: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of text) {
    if (quote !== null) {
      if (char === quote) quote = null;
      else current += char;
    } else if (char === '"' || char === "'") quote = char;
    else if (WHITESPACE.test(char)) {
      if (current !== "") values.push(current);
      current = "";
    } else current += char;
  }
  if (quote !== null) return failure("unterminated-quote");
  if (current !== "") values.push(current);
  if (values.length > PROMPT_TEMPLATE_LIMITS.arguments) return failure("argument-count");
  if (values.some((value) => utf8Bytes(value) > PROMPT_TEMPLATE_LIMITS.argumentBytes))
    return failure("argument-limit");
  return ok(values);
}

type Placeholder = { readonly text: string; readonly end: number };
const DIGITS = /[0-9]+/y;
const POSITION_DEFAULT = /^([0-9]+):-([\s\S]*)$/u;
const ALL_DEFAULT = /^(?:@|ARGUMENTS):-([\s\S]*)$/u;
const SLICE = /^@:([0-9]+)(?::([0-9]+))?$/u;

function decimal(digits: string): number | null {
  const significant = digits.replace(/^0+/u, "");
  if (significant.length > 10) return null;
  const value = Number(significant === "" ? "0" : significant);
  return value > MAX_PLACEHOLDER_NUMBER ? null : value;
}

function position(digits: string): Result<number, PromptTemplateError> {
  const value = decimal(digits);
  if (value === null) return failure("numeric-overflow");
  return value === 0 ? failure("zero-position") : ok(value);
}

function placeholder(
  body: string,
  at: number,
  values: readonly string[],
): Result<Placeholder | null, PromptTemplateError> {
  const all = values.join(" ");
  if (body[at + 1] === "{") {
    const close = body.indexOf("}", at + 2);
    if (close < 0) return failure("malformed-placeholder");
    const inner = body.slice(at + 2, close);
    const end = close + 1;
    const positional = POSITION_DEFAULT.exec(inner);
    if (positional !== null) {
      const index = position(positional[1] ?? "");
      if (!index.ok) return index;
      const value = values[index.value - 1] ?? "";
      return ok({ text: value === "" ? (positional[2] ?? "") : value, end });
    }
    const fallback = ALL_DEFAULT.exec(inner);
    if (fallback !== null) return ok({ text: all === "" ? (fallback[1] ?? "") : all, end });
    const slice = SLICE.exec(inner);
    if (slice === null) return failure("malformed-placeholder");
    const start = position(slice[1] ?? "");
    if (!start.ok) return start;
    const length = slice[2] === undefined ? null : decimal(slice[2]);
    if (slice[2] !== undefined && length === null) return failure("numeric-overflow");
    if (start.value > values.length) return ok({ text: "", end });
    const available = values.length - (start.value - 1);
    const count = length === null ? available : Math.min(length, available);
    return ok({ text: values.slice(start.value - 1, start.value - 1 + count).join(" "), end });
  }
  if (body.startsWith("ARGUMENTS", at + 1)) return ok({ text: all, end: at + 10 });
  if (body[at + 1] === "@") return ok({ text: all, end: at + 2 });
  DIGITS.lastIndex = at + 1;
  const digits = DIGITS.exec(body);
  if (digits === null) return ok(null);
  const index = position(digits[0]);
  if (!index.ok) return index;
  return ok({ text: values[index.value - 1] ?? "", end: at + 1 + digits[0].length });
}

/** Substitute placeholders left to right in one non-recursive pass. */
export function renderPromptTemplate(
  body: string,
  values: readonly string[],
): Result<RenderedPromptTemplate, PromptTemplateError> {
  const parts: string[] = [];
  let bytes = 0;
  let substitutions = 0;
  let literal = 0;
  let index = 0;
  const emit = (text: string): boolean => {
    bytes += utf8Bytes(text);
    parts.push(text);
    return bytes <= PROMPT_TEMPLATE_LIMITS.renderedBytes;
  };
  for (;;) {
    const at = body.indexOf("$", index);
    if (at < 0) break;
    const matched = placeholder(body, at, values);
    if (!matched.ok) return matched;
    if (matched.value === null) {
      index = at + 1;
      continue;
    }
    substitutions += 1;
    if (substitutions > PROMPT_TEMPLATE_LIMITS.substitutions) return failure("substitution-limit");
    if (!emit(body.slice(literal, at)) || !emit(matched.value.text))
      return failure("rendered-limit");
    literal = index = matched.value.end;
  }
  if (!emit(body.slice(literal))) return failure("rendered-limit");
  return ok({
    text: parts.join(""),
    argumentCount: values.length,
    substitutions,
    renderedBytes: bytes,
  });
}

/** Split invocation arguments, then render the parsed template body. */
export function expandPromptTemplate(
  template: PromptTemplateSource,
  argumentText: string,
): Result<RenderedPromptTemplate, PromptTemplateError> {
  const values = splitPromptArguments(argumentText);
  return values.ok ? renderPromptTemplate(template.body, values.value) : values;
}

const INVOCATION = /^\/([^\p{White_Space}]+)(?:\p{White_Space}([\s\S]*))?$/u;
const ALIAS = /^[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;

/** Whether a template short alias can be typed as a slash name. */
export function isPromptAlias(value: string): boolean {
  return ALIAS.test(value);
}

/**
 * Read slash text as a template invocation, or null when it does not name one.
 * Paths such as /usr/bin are not template names.
 */
export function parsePromptInvocation(text: string): PromptInvocation | null {
  const matched = INVOCATION.exec(text.trimStart());
  const name = matched?.[1];
  if (matched === null || name === undefined) return null;
  const separator = name.lastIndexOf(":");
  if (separator === 0 || !ALIAS.test(name.slice(separator + 1))) return null;
  return { name, argumentText: matched[2] ?? "" };
}
