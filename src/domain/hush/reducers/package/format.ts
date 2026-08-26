import type { PackageExecutable } from "../../package-command.ts";
import { compactDuplicateRuns, shortestText, stripAnsi } from "../../text-format.ts";
import {
  type EcosystemPackageExecutable,
  formatEcosystemPackageInstall,
  formatEcosystemPackageList,
  formatEcosystemPackageOutdated,
} from "./ecosystem.ts";
import {
  formatPythonPackageInstall,
  formatPythonPackageList,
  formatPythonPackageOutdated,
  formatPythonPackageShow,
  type PythonPackageExecutable,
} from "./python.ts";

type PackageGroup = "prod" | "dev" | "optional" | "peer";

const SECTION_NAMES: Readonly<Record<string, PackageGroup>> = {
  "dependencies:": "prod",
  "devdependencies:": "dev",
  "optionaldependencies:": "optional",
  "peerdependencies:": "peer",
};

export function formatPackageInstall(executable: PackageExecutable, text: string): string | null {
  switch (executable) {
    case "npm":
      return formatNpmInstall(text);
    case "pnpm":
      return formatPnpmInstall(text);
    case "yarn":
      return formatYarnInstall(text);
    case "bun":
      return formatBunInstall(text);
    case "pip":
    case "pip3":
    case "uv":
    case "poetry":
      return formatPythonPackageInstall(executable, text);
    case "brew":
    case "composer":
    case "bundle":
      return formatEcosystemPackageInstall(executable, text);
    case "npx":
    case "pnpx":
      return null;
  }
}

export function formatPackageList(executable: PackageExecutable, text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  if (plain.length === 0) {
    return null;
  }
  if (executable === "pnpm") {
    return formatPnpmList(plain);
  }
  if (executable === "npm") {
    return formatDependencyTree(plain, false);
  }
  if (executable === "yarn") {
    return formatDependencyTree(plain, true);
  }
  if (isPythonPackageExecutable(executable)) {
    return formatPythonPackageList(executable, plain);
  }
  if (isEcosystemPackageExecutable(executable)) {
    return formatEcosystemPackageList(executable, plain);
  }
  return null;
}

export function formatPackageOutdated(executable: PackageExecutable, text: string): string | null {
  if (isPythonPackageExecutable(executable)) {
    return formatPythonPackageOutdated(text);
  }
  if (isEcosystemPackageExecutable(executable)) {
    return formatEcosystemPackageOutdated(executable, text);
  }
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) {
    return null;
  }
  const rows = lines.map((line) => line.trim().split(/\s{2,}/u));
  const header = rows[0];
  const columns = header?.length ?? 0;
  if (columns < 4 || rows.some((row) => row.length !== columns)) {
    return null;
  }
  const normalized = header?.map((cell) => cell.toLowerCase()) ?? [];
  if (!["package", "current", "wanted", "latest"].every((name) => normalized.includes(name))) {
    return null;
  }
  const packageIndex = normalized.indexOf("package");
  const currentIndex = normalized.indexOf("current");
  const wantedIndex = normalized.indexOf("wanted");
  const latestIndex = normalized.indexOf("latest");
  const typeIndex = normalized.indexOf("package type");
  const usedByIndex = normalized.indexOf("depended by");
  const data = rows.slice(1);
  const commonType = commonCell(data, typeIndex);
  const commonOwner = commonCell(data, usedByIndex);
  const formatted = [
    "current>wanted>latest",
    ...data.map((row) => {
      const type =
        typeIndex < 0
          ? ""
          : commonType === null
            ? packageType(row[typeIndex] ?? "")
            : packageType(commonType);
      const owner = usedByIndex < 0 || commonOwner !== null ? "" : ` @${row[usedByIndex] ?? ""}`;
      return `${type}${row[packageIndex]} ${row[currentIndex]}>${row[wantedIndex]}>${row[latestIndex]}${owner}`;
    }),
  ].join("\n");
  return shortestText(plain, formatted);
}

export function formatPackageShow(executable: PackageExecutable, text: string): string | null {
  return executable === "pip" || executable === "pip3" ? formatPythonPackageShow(text) : null;
}

