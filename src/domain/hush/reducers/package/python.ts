import { shortestText, stripAnsi } from "../../text-format.ts";

export type PythonPackageExecutable = "pip" | "pip3" | "uv" | "poetry";

export function formatPythonPackageInstall(
  executable: PythonPackageExecutable,
  text: string,
): string | null {
  switch (executable) {
    case "pip":
    case "pip3":
      return formatPipInstall(text);
    case "uv":
      return formatUvInstall(text);
    case "poetry":
      return formatPoetryInstall(text);
  }
}

export function formatPythonPackageList(
  executable: PythonPackageExecutable,
  text: string,
): string | null {
  return executable === "poetry" ? formatVersionRows(text, false) : formatPipList(text);
}

export function formatPythonPackageOutdated(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = nonblankLines(plain);
  if (lines.length < 3) {
    return null;
  }
  const header = splitColumns(lines[0] ?? "").map((column) => column.toLowerCase());
  if (header[0] !== "package" || !header.includes("latest")) {
    return null;
  }
  const currentIndex = header.indexOf("current") >= 0 ? header.indexOf("current") : 1;
  const latestIndex = header.indexOf("latest");
  const typeIndex = header.indexOf("type");
  const separatorIndex = lines.findIndex((line, index) => index > 0 && /^[-\s]+$/u.test(line));
  const dataLines = separatorIndex >= 0 ? lines.slice(separatorIndex + 1) : lines.slice(1);
  const rows = dataLines.map(splitColumns);
  if (
    rows.length === 0 ||
    rows.some(
      (row) =>
        row[0] === undefined || row[currentIndex] === undefined || row[latestIndex] === undefined,
    )
  ) {
    return null;
  }
  const commonType =
    typeIndex >= 0 && rows.every((row) => row[typeIndex] === rows[0]?.[typeIndex])
      ? rows[0]?.[typeIndex]
      : undefined;
  const result = [
    `current>latest${commonType === undefined ? "" : ` ${commonType}`}`,
    ...rows.map((row) => {
      const type = typeIndex < 0 || commonType !== undefined ? "" : ` ${row[typeIndex]}`;
      return `${row[0]} ${row[currentIndex]}>${row[latestIndex]}${type}`;
    }),
  ].join("\n");
  return shortestText(plain, result);
}

export function formatPythonPackageShow(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const blocks = plain.split(/\n---\s*\n/u);
  const formatted: string[] = [];
  for (const block of blocks) {
    const fields = new Map<string, string>();
    for (const line of block.split("\n")) {
      if (line.trim().length === 0) {
        continue;
      }
      const field = /^([^:]+):\s*(.*)$/u.exec(line);
      if (field === null) {
        return null;
      }
      const key = field[1]?.trim() ?? "";
      if (fields.has(key)) {
        return null;
      }
      fields.set(key, field[2] ?? "");
    }
    const name = fields.get("Name");
    const version = fields.get("Version");
    if (name === undefined || version === undefined) {
      return null;
    }
    fields.delete("Name");
    fields.delete("Version");
    formatted.push(
      [`${name}@${version}`, ...[...fields].map(([key, value]) => `${showKey(key)}=${value}`)].join(
        "\n",
      ),
    );
  }
  return formatted.length === 0 ? null : shortestText(plain, formatted.join("\n---\n"));
}

function formatPipInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const result: string[] = [];
  let changed = false;
  let complete = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (line.length === 0 || isPipProgress(line)) {
      changed = true;
      continue;
    }
    const installed = /^Successfully installed (.+)$/u.exec(line);
    if (installed !== null) {
      result.push(`installed ${installed[1]}`);
      complete = true;
      changed = true;
      continue;
    }
    const uninstalled = /^Successfully uninstalled (.+)$/u.exec(line);
    if (uninstalled !== null) {
      result.push(`uninstalled ${uninstalled[1]}`);
      complete = true;
      changed = true;
      continue;
    }
    const current = /^Requirement already satisfied: (\S+).*\(([^)]+)\)$/u.exec(line);
    if (current !== null) {
      result.push(`current ${current[1]}@${current[2]}`);
      complete = true;
      changed = true;
      continue;
    }
    return null;
  }
  return complete && changed ? shortestText(plain, result.join("\n")) : null;
}

function isPipProgress(line: string): boolean {
  return (
    /^(?:Collecting|Downloading|Using cached|Installing collected packages:|Attempting uninstall:|Found existing installation:|Uninstalling )/u.test(
      line,
    ) || /^[-━█=]+\s*\d+%/u.test(line)
  );
}

function formatUvInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const summary: string[] = [];
  const packages: string[] = [];
  let audited: string | null = null;
  let changed = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (line.length === 0 || /^(?:Downloading|Using cached|Prepared|Preparing)\b/u.test(line)) {
      changed = true;
      continue;
    }
    const resolved = /^Resolved (\d+) packages? in \S+$/u.exec(line);
    if (resolved !== null) {
      summary.push(`resolved ${resolved[1]}`);
      changed = true;
      continue;
    }
    const audit = /^Audited (\d+) packages? in \S+$/u.exec(line);
    if (audit !== null) {
      audited = audit[1] ?? null;
      changed = true;
      continue;
    }
    const operation = /^(Installed|Uninstalled) (\d+) packages? in \S+$/u.exec(line);
    if (operation !== null) {
      summary.push(`${operation[1] === "Installed" ? "+" : "-"}${operation[2]}`);
      changed = true;
      continue;
    }
    const packageLine = /^([+~-])\s+(.+)$/u.exec(line);
    if (packageLine !== null) {
      packages.push(`${packageLine[1]} ${(packageLine[2] ?? "").replace("==", "@")}`);
      changed = true;
      continue;
    }
    return null;
  }
  if (audited !== null && packages.length === 0 && !summary.some((item) => /^[+-]/u.test(item))) {
    const resolved = summary.filter((item) => item.startsWith("resolved "));
    const current = `current ${audited}`;
    const result = resolved.every((item) => item === `resolved ${audited}`)
      ? current
      : [...resolved, current].join("\n");
    return shortestText(plain, result);
  }
  const result = [...summary, ...packages].join("\n");
  return changed && result.length > 0 ? shortestText(plain, result) : null;
}

function formatPoetryInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const result: string[] = [];
  let changed = false;
  let current = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (line.length === 0 || /^Installing dependencies from lock file$/u.test(line)) {
      changed = true;
      continue;
    }
    if (/^(?:No dependencies to install or update|No changes\.)$/u.test(line)) {
      current = true;
      changed = true;
      continue;
    }
    const operations =
      /^Package operations: (\d+) installs?, (\d+) updates?, (\d+) removals?$/u.exec(line);
    if (operations !== null) {
      result.push(`+${operations[1]} ~${operations[2]} -${operations[3]}`);
      changed = true;
      continue;
    }
    if (/^(?:Creating|Using) virtualenv\b/u.test(line) || /^[-•]\s+Downloading\b/u.test(line)) {
      changed = true;
      continue;
    }
    const install = /^[-•]\s+Installing (\S+) \(([^)]+)\)$/u.exec(line);
    if (install !== null) {
      result.push(`+ ${install[1]}@${install[2]}`);
      changed = true;
      continue;
    }
    const update = /^[-•]\s+Updating (\S+) \(([^ ]+) (?:->|=>) ([^)]+)\)$/u.exec(line);
    if (update !== null) {
      result.push(`~ ${update[1]} ${update[2]}>${update[3]}`);
      changed = true;
      continue;
    }
    const remove = /^[-•]\s+Removing (\S+) \(([^)]+)\)$/u.exec(line);
    if (remove !== null) {
      result.push(`- ${remove[1]}@${remove[2]}`);
      changed = true;
      continue;
    }
    if (line === "Writing lock file") {
      result.push("lockfile written");
      changed = true;
      continue;
    }
    return null;
  }
  if (current) {
    result.push(result.length === 0 ? "current" : "dependencies current");
  }
  return changed && result.length > 0 ? shortestText(plain, result.join("\n")) : null;
}

function formatPipList(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = nonblankLines(plain);
  if (lines.length < 3 || !/^Package\s+Version(?:\s+.+)?$/iu.test(lines[0] ?? "")) {
    return null;
  }
  const separatorIndex = lines.findIndex((line, index) => index > 0 && /^[-\s]+$/u.test(line));
  if (separatorIndex < 0) {
    return null;
  }
  const rows = lines
    .slice(separatorIndex + 1)
    .map((line) => /^(\S+)\s+(\S+)(?:\s{2,}(.+))?$/u.exec(line));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  const result = [
    `packages ${rows.length}`,
    ...rows.map((row) => `${row?.[1]}@${row?.[2]}${row?.[3] === undefined ? "" : ` ${row[3]}`}`),
  ].join("\n");
  return shortestText(plain, result);
}

function formatVersionRows(text: string, requireHeader: boolean): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = nonblankLines(plain);
  const data = requireHeader ? lines.slice(1) : lines;
  const rows = data.map((line) => /^(\S+)\s+(\S+)(?:\s{2,}(.+))?$/u.exec(line));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  const result = [
    `packages ${rows.length}`,
    ...rows.map((row) => `${row?.[1]}@${row?.[2]}${row?.[3] === undefined ? "" : ` ${row[3]}`}`),
  ].join("\n");
  return shortestText(plain, result);
}

function splitColumns(line: string): string[] {
  return line.trim().split(/\s{2,}/u);
}

function nonblankLines(text: string): string[] {
  return text.split("\n").filter((line) => line.trim().length > 0);
}

function showKey(key: string): string {
  const aliases: Readonly<Record<string, string>> = {
    "Author-email": "author",
    "Editable project location": "editable",
    "Home-page": "home",
    "Required-by": "required-by",
  };
  return aliases[key] ?? key.toLowerCase();
}
