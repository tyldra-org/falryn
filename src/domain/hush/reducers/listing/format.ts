import { shortestText } from "../shared/text.ts";

const SAFE_PATH_COMPONENT = /^[A-Za-z0-9._+@,=~-]+$/u;

type PathTree = {
  readonly files: string[];
  readonly directories: Map<string, PathTree>;
};

export function formatPathListing(text: string, commandTokens: readonly string[]): string {
  const firstArgument = commandTokens[1];
  const root = firstArgument === undefined || firstArgument.startsWith("-") ? "." : firstArgument;
  const prefix = root === "." ? "./" : `${root.replace(/\/$/u, "")}/`;
  const lines = text.split("\n");
  if (text.endsWith("\n")) {
    lines.pop();
  }
  if (lines.length === 0 || lines.some((line) => line.length > 0 && !line.startsWith(prefix))) {
    return text;
  }
  const relative = lines.map((line) => (line.length === 0 ? line : line.slice(prefix.length)));
  const formatted = relative.join("\n");
  const compact = compactPathTree(relative, pathKind(commandTokens));
  return shortestText(text, formatted, compact ?? formatted);
}

function compactPathTree(paths: readonly string[], kind: string): string | null {
  const tree = createPathTree(paths);
  if (tree === null) {
    return null;
  }
  const candidates = [renderPathTree(tree, paths.length, kind, null)];
  const extension = sharedFileExtension(paths);
  if (extension !== null) {
    candidates.push(renderPathTree(tree, paths.length, kind, extension));
  }
  return shortestText(...candidates);
}

function createPathTree(paths: readonly string[]): PathTree | null {
  const root = pathTree();
  for (const path of paths) {
    const components = path.split("/");
    if (
      components.length === 0 ||
      components.some(
        (component) =>
          component.length === 0 ||
          component === "." ||
          component === ".." ||
          !SAFE_PATH_COMPONENT.test(component),
      )
    ) {
      return null;
    }
    const file = components.pop();
    if (file === undefined) {
      return null;
    }
    let node = root;
    for (const directory of components) {
      let child = node.directories.get(directory);
      if (child === undefined) {
        child = pathTree();
        node.directories.set(directory, child);
      }
      node = child;
    }
    node.files.push(file);
  }
  return root;
}

function pathTree(): PathTree {
  return { files: [], directories: new Map() };
}

function renderPathTree(
  tree: PathTree,
  count: number,
  kind: string,
  sharedExtension: string | null,
): string {
  const lines = [`${count} ${kind}${sharedExtension === null ? "" : ` (*${sharedExtension})`}`];
  renderPathTreeNode(tree, ".", 0, sharedExtension, lines);
  return lines.join("\n");
}

function renderPathTreeNode(
  tree: PathTree,
  name: string,
  depth: number,
  sharedExtension: string | null,
  lines: string[],
): void {
  const files = tree.files
    .map((file) => (sharedExtension === null ? file : file.slice(0, -sharedExtension.length)))
    .sort(compareText);
  const indent = depth === 0 ? "" : " ".repeat(depth - 1);
  const label = depth === 0 ? "./" : `${name}/`;
  lines.push(`${indent}${label}${files.length === 0 ? "" : ` ${files.join(" ")}`}`);
  for (const [directory, child] of [...tree.directories].sort(([left], [right]) =>
    compareText(left, right),
  )) {
    renderPathTreeNode(child, directory, depth + 1, sharedExtension, lines);
  }
}

function sharedFileExtension(paths: readonly string[]): string | null {
  let shared: string | null = null;
  for (const path of paths) {
    const file = path.split("/").at(-1) ?? "";
    const separator = file.lastIndexOf(".");
    if (separator <= 0 || separator === file.length - 1) {
      return null;
    }
    const extension = file.slice(separator);
    if (shared !== null && extension !== shared) {
      return null;
    }
    shared = extension;
  }
  return shared;
}

function pathKind(commandTokens: readonly string[]): string {
  const typeIndex = commandTokens.indexOf("-type");
  const type = typeIndex < 0 ? undefined : commandTokens[typeIndex + 1];
  switch (type) {
    case "f":
      return "files";
    case "d":
      return "dirs";
    case "l":
      return "links";
    default:
      return "paths";
  }
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