export function formatPackageScript(executable: PackageExecutable, text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  let changed = false;

  if (executable === "npm" || executable === "pnpm") {
    const banner = firstNonblankLine(lines);
    const validBanner = /^>\s+\S+@\S+\s+\S+(?:\s+\S+)?$/u.test(lines[banner] ?? "");
    if (validBanner) {
      lines.splice(banner, 1);
      changed = true;
      const command = lines[banner];
      if (command !== undefined && /^>\s+\S/u.test(command)) {
        lines[banner] = command.replace(/^>\s+/u, "");
      }
    }
  } else if (executable === "yarn") {
    const banner = firstNonblankLine(lines);
    const validBanner = /^yarn run v\S+$/u.test(lines[banner] ?? "");
    if (validBanner) {
      lines.splice(banner, 1);
      changed = true;
      const command = firstNonblankLine(lines, banner);
      if (/^\$\s+\S/u.test(lines[command] ?? "")) {
        lines[command] = (lines[command] ?? "").replace(/^\$\s+/u, "");
      }
      const done = lines.findIndex((line) => /^Done in \S+\.?$/u.test(line));
      if (done >= 0) {
        lines.splice(done, 1);
      }
    }
  } else if (executable === "bun") {
    const banner = firstNonblankLine(lines);
    if (/^\$\s+\S/u.test(lines[banner] ?? "")) {
      lines[banner] = (lines[banner] ?? "").replace(/^\$\s+/u, "");
      changed = true;
    }
  }

  trimOuterBlankLines(lines);
  const formatted = compactDuplicateRuns(lines.join("\n"));
  if (!changed && formatted === plain) {
    return null;
  }
  return shortestText(plain, formatted);
}

export function formatPackageRunner(text: string): string {
  const plain = stripAnsi(text).trimEnd();
  return shortestText(text, plain, compactDuplicateRuns(plain));
}

function formatNpmInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const result: string[] = [];
  let changed = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (line.length === 0) {
      changed = true;
      continue;
    }
    const summary = formatNpmSummary(line);
    if (summary !== null) {
      result.push(summary);
      changed = true;
      continue;
    }
    const funding = /^(\d+) packages? (?:is|are) looking for funding$/u.exec(line);
    if (funding !== null && /^run `npm fund` for details$/u.test(lines[index + 1]?.trim() ?? "")) {
      result.push(`funding ${funding[1]}: npm fund`);
      index += 1;
      changed = true;
      continue;
    }
    const vulnerability = /^found (\d+) vulnerabilities?$/u.exec(line);
    if (vulnerability !== null) {
      result.push(`vulnerabilities ${vulnerability[1]}`);
      changed = true;
      continue;
    }
    result.push(line);
  }

  return changed ? shortestText(plain, result.join("\n")) : null;
}

function formatNpmSummary(line: string): string | null {
  const current = /^up to date, audited (\d+) packages? in (\S+)$/u.exec(line);
  if (current !== null) {
    return `up to date; audited ${current[1]}; ${current[2]}`;
  }
  const audit = /(?:,? and )?audited (\d+) packages? in (\S+)$/u.exec(line);
  if (audit === null) {
    return null;
  }
  const prefix = line.slice(0, audit.index).replace(/,\s*$/u, "");
  const operations = [...prefix.matchAll(/(?:^|,\s*)(added|removed|changed) (\d+) packages?/gu)];
  if (
    operations.length === 0 ||
    operations.map((match) => match[0]).join("").length < prefix.length
  ) {
    return null;
  }
  const signs: Readonly<Record<string, string>> = { added: "+", removed: "-", changed: "~" };
  const packages = operations.map((match) => `${signs[match[1] ?? ""]}${match[2]}`).join(" ");
  return `packages ${packages}; audited ${audit[1]}; ${audit[2]}`;
}

function formatPnpmInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  if (!lines.some((line) => /^Done in \S+/u.test(line.trim()))) {
    return null;
  }
  const groups = packageGroups();
  const other: string[] = [];
  let section: PackageGroup | null = null;
  let packages: string | null = null;
  let changed = false;

  for (const source of lines) {
    const line = source.trim();
    if (line.length === 0 || /^Progress:/u.test(line) || /^[+-]{2,}$/u.test(line)) {
      changed = true;
      continue;
    }
    if (/^Done in \S+/u.test(line)) {
      changed = true;
      continue;
    }
    const total = /^Packages:\s*([+-]\d+)$/u.exec(line);
    if (total !== null) {
      packages = `${total[1]} packages`;
      changed = true;
      continue;
    }
    const heading = SECTION_NAMES[line.toLowerCase()];
    if (heading !== undefined) {
      section = heading;
      changed = true;
      continue;
    }
    if (section !== null && /^[+-]\s+\S/u.test(line)) {
      groups[section].push(line.replace(/^([+-])\s+/u, "$1"));
      changed = true;
      continue;
    }
    if (/^Lockfile is up to date, resolution step is skipped$/u.test(line)) {
      other.push("lockfile current; resolution skipped");
      changed = true;
      continue;
    }
    if (line === "Already up to date") {
      other.push("up to date");
      changed = true;
      continue;
    }
    section = null;
    other.push(line);
  }

  const result = [
    ...(packages === null ? [] : [packages]),
    ...installPackageGroupLines(groups),
    ...other,
  ].join("\n");
  return changed && result.length > 0 ? shortestText(plain, result) : null;
}

function formatYarnInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  if (!lines.some((line) => /^Done in \S+\.?$/u.test(line.trim()))) {
    return null;
  }
  const result: string[] = [];
  let changed = false;
  for (const source of lines) {
    const line = source.trim();
    if (
      line.length === 0 ||
      /^yarn (?:add|install|remove|up|upgrade) v\S+$/u.test(line) ||
      /^\[\d+\/\d+\]\s+.+\.\.\.$/u.test(line) ||
      /^Done in \S+\.?$/u.test(line)
    ) {
      changed = true;
      continue;
    }
    if (line === "success Saved lockfile.") {
      result.push("lockfile saved");
      changed = true;
      continue;
    }
    const saved = /^success Saved (\d+) new dependencies\.$/u.exec(line);
    if (saved !== null) {
      result.push(`dependencies +${saved[1]}`);
      changed = true;
      continue;
    }
    if (line === "info Direct dependencies") {
      result.push("direct:");
      changed = true;
      continue;
    }
    if (line === "info All dependencies") {
      result.push("all:");
      changed = true;
      continue;
    }
    const dependency = /^(?:├─|└─)\s*(.+)$/u.exec(line);
    if (dependency !== null) {
      result.push(dependency[1] ?? "");
      changed = true;
      continue;
    }
    result.push(line);
  }
  return changed ? shortestText(plain, result.join("\n")) : null;
}

function formatBunInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const bannerIndex = firstNonblankLine(lines);
  const banner = /^bun (install|add|remove|update) v(\S+) \(([^)]+)\)$/u.exec(
    lines[bannerIndex]?.trim() ?? "",
  );
  const complete = lines.some((line) => /^\d+ packages? installed \[[^\]]+\]$/u.test(line.trim()));
  if (banner === null || !complete) {
    return null;
  }

  const result: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]?.trim() ?? "";
    if (index === bannerIndex) {
      result.push(`bun ${banner[1]} v${banner[2]} (${banner[3]})`);
      continue;
    }
    if (line.length === 0 || line === "Resolving dependencies") {
      continue;
    }
    const resolution = /^Resolved, downloaded and extracted \[(\d+)\]$/u.exec(line);
    if (resolution !== null) {
      result.push(`resolved/downloaded/extracted ${resolution[1]}`);
      continue;
    }
    if (line === "Saved lockfile") {
      result.push("lockfile saved");
      continue;
    }
    const installed = /^(\d+) packages? installed \[([^\]]+)\]$/u.exec(line);
    if (installed !== null) {
      result.push(`installed ${installed[1]} packages [${installed[2]}]`);
      continue;
    }
    result.push(line);
  }

  return shortestText(plain, result.join("\n"));
}

