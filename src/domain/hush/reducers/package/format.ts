/** Dispatch package-manager output to its owning parser. */

import type { PackageExecutable } from "../../invocation/package.ts";
import { compactDuplicateRuns, shortestText, stripAnsi } from "../shared/text.ts";
import {
  type EcosystemPackageExecutable,
  formatEcosystemPackageInstall,
  formatEcosystemPackageList,
  formatEcosystemPackageOutdated,
} from "./ecosystem.ts";
import { formatBunInstall, formatBunScript } from "./javascript/bun.ts";
import { formatNpmInstall, formatNpmList, formatNpmScript } from "./javascript/npm.ts";
import { formatPnpmInstall, formatPnpmList, formatPnpmScript } from "./javascript/pnpm.ts";
import { formatYarnInstall, formatYarnList, formatYarnScript } from "./javascript/yarn.ts";
import {
  formatPythonPackageInstall,
  formatPythonPackageList,
  formatPythonPackageOutdated,
  formatPythonPackageShow,
  type PythonPackageExecutable,
} from "./python.ts";

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
  if (plain.length === 0) return null;
  switch (executable) {
    case "npm":
      return formatNpmList(plain);
    case "pnpm":
      return formatPnpmList(plain);
    case "yarn":
      return formatYarnList(plain);
    default:
      if (isPythonPackageExecutable(executable)) return formatPythonPackageList(executable, plain);
      if (isEcosystemPackageExecutable(executable)) {
        return formatEcosystemPackageList(executable, plain);
      }
      return null;
  }
}

export function formatPackageOutdated(executable: PackageExecutable, text: string): string | null {
  if (isPythonPackageExecutable(executable)) return formatPythonPackageOutdated(text);
  if (isEcosystemPackageExecutable(executable)) {
    return formatEcosystemPackageOutdated(executable, text);
  }
  const plain = stripAnsi(text).trimEnd();
  const lines = plain.split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 2) return null;
  const rows = lines.map((line) => line.trim().split(/\s{2,}/u));
  const header = rows[0];
  const columns = header?.length ?? 0;
  if (columns < 4 || rows.some((row) => row.length !== columns)) return null;
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
  switch (executable) {
    case "npm":
      return formatNpmScript(text);
    case "pnpm":
      return formatPnpmScript(text);
    case "yarn":
      return formatYarnScript(text);
    case "bun":
      return formatBunScript(text);
    default:
      return null;
  }
}

export function formatPackageRunner(text: string): string {
  const plain = stripAnsi(text).trimEnd();
  return shortestText(text, plain, compactDuplicateRuns(plain));
}

function commonCell(rows: readonly (readonly string[])[], index: number): string | null {
  if (index < 0 || rows.length === 0) return null;
  const first = rows[0]?.[index];
  return first !== undefined && rows.every((row) => row[index] === first) ? first : null;
}

function packageType(value: string): string {
  if (value.toLowerCase() === "devdependencies") return "dev ";
  if (value.toLowerCase() === "optionaldependencies") return "optional ";
  return value.toLowerCase() === "dependencies" ? "" : `${value} `;
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
