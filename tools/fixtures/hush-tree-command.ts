#!/usr/bin/env bun

/** Deterministic native-tree stand-in used by the Hush-vs-RTK scorecard. */

type FixtureNode = Readonly<{
  name: string;
  children: readonly FixtureNode[] | null;
}>;

function file(name: string): FixtureNode {
  return { name, children: null };
}

function directory(name: string, children: readonly FixtureNode[]): FixtureNode {
  return { name, children };
}

const FIXTURE = directory("falryn", [
  file("AGENTS.md"),
  file("README.md"),
  file("package.json"),
  file("tsconfig.json"),
  file(".env"),
  file(".DS_Store"),
  directory(".git", [directory("objects", [file("pack-a"), file("pack-b")])]),
  directory(".cache", [file("state.bin")]),
  directory("node_modules", [
    directory("react", [file("index.js"), file("package.json")]),
    directory("zod", [file("index.js"), file("package.json")]),
  ]),
  directory("dist", [file("falryn")]),
  directory("build", [file("scratch.o")]),
  directory("coverage", [file("lcov.info")]),
  directory("vendor", [file("NOTICE"), file("library.ts")]),
  directory("src", [
    directory("application", [
      file("hush.test.ts"),
      file("hush.ts"),
      file("product-hush-projection.test.ts"),
      file("product-hush-projection.ts"),
    ]),
    directory("domain", [
      file("hush-catalog.test.ts"),
      file("hush.test.ts"),
      file("hush.ts"),
      directory("hush", [
        file("bounds.ts"),
        file("classification.ts"),
        file("command-shape.ts"),
        file("contracts.ts"),
        directory("catalog", [
          file("contracts.ts"),
          file("files.ts"),
          file("index.ts"),
          file("javascript.ts"),
          file("languages.ts"),
          file("operations.ts"),
          file("version-control.ts"),
        ]),
        directory("reducers", [
          file("git.ts"),
          file("index.ts"),
          file("listing.ts"),
          file("semantic.ts"),
          directory("ls", [
            file("block-format.ts"),
            file("format.test.ts"),
            file("long-format.ts"),
            file("projection.ts"),
          ]),
          directory("tree", [
            file("format.test.ts"),
            file("format.ts"),
            file("policy.ts"),
            file("projection.ts"),
          ]),
        ]),
      ]),
    ]),
    directory("integrations", [
      file("host-process-capture.test.ts"),
      file("host-process-capture.ts"),
    ]),
    file("main.ts"),
  ]),
  directory("tools", [
    file("hush-command-coverage.ts"),
    file("hush-ls-scorecard.test.ts"),
    file("hush-ls-scorecard.ts"),
    file("hush-tree-scorecard.test.ts"),
    file("hush-tree-scorecard.ts"),
  ]),
]);

const args = process.argv.slice(2);
const showAll = args.some((arg) => arg === "-a" || arg === "--all");
const directoriesOnly = args.includes("-d");
const fullPath = args.includes("-f");
const permissions = args.includes("-p");
const classify = args.includes("-F");
const ascii = args.some(
  (arg, index) => arg === "--charset=ASCII" || (arg === "--charset" && args[index + 1] === "ASCII"),
);
const maximumDepth = optionValue(args, "-L");
const ignored = ignorePatterns(args);
const empty = args.includes("empty");
const report = !args.includes("--noreport");

const root = empty ? directory("empty", []) : FIXTURE;
const lines = [root.name];
let directories = 0;
let files = 0;
renderChildren(root, "", root.name, 1);
if (report) {
  lines.push("", `${directories} directories, ${files} files`);
}
console.log(lines.join("\n"));

function renderChildren(node: FixtureNode, prefix: string, path: string, depth: number): void {
  if (node.children === null || (maximumDepth !== null && depth > maximumDepth)) {
    return;
  }
  const children = node.children.filter(visible);
  for (const [index, child] of children.entries()) {
    const last = index === children.length - 1;
    const childPath = `${path}/${child.name}`;
    const displayedName = fullPath ? childPath : child.name;
    const classifiedName =
      classify && child.children !== null ? `${displayedName}/` : displayedName;
    const metadata = permissions
      ? `[${child.children === null ? "-rw-r--r--" : "drwxr-xr-x"}]  `
      : "";
    lines.push(`${prefix}${connectorFor(last)}${metadata}${classifiedName}`);
    if (child.children === null) {
      files += 1;
    } else {
      directories += 1;
      renderChildren(child, `${prefix}${continuationFor(last)}`, childPath, depth + 1);
    }
  }
}

function connectorFor(last: boolean): string {
  if (ascii) {
    return last ? "`-- " : "|-- ";
  }
  return last ? "└── " : "├── ";
}

function continuationFor(last: boolean): string {
  if (ascii) {
    return last ? "    " : "|   ";
  }
  return last ? "    " : "│   ";
}

function visible(node: FixtureNode): boolean {
  if (!showAll && node.name.startsWith(".")) {
    return false;
  }
  if (directoriesOnly && node.children === null) {
    return false;
  }
  return !ignored.some((pattern) => matchesIgnore(node.name, pattern));
}

function matchesIgnore(name: string, pattern: string): boolean {
  if (pattern.startsWith("*") && pattern.length > 1) {
    return name.endsWith(pattern.slice(1));
  }
  return name === pattern;
}

function ignorePatterns(values: readonly string[]): readonly string[] {
  for (let index = 0; index < values.length; index += 1) {
    const value = values[index] ?? "";
    if (value === "-I") {
      return (values[index + 1] ?? "").split("|").filter(Boolean);
    }
    if (value.startsWith("--ignore=")) {
      return value.slice("--ignore=".length).split("|").filter(Boolean);
    }
  }
  return [];
}

function optionValue(values: readonly string[], option: string): number | null {
  const index = values.indexOf(option);
  if (index === -1) {
    return null;
  }
  const parsed = Number(values[index + 1]);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}