function formatPnpmList(plain: string): string | null {
  const lines = plain.split("\n");
  const groups = packageGroups();
  const result: string[] = [];
  let section: PackageGroup | null = null;
  let changed = false;

  for (const source of lines) {
    const line = source.trim();
    if (line.length === 0 || line.startsWith("Legend:")) {
      changed = true;
      continue;
    }
    const heading = SECTION_NAMES[line.toLowerCase()];
    if (heading !== undefined) {
      section = heading;
      changed = true;
      continue;
    }
    if (section !== null) {
      const dependency = /^(\S+)\s+(\S+)$/u.exec(line);
      if (dependency === null) {
        return null;
      }
      groups[section].push(`${dependency[1]}@${dependency[2]}`);
      changed = true;
      continue;
    }
    if (result.length === 0 && /^\S+@\S+\s+\S+$/u.test(line)) {
      result.push(line);
      continue;
    }
    return null;
  }
  result.push(...packageGroupLines(groups));
  return changed && result.length > 0 ? shortestText(plain, result.join("\n")) : null;
}

function formatDependencyTree(plain: string, yarn: boolean): string | null {
  const lines = plain.split("\n");
  let changed = false;
  const formatted: string[] = [];
  for (const source of lines) {
    const line = source.trimEnd();
    if (yarn && (/^yarn list v\S+$/u.test(line) || /^Done in \S+\.?$/u.test(line))) {
      changed = true;
      continue;
    }
    if (line.length === 0) {
      changed = true;
      continue;
    }
    const tree = line
      .replaceAll("│   ", "  ")
      .replaceAll("│  ", "  ")
      .replace(/(?:├──|└──|├─|└─)\s*/gu, "- ");
    changed ||= tree !== line;
    formatted.push(tree);
  }
  return changed && formatted.some((line) => /^\s*-\s/u.test(line))
    ? shortestText(plain, formatted.join("\n"))
    : null;
}

function packageGroups(): Record<PackageGroup, string[]> {
  return { prod: [], dev: [], optional: [], peer: [] };
}

function packageGroupLines(groups: Readonly<Record<PackageGroup, readonly string[]>>): string[] {
  return (Object.entries(groups) as [PackageGroup, readonly string[]][])
    .filter(([, dependencies]) => dependencies.length > 0)
    .map(([group, dependencies]) => `${group}: ${dependencies.join(", ")}`);
}

function installPackageGroupLines(
  groups: Readonly<Record<PackageGroup, readonly string[]>>,
): string[] {
  return (Object.entries(groups) as [PackageGroup, readonly string[]][])
    .filter(([, dependencies]) => dependencies.length > 0)
    .map(
      ([group, dependencies]) =>
        `${group} ${dependencies.map((dependency) => dependency.replace(/^\+/u, "")).join(", ")}`,
    );
}

function commonCell(rows: readonly (readonly string[])[], index: number): string | null {
  if (index < 0 || rows.length === 0) {
    return null;
  }
  const first = rows[0]?.[index];
  return first !== undefined && rows.every((row) => row[index] === first) ? first : null;
}

function packageType(value: string): string {
  if (value.toLowerCase() === "devdependencies") {
    return "dev ";
  }
  if (value.toLowerCase() === "optionaldependencies") {
    return "optional ";
  }
  return value.toLowerCase() === "dependencies" ? "" : `${value} `;
}

function trimOuterBlankLines(lines: string[]): void {
  while (lines[0]?.trim().length === 0) {
    lines.shift();
  }
  while (lines.at(-1)?.trim().length === 0) {
    lines.pop();
  }
}

function firstNonblankLine(lines: readonly string[], start = 0): number {
  const index = lines.findIndex((line, lineIndex) => lineIndex >= start && line.trim().length > 0);
  return index < 0 ? lines.length : index;
}

function isPythonPackageExecutable(
  executable: PackageExecutable,
): executable is PythonPackageExecutable {
  return (
    executable === "pip" || executable === "pip3" || executable === "uv" || executable === "poetry"
  );
}

function isEcosystemPackageExecutable(
  executable: PackageExecutable,
): executable is EcosystemPackageExecutable {
  return executable === "brew" || executable === "composer" || executable === "bundle";
}
