import { shortestText, stripAnsi } from "../../text-format.ts";

export type EcosystemPackageExecutable = "brew" | "composer" | "bundle";

export function formatEcosystemPackageInstall(
  executable: EcosystemPackageExecutable,
  text: string,
): string | null {
  switch (executable) {
    case "brew":
      return formatBrewInstall(text);
    case "composer":
      return formatComposerInstall(text);
    case "bundle":
      return formatBundleInstall(text);
  }
}

export function formatEcosystemPackageList(
  executable: EcosystemPackageExecutable,
  text: string,
): string | null {
  switch (executable) {
    case "brew":
      return formatBrewList(text);
    case "composer":
      return formatComposerList(text);
    case "bundle":
      return formatBundleList(text);
  }
}

export function formatEcosystemPackageOutdated(
  executable: EcosystemPackageExecutable,
  text: string,
): string | null {
  return executable === "brew" ? formatBrewOutdated(text) : null;
}

function formatBrewInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  const current = /^Warning: (.+) is already installed and up-to-date\.$/u.exec(
    lines[0]?.trim() ?? "",
  );
  if (current !== null) {
    const expectedReinstall = `brew reinstall ${(current[1] ?? "").split(/\s+/u)[0] ?? ""}`;
    const safe = lines.slice(1).every((source) => {
      const line = source.trim();
      return (
        line.length === 0 ||
        /^To reinstall .+, run:$/u.test(line) ||
        line === expectedReinstall ||
        line === `${expectedReinstall}.`
      );
    });
    return safe ? shortestText(plain, `current ${current[1]}`) : null;
  }

  const result: string[] = [];
  let changed = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (line.length === 0 || isBrewProgress(line)) {
      changed = true;
      continue;
    }
    if (/^==> (?:Summary|Upgrading \d+ outdated packages?):?$/u.test(line)) {
      changed = true;
      continue;
    }
    const cellar = /\/(?:Cellar|Caskroom)\/([^/]+)\/([^:]+):\s*(.+)$/u.exec(line);
    if (cellar !== null) {
      result.push(`installed ${cellar[1]}@${cellar[2]}; ${cellar[3]}`);
      changed = true;
      continue;
    }
    const upgrade = /^(\S+)\s+(\S+)\s+(?:->|=>)\s+(\S+)$/u.exec(line);
    if (upgrade !== null) {
      result.push(`upgrade ${upgrade[1]} ${upgrade[2]}>${upgrade[3]}`);
      changed = true;
      continue;
    }
    result.push(line.replace(/^🍺\s*/u, ""));
  }
  return changed && result.length > 0 ? shortestText(plain, result.join("\n")) : null;
}

function isBrewProgress(line: string): boolean {
  return (
    /^==> (?:Fetching|Downloading|Pouring)\b/u.test(line) ||
    /^Already downloaded:/u.test(line) ||
    /^#+\s*\d+(?:\.\d+)?%$/u.test(line)
  );
}

function formatComposerInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n");
  if (lines.some((line) => line.trim() === "Nothing to install, update or remove")) {
    return lines.every(isComposerCurrentLine) ? shortestText(plain, "current") : null;
  }
  const result: string[] = [];
  let changed = false;
  for (const source of plain.split("\n")) {
    const line = source.trim();
    if (
      line.length === 0 ||
      /^(?:Loading composer repositories with package information|Updating dependencies|Installing dependencies from lock file(?: \(including require-dev\))?)$/u.test(
        line,
      ) ||
      /^- Downloading\b/u.test(line)
    ) {
      changed = true;
      continue;
    }
    const operations =
      /^(?:Package|Lock file) operations: (\d+) installs?, (\d+) updates?, (\d+) removals?$/u.exec(
        line,
      );
    if (operations !== null) {
      result.push(`+${operations[1]} ~${operations[2]} -${operations[3]}`);
      changed = true;
      continue;
    }
    const install = /^- Installing (\S+) \(([^)]+)\)(?::.*)?$/u.exec(line);
    if (install !== null) {
      result.push(`+ ${install[1]}@${install[2]}`);
      changed = true;
      continue;
    }
    const update = /^- Upgrading (\S+) \(([^ ]+) (?:=>|->) ([^)]+)\)(?::.*)?$/u.exec(line);
    if (update !== null) {
      result.push(`~ ${update[1]} ${update[2]}>${update[3]}`);
      changed = true;
      continue;
    }
    const remove = /^- Removing (\S+) \(([^)]+)\)$/u.exec(line);
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
    if (line === "Generating optimized autoload files") {
      result.push("autoload optimized");
      changed = true;
      continue;
    }
    if (line === "Generating autoload files") {
      result.push("autoload generated");
      changed = true;
      continue;
    }
    const funding = /^(\d+) packages? you are using (?:is|are) looking for funding\.$/u.exec(line);
    if (funding !== null) {
      result.push(`funding ${funding[1]}: composer fund`);
      changed = true;
      continue;
    }
    if (line === "Use the `composer fund` command to find out more!") {
      changed = true;
      continue;
    }
    return null;
  }
  return changed && result.length > 0 ? shortestText(plain, result.join("\n")) : null;
}

