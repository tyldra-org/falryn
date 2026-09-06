import type {
  PdfCoordinate,
  PdfReadError,
  PdfReadLimits,
} from "../../../domain/documents/index.ts";
import type { Result } from "../../../domain/foundation/index.ts";
import { latin1 } from "./bytes.ts";
import type { PageDefinition, ParsedPdf, PdfObject } from "./contracts.ts";

export function objectDictionary(object: PdfObject): string {
  const start = object.body.indexOf("<<");
  const end = object.body.lastIndexOf(">>");
  return start >= 0 && end > start ? object.body.slice(start, end + 2) : object.body;
}

export function objectType(dictionary: string): string | null {
  return /\/Type\s*\/([A-Za-z0-9]+)/.exec(dictionary)?.[1] ?? null;
}

function referenceAfter(dictionary: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dictionary);
  const number = match?.[1];
  return number === undefined ? null : Number(number);
}

function referencesAfter(dictionary: string, name: string): readonly number[] {
  const array = new RegExp(`/${name}\\s*\\[([\\s\\S]*?)\\]`).exec(dictionary)?.[1];
  if (array === undefined) {
    return [];
  }
  return [...array.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

function allReferences(value: string): readonly number[] {
  return [...value.matchAll(/(\d+)\s+\d+\s+R/g)].map((match) => Number(match[1]));
}

export function directNumber(dictionary: string, name: string): number | null {
  const match = new RegExp(`/${name}\\s+(-?\\d+(?:\\.\\d+)?)\\b`).exec(dictionary);
  const value = match?.[1];
  return value === undefined ? null : Number(value);
}

export function directName(dictionary: string, name: string): string | null {
  return new RegExp(`/${name}\\s*(?:\\[\\s*)?/([A-Za-z0-9+.-]+)`).exec(dictionary)?.[1] ?? null;
}

function inlineDictionary(dictionary: string, name: string): string | null {
  return new RegExp(`/${name}\\s*(<<[\\s\\S]*?>>)`).exec(dictionary)?.[1] ?? null;
}

export function coordinate(page: PageDefinition, object: PdfObject | null): PdfCoordinate {
  return {
    pageNumber: page.pageNumber,
    objectNumber: object?.number ?? page.object.number,
    byteOffset: object?.byteOffset ?? page.object.byteOffset,
  };
}

function parseObjects(
  source: string,
  maximumObjects: number,
): Result<ReadonlyMap<number, PdfObject>, PdfReadError> {
  const objects = new Map<number, PdfObject>();
  const pattern = /(\d+)\s+(\d+)\s+obj\b/g;
  while (true) {
    const match = pattern.exec(source);
    if (match === null) {
      break;
    }
    if (objects.size >= maximumObjects) {
      return {
        ok: false,
        error: { code: "object-limit", count: objects.size + 1, maximum: maximumObjects },
      };
    }
    const number = Number(match[1]);
    const generation = Number(match[2]);
    const bodyStart = match.index + match[0].length;
    const bodyEnd = source.indexOf("endobj", bodyStart);
    if (bodyEnd < 0 || objects.has(number)) {
      return { ok: false, error: { code: "malformed-objects" } };
    }
    objects.set(number, {
      number,
      generation,
      byteOffset: match.index,
      body: source.slice(bodyStart, bodyEnd),
    });
    pattern.lastIndex = bodyEnd + "endobj".length;
  }
  return objects.size === 0
    ? { ok: false, error: { code: "malformed-objects" } }
    : { ok: true, value: objects };
}

function resourceBodyFor(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
  inherited: string,
): string {
  const resourceObject = referenceAfter(dictionary, "Resources");
  if (resourceObject !== null) {
    const object = objects.get(resourceObject);
    if (object !== undefined) {
      return objectDictionary(object);
    }
  }
  return inlineDictionary(dictionary, "Resources") ?? inherited;
}

function pageContentObjects(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
): readonly PdfObject[] {
  const references = [
    ...referencesAfter(dictionary, "Contents"),
    ...(referenceAfter(dictionary, "Contents") === null
      ? []
      : [referenceAfter(dictionary, "Contents") as number]),
  ];
  return references.flatMap((number) => {
    const object = objects.get(number);
    return object === undefined ? [] : [object];
  });
}

function pageAnnotationObjects(
  dictionary: string,
  objects: ReadonlyMap<number, PdfObject>,
): readonly PdfObject[] {
  const references = [
    ...referencesAfter(dictionary, "Annots"),
    ...(referenceAfter(dictionary, "Annots") === null
      ? []
      : [referenceAfter(dictionary, "Annots") as number]),
  ];
  return references.flatMap((number) => {
    const object = objects.get(number);
    if (object === undefined) {
      return [];
    }
    const nested = allReferences(object.body);
    return nested.length > 0 ? nested.flatMap((item) => objects.get(item) ?? []) : [object];
  });
}

function parsePages(
  objects: ReadonlyMap<number, PdfObject>,
): Result<readonly PageDefinition[], PdfReadError> {
  const pages: PageDefinition[] = [];
  const visited = new Set<number>();
  const catalogs = [...objects.values()].filter(
    (object) => objectType(objectDictionary(object)) === "Catalog",
  );
  const catalog = catalogs[0];
  const root = catalog === undefined ? null : referenceAfter(objectDictionary(catalog), "Pages");

  const visit = (number: number, inheritedResources: string): boolean => {
    if (visited.has(number)) {
      return false;
    }
    visited.add(number);
    const object = objects.get(number);
    if (object === undefined) {
      return false;
    }
    const dictionary = objectDictionary(object);
    const type = objectType(dictionary);
    const resources = resourceBodyFor(dictionary, objects, inheritedResources);
    if (type === "Page") {
      pages.push({
        pageNumber: pages.length + 1,
        object,
        contentObjects: pageContentObjects(dictionary, objects),
        annotationObjects: pageAnnotationObjects(dictionary, objects),
        resourceBody: resources,
      });
      return true;
    }
    if (type !== "Pages") {
      return false;
    }
    const kids = referencesAfter(dictionary, "Kids");
    if (kids.length === 0 && directNumber(dictionary, "Count") !== 0) {
      return false;
    }
    let found = true;
    for (const child of kids) {
      found = visit(child, resources) && found;
    }
    return found;
  };

  if (root !== null) {
    visit(root, "");
  }
  if (pages.length === 0) {
    for (const object of [...objects.values()].sort((left, right) => left.number - right.number)) {
      if (objectType(objectDictionary(object)) === "Page") {
        visit(object.number, "");
      }
    }
  }
  return pages.length === 0
    ? { ok: false, error: { code: "malformed-pages" } }
    : { ok: true, value: pages };
}

export function parsePdf(
  bytes: Uint8Array,
  limits: PdfReadLimits,
): Result<ParsedPdf, PdfReadError> {
  const source = latin1(bytes);
  const header = /%PDF-(\d+)\.(\d+)/.exec(source.slice(0, 64));
  if (header === null) {
    return source.includes("%PDF-")
      ? { ok: false, error: { code: "malformed-header" } }
      : { ok: false, error: { code: "not-pdf" } };
  }
  const major = Number(header[1]);
  const minor = Number(header[2]);
  if (major !== 1 || minor > 7) {
    return { ok: false, error: { code: "unsupported-version", major, minor } };
  }
  if (/\/Encrypt\b/.test(source)) {
    return { ok: false, error: { code: "encrypted" } };
  }
  const objects = parseObjects(source, limits.maxObjects);
  if (!objects.ok) {
    return objects;
  }
  const pages = parsePages(objects.value);
  if (!pages.ok) {
    return pages;
  }
  return {
    ok: true,
    value: {
      bytes,
      format: { major, minor },
      objects: objects.value,
      pages: pages.value,
    },
  };
}