function formatBundleInstall(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const complete = /Bundle complete! (\d+) Gemfile dependencies, (\d+) gems now installed\./u.exec(
    plain,
  );
  if (complete !== null) {
    return plain.split("\n").every(isBundleInstallLine)
      ? shortestText(plain, `complete ${complete[1]}/${complete[2]}`)
      : null;
  }
  if (/Bundle updated!/u.test(plain)) {
    return plain.split("\n").every(isBundleInstallLine) ? shortestText(plain, "updated") : null;
  }
  return null;
}

function isComposerCurrentLine(source: string): boolean {
  const line = source.trim();
  return (
    line.length === 0 ||
    /^(?:Loading composer repositories with package information|Updating dependencies|Installing dependencies from lock file(?: \(including require-dev\))?)$/u.test(
      line,
    ) ||
    /^(?:Package|Lock file) operations: 0 installs, 0 updates, 0 removals$/u.test(line) ||
    line === "Nothing to install, update or remove" ||
    line === "Generating autoload files" ||
    line === "Generating optimized autoload files" ||
    /^\d+ packages? you are using (?:is|are) looking for funding\.$/u.test(line) ||
    line === "Use the `composer fund` command to find out more!"
  );
}

function isBundleInstallLine(source: string): boolean {
  const line = source.trim();
  return (
    line.length === 0 ||
    /^(?:Using|Fetching|Installing) \S+ .+$/u.test(line) ||
    /^Fetching gem metadata\b/u.test(line) ||
    /^Resolving dependencies/u.test(line) ||
    /^Bundle (?:complete! \d+ Gemfile dependencies, \d+ gems now installed\.|updated!)$/u.test(
      line,
    ) ||
    /^Use `bundle info \[gemname\]` to see where a bundled gem is installed\.$/u.test(line) ||
    /^Bundled gems are installed into /u.test(line)
  );
}

function formatBrewList(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const rows = plain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => /^(\S+)\s+(\S+(?:\s+\S+)*)$/u.exec(line.trim()));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  const result = rows
    .map((row) => `${row?.[1]}@${(row?.[2] ?? "").split(/\s+/u).join(",")}`)
    .join("\n");
  return shortestText(plain, result);
}

function formatComposerList(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const rows = plain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => /^(\S+)\s+(\S+)(?:\s{2,}(.+))?$/u.exec(line.trim()));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  const result = [
    `packages ${rows.length}`,
    ...rows.map((row) => `${row?.[1]}@${row?.[2]}${row?.[3] === undefined ? "" : ` ${row[3]}`}`),
  ].join("\n");
  return shortestText(plain, result);
}

function formatBundleList(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  if (lines.shift()?.trim() !== "Gems included by the bundle:") {
    return null;
  }
  const hint = lines.at(-1);
  if (hint?.startsWith("Use `bundle info") === true) {
    lines.pop();
  }
  const rows = lines.map((line) => /^\s*\*\s+(\S+) \(([^)]+)\)$/u.exec(line));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  const result = [`gems ${rows.length}`, ...rows.map((row) => `${row?.[1]}@${row?.[2]}`)].join(
    "\n",
  );
  return shortestText(plain, result);
}

function formatBrewOutdated(text: string): string | null {
  const plain = stripAnsi(text).trimEnd();
  const rows = plain
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => /^(\S+)\s+\(([^)]+)\)\s+<\s+(\S+)$/u.exec(line.trim()));
  if (rows.length === 0 || rows.some((row) => row === null)) {
    return null;
  }
  return shortestText(plain, rows.map((row) => `${row?.[1]} ${row?.[2]}>${row?.[3]}`).join("\n"));
}
